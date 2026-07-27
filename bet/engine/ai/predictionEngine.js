/**
 * @file predictionEngine.js
 * @module engine/predictionEngine
 *
 * @description
 * The Prediction Engine is the orchestration layer that ties the entire
 * pipeline together:
 *
 *   fetch data -> normalize/merge -> build prompt -> call AI -> parse -> return
 *
 * This module owns the WORKFLOW, and nothing else:
 *
 *  - It does NOT contain HTTP logic. All network calls live inside the
 *    provider modules (apiFootball, footballOdds, newsdata, newsapi,
 *    tavily, gemini, openrouter).
 *  - It does NOT contain prompt-building logic. That lives entirely in
 *    `engine/prompts/predictionPrompt.js`.
 *  - It DOES decide which providers to call, how to merge their results,
 *    which AI provider to use, how to recover from partial failures, and
 *    how to shape the final structured prediction object.
 *
 * IMPORTANT: several provider method names referenced below (marked with
 * `TODO`) are assumed based on each provider's documented responsibilities
 * and have not been confirmed against the real provider implementations
 * yet. Wiring them up is the last step before this module is fully live —
 * everything else (control flow, error handling, response shape) is final.
 *
 * @author Zorex Engineering
 */

'use strict';

const { buildPredictionPrompt } = require('./prompts/predictionPrompt');

// TODO: confirm these are the correct relative paths once the provider
// folder structure is finalized. Assumed layout: providers/ sits alongside
// engine/ at the project root.
const apiFootball = require('../providers/apiFootball');
const footballOdds = require('../providers/footballOdds');
const newsdata = require('../providers/newsdata');
const newsapi = require('../providers/newsapi');
const tavily = require('../providers/tavily');
const gemini = require('../providers/gemini');
const openrouter = require('../providers/openrouter');

/* -------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Default engine configuration. Callers can override any subset via the
 * `options` parameter on {@link predictMatch}.
 *
 * @type {EngineOptions}
 */
const DEFAULT_ENGINE_OPTIONS = {
  /** Which AI provider to try first. */
  primaryAIProvider: 'gemini',
  /** Which AI provider to fall back to if the primary fails or is invalid. */
  fallbackAIProvider: 'openrouter',
  /** Search query used against tavily/news providers, defaults to "<home> vs <away>". */
  newsQuery: null,
  /** Whether a single failed data source should abort the whole prediction. */
  requireAllSources: false,
  /** Options forwarded as-is to buildPredictionPrompt. */
  promptOptions: {},
};

/**
 * The markdown section headings the prompt asks the AI to produce. Kept in
 * sync with `predictionPrompt.js`'s OUTPUT_SECTIONS so the response parser
 * knows what to look for. If the prompt's output contract changes, update
 * both places.
 *
 * @type {string[]}
 */
const EXPECTED_RESPONSE_SECTIONS = [
  'Match Overview',
  'Recent Form',
  'Head-to-Head',
  'Key Injuries',
  'Tactical Analysis',
  'Odds Analysis',
  'Important News',
  'Risk Factors',
  'Predicted Outcome',
  'Confidence',
  'Recommended Bets',
  'Final Summary',
];

/* -------------------------------------------------------------------------- */
/*  Custom error types                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Base error type for all failures raised by the prediction engine.
 * Consumers (e.g. the WhatsApp bot layer) can catch this specifically to
 * distinguish orchestration failures from unrelated bugs.
 */
class PredictionEngineError extends Error {
  /**
   * @param {string} message
   * @param {{cause?: unknown, stage?: string}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'PredictionEngineError';
    this.stage = meta.stage || 'unknown';
    if (meta.cause) this.cause = meta.cause;
  }
}

/**
 * Raised specifically when every configured AI provider fails to return a
 * usable response.
 */
class AIProviderError extends PredictionEngineError {
  constructor(message, meta = {}) {
    super(message, { ...meta, stage: 'ai-request' });
    this.name = 'AIProviderError';
  }
}

/**
 * Raised when the AI response cannot be parsed into the expected structure.
 */
class ResponseParseError extends PredictionEngineError {
  constructor(message, meta = {}) {
    super(message, { ...meta, stage: 'response-parsing' });
    this.name = 'ResponseParseError';
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Runs the full prediction pipeline for a single fixture and returns a
 * structured prediction object.
 *
 * This is the single entry point the rest of the application (e.g. Zorex
 * Bot's `.predict` command) should call. Everything else in this file is a
 * private implementation detail.
 *
 * @param {MatchIdentifier} matchIdentifier - Identifies which fixture to predict.
 *   Shape TBD against apiFootball's real interface — for now assumed to be
 *   either a `fixtureId` or a `{ homeTeam, awayTeam, date }` lookup triple.
 * @param {EngineOptions} [options={}] - Overrides for {@link DEFAULT_ENGINE_OPTIONS}.
 *
 * @returns {Promise<PredictionResult>} The final structured prediction.
 *
 * @throws {PredictionEngineError} If data fetching fails entirely, if no AI
 *   provider can be reached, or if the AI response cannot be parsed.
 *
 * @example
 * const prediction = await predictMatch({ fixtureId: 12345 });
 */
async function predictMatch(matchIdentifier, options = {}) {
  assertMatchIdentifier(matchIdentifier);
  const opts = mergeOptions(DEFAULT_ENGINE_OPTIONS, options);

  // Step 1: fetch all required data from providers, independently.
  const rawResults = await fetchMatchData(matchIdentifier, opts);

  // Step 2: normalize + merge into a single MatchContext object.
  const matchContext = normalizeAndMergeData(rawResults, matchIdentifier);

  // Step 3: build the prediction prompt (delegated entirely to the Prompt Engine).
  const prompt = buildPredictionPrompt(matchContext, opts.promptOptions);

  // Step 4: send the prompt to the configured AI provider, with fallback.
  const aiResponse = await requestAIPrediction(prompt, opts);

  // Step 5: parse and validate the AI's raw text response.
  const parsed = parseAIResponse(aiResponse.text);

  // Step 6: assemble and return the final structured result.
  return assemblePredictionResult({
    matchIdentifier,
    matchContext,
    prompt,
    aiResponse,
    parsed,
    rawResults,
  });
}

/* -------------------------------------------------------------------------- */
/*  Step 1 — Data fetching                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Fetches all data required for a prediction from every relevant provider,
 * in parallel. Each source is fetched independently via `Promise.allSettled`
 * so that one slow or failing provider (e.g. news being down) doesn't
 * necessarily block the whole prediction — see `opts.requireAllSources` to
 * change that behavior.
 *
 * @param {MatchIdentifier} matchIdentifier
 * @param {EngineOptions} opts
 * @returns {Promise<RawProviderResults>}
 * @throws {PredictionEngineError} If `requireAllSources` is true and any
 *   source failed, or if every source failed regardless of that setting.
 */
async function fetchMatchData(matchIdentifier, opts) {
  const newsQuery = opts.newsQuery || buildDefaultNewsQuery(matchIdentifier);

  // TODO: confirm exact method names/signatures against each provider's
  // real implementation. These calls assume each provider follows the
  // "one method per data type" convention described in the provider layer.
  const sourceCalls = {
    fixture: () => apiFootball.getFixture(matchIdentifier),
    standings: () => apiFootball.getStandings(matchIdentifier),
    form: () => apiFootball.getForm(matchIdentifier),
    h2h: () => apiFootball.getH2H(matchIdentifier),
    injuries: () => apiFootball.getInjuries(matchIdentifier),
    statistics: () => apiFootball.getStatistics(matchIdentifier),
    thirdPartyPredictions: () => apiFootball.getPredictions(matchIdentifier),
    odds: () => footballOdds.getOdds(matchIdentifier),
    newsFromNewsData: () => newsdata.getSportsNews(newsQuery),
    newsFromNewsAPI: () => newsapi.getEverything(newsQuery),
    webContext: () => tavily.search(newsQuery),
  };

  const sourceNames = Object.keys(sourceCalls);
  const settled = await Promise.allSettled(sourceNames.map((name) => sourceCalls[name]()));

  /** @type {RawProviderResults} */
  const results = { data: {}, errors: {} };

  settled.forEach((outcome, idx) => {
    const name = sourceNames[idx];
    if (outcome.status === 'fulfilled') {
      results.data[name] = outcome.value;
    } else {
      results.errors[name] = outcome.reason;
    }
  });

  const failedSources = Object.keys(results.errors);
  const allFailed = failedSources.length === sourceNames.length;

  if (allFailed) {
    throw new PredictionEngineError(
      'All data providers failed — cannot build a prediction without any source data.',
      { stage: 'data-fetch', cause: results.errors }
    );
  }

  if (opts.requireAllSources && failedSources.length > 0) {
    throw new PredictionEngineError(
      `requireAllSources is true but the following sources failed: ${failedSources.join(', ')}`,
      { stage: 'data-fetch', cause: results.errors }
    );
  }

  return results;
}

/**
 * Builds a reasonable default search query for news/web-search providers
 * when the caller doesn't supply one explicitly.
 *
 * @param {MatchIdentifier} matchIdentifier
 * @returns {string}
 */
function buildDefaultNewsQuery(matchIdentifier) {
  if (matchIdentifier.homeTeam && matchIdentifier.awayTeam) {
    return `${matchIdentifier.homeTeam} vs ${matchIdentifier.awayTeam}`;
  }
  // TODO: once fixture lookups are wired, resolve team names from
  // matchIdentifier.fixtureId before falling back to this generic query.
  return 'football match preview';
}

/* -------------------------------------------------------------------------- */
/*  Step 2 — Normalization / merge                                            */
/* -------------------------------------------------------------------------- */

/**
 * Normalizes and merges raw provider results into a single MatchContext
 * object matching the shape expected by `buildPredictionPrompt()`.
 *
 * This function is defensive by design: any missing or failed source simply
 * results in that field being omitted from the MatchContext rather than
 * throwing, since `predictionPrompt.js` already handles missing fields
 * gracefully.
 *
 * @param {RawProviderResults} rawResults
 * @param {MatchIdentifier} matchIdentifier
 * @returns {import('./prompts/predictionPrompt').MatchContext}
 */
function normalizeAndMergeData(rawResults, matchIdentifier) {
  const { data } = rawResults;

  // TODO: the field mappings below assume each provider already returns
  // normalized shapes matching predictionPrompt's typedefs (FixtureInfo,
  // OddsInfo, etc.), per the provider layer's stated responsibility to
  // "normalize data" before returning. If real provider output differs,
  // this is the one place that needs adjusting — predictionPrompt.js and
  // predictMatch() itself should not need to change.

  return {
    fixture: data.fixture?.fixture ?? data.fixture ?? undefined,
    league: data.fixture?.league ?? undefined,
    venue: data.fixture?.venue ?? undefined,
    standings: data.standings ?? undefined,
    form: data.form ?? undefined,
    h2h: data.h2h ?? undefined,
    injuries: data.injuries ?? undefined,
    statistics: data.statistics ?? undefined,
    odds: data.odds ?? undefined,
    news: mergeNewsSources(data.newsFromNewsData, data.newsFromNewsAPI, data.webContext),
    weather: data.fixture?.weather ?? undefined,
    predictions: data.thirdPartyPredictions ?? undefined,
  };
}

/**
 * Merges news items from multiple sources (newsdata, newsapi, tavily) into
 * a single de-duplicated list, tagging each item with its origin so the
 * prompt/analysis can reason about source diversity if needed later.
 *
 * @param {unknown} newsDataResult
 * @param {unknown} newsApiResult
 * @param {unknown} tavilyResult
 * @returns {Array<{title: string, source?: string, summary?: string}>}
 */
function mergeNewsSources(newsDataResult, newsApiResult, tavilyResult) {
  // TODO: replace with real field extraction once provider response shapes
  // are confirmed. For now this assumes each provider returns an array of
  // items with at least a `title`, and optionally `source`/`summary`.
  const buckets = [newsDataResult, newsApiResult, tavilyResult].filter(Array.isArray);
  const merged = buckets.flat();

  const seenTitles = new Set();
  const deduped = [];
  for (const item of merged) {
    const title = item?.title;
    if (!title || seenTitles.has(title)) continue;
    seenTitles.add(title);
    deduped.push(item);
  }

  return deduped;
}

/* -------------------------------------------------------------------------- */
/*  Step 4 — AI request with fallback                                         */
/* -------------------------------------------------------------------------- */

/**
 * Registry mapping provider names to their orchestration-level call
 * function. Keeping this as a lookup table (rather than an if/else chain)
 * makes it trivial to add a third AI provider later.
 *
 * @type {Record<string, (prompt: string) => Promise<{text: string, raw: unknown}>>}
 */
const AI_PROVIDER_CALLS = {
  // TODO: confirm real method signatures for gemini.js / openrouter.js.
  gemini: async (prompt) => {
    const raw = await gemini.generateContent(prompt);
    return { text: extractTextFromAIResult(raw), raw };
  },
  openrouter: async (prompt) => {
    const raw = await openrouter.chatCompletion(prompt);
    return { text: extractTextFromAIResult(raw), raw };
  },
};

/**
 * Best-effort extraction of plain text from an AI provider's raw response,
 * tolerant of slightly different response shapes between providers.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function extractTextFromAIResult(raw) {
  // TODO: adjust once real Gemini/OpenRouter response shapes are confirmed.
  if (typeof raw === 'string') return raw;
  if (raw?.text) return raw.text;
  if (raw?.content) return raw.content;
  if (raw?.choices?.[0]?.message?.content) return raw.choices[0].message.content;
  throw new AIProviderError('Could not extract text from AI provider response — unrecognized shape.');
}

/**
 * Sends the prompt to the configured primary AI provider, falling back to
 * the secondary provider if the primary fails or returns something
 * unusable.
 *
 * @param {string} prompt
 * @param {EngineOptions} opts
 * @returns {Promise<{provider: string, text: string, raw: unknown}>}
 * @throws {AIProviderError} If both providers fail.
 */
async function requestAIPrediction(prompt, opts) {
  const attemptOrder = [opts.primaryAIProvider, opts.fallbackAIProvider].filter(
    (name, idx, arr) => name && arr.indexOf(name) === idx
  );

  /** @type {Error[]} */
  const failures = [];

  for (const providerName of attemptOrder) {
    const call = AI_PROVIDER_CALLS[providerName];
    if (!call) {
      failures.push(new AIProviderError(`Unknown AI provider configured: "${providerName}".`));
      continue;
    }

    try {
      const result = await call(prompt);
      if (!result.text || !result.text.trim()) {
        throw new AIProviderError(`AI provider "${providerName}" returned an empty response.`);
      }
      return { provider: providerName, ...result };
    } catch (err) {
      failures.push(err instanceof Error ? err : new Error(String(err)));
    }
  }

  throw new AIProviderError(
    `All configured AI providers failed (${attemptOrder.join(', ')}).`,
    { cause: failures }
  );
}

/* -------------------------------------------------------------------------- */
/*  Step 5 — Response parsing / validation                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parses the AI's raw markdown response into a structured object keyed by
 * section name, and extracts a few high-value fields (confidence,
 * predicted outcome) for convenient programmatic access.
 *
 * @param {string} text - Raw markdown text returned by the AI provider.
 * @returns {ParsedAIResponse}
 * @throws {ResponseParseError} If the response is missing too many expected
 *   sections to be considered usable.
 */
function parseAIResponse(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ResponseParseError('AI response text is empty or not a string.');
  }

  const sections = extractMarkdownSections(text);

  const missingSections = EXPECTED_RESPONSE_SECTIONS.filter((name) => !sections[name]);
  // Allow a small margin — the AI occasionally renames or merges a minor
  // section — but if more than a third of the expected sections are
  // missing, treat the response as unusable rather than silently returning
  // a mostly-empty prediction.
  if (missingSections.length > Math.floor(EXPECTED_RESPONSE_SECTIONS.length / 3)) {
    throw new ResponseParseError(
      `AI response is missing too many expected sections: ${missingSections.join(', ')}`,
      { cause: { sections } }
    );
  }

  return {
    sections,
    confidence: extractConfidence(sections['Confidence']),
    predictedOutcome: sections['Predicted Outcome']?.trim() || null,
    recommendedBets: sections['Recommended Bets']?.trim() || null,
    missingSections,
  };
}

/**
 * Splits a markdown response into a map of section name -> section body,
 * based on `## Heading` markers matching {@link EXPECTED_RESPONSE_SECTIONS}.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
function extractMarkdownSections(text) {
  /** @type {Record<string, string>} */
  const sections = {};

  // Matches "## Heading Name" at the start of a line, capturing everything
  // up to the next "## " heading or end of string.
  const headingPattern = /^##\s+(.+?)\s*$/gm;
  const matches = [...text.matchAll(headingPattern)];

  for (let i = 0; i < matches.length; i += 1) {
    const heading = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    sections[heading] = text.slice(start, end).trim();
  }

  return sections;
}

/**
 * Extracts a numeric confidence percentage from the "Confidence" section's
 * text, tolerant of formats like "91%", "Confidence: 91%", "around 90-95%".
 *
 * @param {string|undefined} confidenceText
 * @returns {number|null} A number 0-100, or null if none could be parsed.
 */
function extractConfidence(confidenceText) {
  if (!confidenceText) return null;
  const match = confidenceText.match(/(\d{1,3})\s*%/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/* -------------------------------------------------------------------------- */
/*  Step 6 — Final assembly                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Assembles the final structured prediction object returned to callers,
 * combining the parsed AI response with metadata about how the prediction
 * was produced (useful for debugging, logging, and the WhatsApp bot's
 * "Sources" footer).
 *
 * @param {{
 *   matchIdentifier: MatchIdentifier,
 *   matchContext: import('./prompts/predictionPrompt').MatchContext,
 *   prompt: string,
 *   aiResponse: {provider: string, text: string, raw: unknown},
 *   parsed: ParsedAIResponse,
 *   rawResults: RawProviderResults,
 * }} input
 * @returns {PredictionResult}
 */
function assemblePredictionResult({ matchIdentifier, matchContext, prompt, aiResponse, parsed, rawResults }) {
  return {
    match: {
      homeTeam: matchContext.fixture?.homeTeam ?? matchIdentifier.homeTeam ?? null,
      awayTeam: matchContext.fixture?.awayTeam ?? matchIdentifier.awayTeam ?? null,
      date: matchContext.fixture?.date ?? matchIdentifier.date ?? null,
      competition: matchContext.league?.name ?? null,
    },
    predictedOutcome: parsed.predictedOutcome,
    confidence: parsed.confidence,
    recommendedBets: parsed.recommendedBets,
    sections: parsed.sections,
    meta: {
      aiProvider: aiResponse.provider,
      sourcesUsed: Object.keys(rawResults.data),
      sourcesFailed: Object.keys(rawResults.errors),
      missingResponseSections: parsed.missingSections,
      generatedAt: new Date().toISOString(),
    },
    // Included for debugging/auditing; downstream formatters (e.g. the
    // WhatsApp Output Formatter) are expected to use `sections` /
    // `predictedOutcome` / `confidence` rather than re-parsing this.
    debug: {
      prompt,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Validation / utility helpers                                              */
/* -------------------------------------------------------------------------- */

/**
 * Validates that a match identifier was provided in a usable shape.
 *
 * @param {unknown} matchIdentifier
 * @returns {void}
 * @throws {TypeError}
 */
function assertMatchIdentifier(matchIdentifier) {
  if (matchIdentifier === null || typeof matchIdentifier !== 'object' || Array.isArray(matchIdentifier)) {
    throw new TypeError('predictMatch: "matchIdentifier" must be a plain object.');
  }
  const hasFixtureId = matchIdentifier.fixtureId != null;
  const hasTeamPair = matchIdentifier.homeTeam && matchIdentifier.awayTeam;
  if (!hasFixtureId && !hasTeamPair) {
    throw new TypeError(
      'predictMatch: "matchIdentifier" must include either a fixtureId or both homeTeam and awayTeam.'
    );
  }
}

/**
 * Shallow-merges user-supplied options over the defaults, one level deep
 * (sufficient for this engine's flat option shape).
 *
 * @param {EngineOptions} defaults
 * @param {Partial<EngineOptions>} overrides
 * @returns {EngineOptions}
 */
function mergeOptions(defaults, overrides) {
  return { ...defaults, ...overrides, promptOptions: { ...defaults.promptOptions, ...overrides.promptOptions } };
}

/* -------------------------------------------------------------------------- */
/*  Type definitions (JSDoc only)                                             */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} MatchIdentifier
 * @property {number|string} [fixtureId]
 * @property {string} [homeTeam]
 * @property {string} [awayTeam]
 * @property {string} [date]
 */

/**
 * @typedef {Object} EngineOptions
 * @property {string} [primaryAIProvider]
 * @property {string} [fallbackAIProvider]
 * @property {string|null} [newsQuery]
 * @property {boolean} [requireAllSources]
 * @property {import('./prompts/predictionPrompt').PromptOptions} [promptOptions]
 */

/**
 * @typedef {Object} RawProviderResults
 * @property {Record<string, unknown>} data
 * @property {Record<string, unknown>} errors
 */

/**
 * @typedef {Object} ParsedAIResponse
 * @property {Record<string, string>} sections
 * @property {number|null} confidence
 * @property {string|null} predictedOutcome
 * @property {string|null} recommendedBets
 * @property {string[]} missingSections
 */

/**
 * @typedef {Object} PredictionResult
 * @property {{homeTeam: string|null, awayTeam: string|null, date: string|null, competition: string|null}} match
 * @property {string|null} predictedOutcome
 * @property {number|null} confidence
 * @property {string|null} recommendedBets
 * @property {Record<string, string>} sections
 * @property {{aiProvider: string, sourcesUsed: string[], sourcesFailed: string[], missingResponseSections: string[], generatedAt: string}} meta
 * @property {{prompt: string}} debug
 */

/* -------------------------------------------------------------------------- */
/*  Exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  predictMatch,
  PredictionEngineError,
  AIProviderError,
  ResponseParseError,
};
