/**
 * @file predictMatch.js
 * @module engine/ai/predictMatch
 *
 * @description
 * The main AI orchestration layer for the Zorex Football Betting Engine.
 *
 * This module coordinates exactly four things, in order:
 *
 *   1. Resolve a match context — either fetch it fresh from the provider
 *      layer (given a fixture ID or team lookup) or accept an already-built
 *      MatchContext directly.
 *   2. Pass that MatchContext into `buildPredictionPrompt()`.
 *   3. Send the resulting prompt to an AI provider via `aiProviders.js`.
 *   4. Return the AI-generated prediction.
 *
 * What this module deliberately does NOT do:
 *
 *   - No betting logic (accumulators, safe/value bet classification, etc).
 *   - No bankroll management or stake sizing.
 *   - No recommendation scoring, EV calculation, or Kelly Criterion — that
 *     belongs to the future Betting Engine, which should consume this
 *     module's output rather than duplicate its work.
 *   - No provider-specific AI request logic — that lives in `aiProviders.js`,
 *     which this module treats as a black box.
 *   - No prompt construction — that lives entirely in
 *     `engine/prompts/predictionPrompt.js`.
 *
 * This keeps `predictMatch()` a thin, readable coordinator: fetch, build,
 * call, return. Everything provider-specific — whether that's a football
 * data provider or an AI provider — is delegated elsewhere, so this file
 * doesn't need to change when a provider's internals change.
 *
 * @author Zorex Engineering
 */

'use strict';

const { buildPredictionPrompt } = require('../prompts/predictionPrompt');
const { generatePrediction } = require('./aiProviders');

// TODO: confirm these are the correct relative paths once the provider
// folder structure is finalized. Assumed layout: providers/ sits alongside
// engine/ at the project root (engine/ai/predictMatch.js -> ../../providers/*).
const apiFootball = require('../../providers/apiFootball');
const footballOdds = require('../../providers/footballOdds');
const newsdata = require('../../providers/newsdata');
const newsapi = require('../../providers/newsapi');
const tavily = require('../../providers/tavily');

/* -------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Default options for {@link predictMatch}. Callers may override any subset.
 *
 * @type {PredictMatchOptions}
 */
const DEFAULT_OPTIONS = {
  /** Order in which AI providers are attempted; passed straight through to aiProviders.js. */
  aiAttemptOrder: ['gemini', 'openrouter'],
  /** Options forwarded as-is to buildPredictionPrompt. */
  promptOptions: {},
  /** Options forwarded as-is to the AI provider adapter (model name, temperature, etc). */
  aiProviderOptions: {},
  /** If a data source fails while fetching, should the whole prediction abort? */
  requireAllSources: false,
  /** Custom search query for news/web-search providers; defaults to "<home> vs <away>". */
  newsQuery: null,
};

/* -------------------------------------------------------------------------- */
/*  Error types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Raised for any orchestration-level failure in `predictMatch()` — invalid
 * input, total data-fetch failure, or an AI request that never succeeded.
 * Wraps the more specific underlying error (from `aiProviders.js` or a
 * provider module) via the standard `.cause` property.
 */
class PredictMatchError extends Error {
  /**
   * @param {string} message
   * @param {{cause?: unknown, stage?: string}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'PredictMatchError';
    this.stage = meta.stage || 'unknown';
    if (meta.cause) this.cause = meta.cause;
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Runs fixture data gathering (if needed), prompt building, and the AI
 * request, returning the AI-generated prediction. This is the module's only
 * intended entry point.
 *
 * @param {number|string|MatchIdentifier|import('../prompts/predictionPrompt').MatchContext} input -
 *   One of three things:
 *     - A fixture ID (number or string) to look up via the provider layer.
 *     - A `{ homeTeam, awayTeam, date? }` identifier to look up via the provider layer.
 *     - An already-normalized MatchContext object (detected by the presence
 *       of a `fixture` key) — in which case no data fetching happens at all
 *       and the object is passed straight to the Prompt Engine.
 * @param {PredictMatchOptions} [options={}] - Overrides for {@link DEFAULT_OPTIONS}.
 *
 * @returns {Promise<AIPrediction>} The AI-generated prediction.
 *
 * @throws {PredictMatchError} If the input is invalid, if data fetching
 *   fails entirely, or if no AI provider could produce a response.
 *
 * @example
 * // By fixture ID:
 * const prediction = await predictMatch(12345);
 *
 * @example
 * // By team names:
 * const prediction = await predictMatch({ homeTeam: 'Liverpool', awayTeam: 'Arsenal' });
 *
 * @example
 * // With an already-built match context (skips data fetching entirely):
 * const prediction = await predictMatch(existingMatchContext);
 */
async function predictMatch(input, options = {}) {
  const opts = mergeOptions(DEFAULT_OPTIONS, options);

  // Step 1: resolve the match context, fetching from providers only if needed.
  const matchContext = await resolveMatchContext(input, opts);

  // Step 2: build the prompt. All prompt logic is delegated to the Prompt Engine.
  const prompt = buildPredictionPrompt(matchContext, opts.promptOptions);

  // Step 3: send the prompt to an AI provider. All provider-specific request
  // logic is delegated to aiProviders.js.
  let aiResult;
  try {
    aiResult = await generatePrediction(prompt, {
      attemptOrder: opts.aiAttemptOrder,
      providerOptions: opts.aiProviderOptions,
    });
  } catch (err) {
    throw new PredictMatchError('AI prediction request failed for every configured provider.', {
      stage: 'ai-request',
      cause: err,
    });
  }

  // Step 4: return the AI-generated prediction. No parsing beyond exposing
  // the raw text and basic metadata — structuring/scoring the content into
  // betting recommendations is explicitly out of scope for this module.
  return {
    match: describeMatch(input, matchContext),
    provider: aiResult.provider,
    text: aiResult.text,
    prompt,
    raw: aiResult.raw,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/*  Match context resolution                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the MatchContext to feed into the Prompt Engine. If `input` is
 * already a MatchContext (has a `fixture` key), it's used as-is with no
 * network calls. Otherwise, `input` is treated as a fixture lookup and the
 * required data is fetched from the provider layer.
 *
 * @param {number|string|MatchIdentifier|import('../prompts/predictionPrompt').MatchContext} input
 * @param {PredictMatchOptions} opts
 * @returns {Promise<import('../prompts/predictionPrompt').MatchContext>}
 * @throws {PredictMatchError}
 */
async function resolveMatchContext(input, opts) {
  assertValidInput(input);

  if (isAlreadyMatchContext(input)) {
    return input;
  }

  const identifier = normalizeIdentifier(input);
  const rawResults = await fetchMatchData(identifier, opts);
  return normalizeAndMergeData(rawResults);
}

/**
 * Determines whether `input` looks like an already-built MatchContext
 * (as opposed to a fixture lookup identifier). A MatchContext is
 * distinguished by having a `fixture` object with team names on it;
 * a raw identifier has `homeTeam`/`awayTeam`/`fixtureId` at the top level.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
function isAlreadyMatchContext(input) {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    typeof input.fixture === 'object' &&
    input.fixture !== null
  );
}

/**
 * Normalizes accepted input shapes (fixture ID, or `{homeTeam, awayTeam}`)
 * into a single MatchIdentifier shape used internally for provider calls.
 *
 * @param {number|string|MatchIdentifier} input
 * @returns {MatchIdentifier}
 */
function normalizeIdentifier(input) {
  if (typeof input === 'number' || typeof input === 'string') {
    return { fixtureId: input };
  }
  return input;
}

/* -------------------------------------------------------------------------- */
/*  Data fetching (provider layer)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Fetches all data required for a prediction from every relevant provider,
 * in parallel, tolerating individual source failures.
 *
 * @param {MatchIdentifier} identifier
 * @param {PredictMatchOptions} opts
 * @returns {Promise<RawProviderResults>}
 * @throws {PredictMatchError} If every source fails, or if `requireAllSources`
 *   is true and any source fails.
 */
async function fetchMatchData(identifier, opts) {
  const newsQuery = opts.newsQuery || buildDefaultNewsQuery(identifier);

  // TODO: confirm exact method names/signatures against each provider's real
  // implementation — assumed here to follow a "one method per data type"
  // convention consistent with the provider layer's documented responsibilities.
  const sourceCalls = {
    fixture: () => apiFootball.getFixture(identifier),
    standings: () => apiFootball.getStandings(identifier),
    form: () => apiFootball.getForm(identifier),
    h2h: () => apiFootball.getH2H(identifier),
    injuries: () => apiFootball.getInjuries(identifier),
    statistics: () => apiFootball.getStatistics(identifier),
    thirdPartyPredictions: () => apiFootball.getPredictions(identifier),
    odds: () => footballOdds.getOdds(identifier),
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
    throw new PredictMatchError(
      'All data providers failed — cannot build a prediction without any source data.',
      { stage: 'data-fetch', cause: results.errors }
    );
  }

  if (opts.requireAllSources && failedSources.length > 0) {
    throw new PredictMatchError(
      `requireAllSources is true but the following sources failed: ${failedSources.join(', ')}`,
      { stage: 'data-fetch', cause: results.errors }
    );
  }

  return results;
}

/**
 * Builds a reasonable default search query for news/web-search providers.
 *
 * @param {MatchIdentifier} identifier
 * @returns {string}
 */
function buildDefaultNewsQuery(identifier) {
  if (identifier.homeTeam && identifier.awayTeam) {
    return `${identifier.homeTeam} vs ${identifier.awayTeam}`;
  }
  // TODO: once fixture lookups are wired, resolve team names from
  // identifier.fixtureId before falling back to this generic query.
  return 'football match preview';
}

/**
 * Normalizes and merges raw provider results into a single MatchContext
 * object matching the shape expected by `buildPredictionPrompt()`. Missing
 * or failed sources simply result in the corresponding field being omitted,
 * since the Prompt Engine already handles missing fields gracefully.
 *
 * @param {RawProviderResults} rawResults
 * @returns {import('../prompts/predictionPrompt').MatchContext}
 */
function normalizeAndMergeData(rawResults) {
  const { data } = rawResults;

  // TODO: these mappings assume each provider already returns normalized
  // shapes matching predictionPrompt's typedefs, per the provider layer's
  // stated responsibility to "normalize data" before returning. If real
  // provider output differs, this is the one place that needs adjusting.
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
 * Merges news items from multiple sources into a single de-duplicated list.
 *
 * @param {unknown} newsDataResult
 * @param {unknown} newsApiResult
 * @param {unknown} tavilyResult
 * @returns {Array<{title: string, source?: string, summary?: string}>}
 */
function mergeNewsSources(newsDataResult, newsApiResult, tavilyResult) {
  // TODO: replace with real field extraction once provider response shapes
  // are confirmed; assumes each provider returns an array of items with at
  // least a `title`, optionally `source`/`summary`.
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
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Builds the small "which match was this" descriptor included on every
 * result, regardless of whether `input` was an ID, an identifier, or a
 * full MatchContext.
 *
 * @param {unknown} input
 * @param {import('../prompts/predictionPrompt').MatchContext} matchContext
 * @returns {{homeTeam: string|null, awayTeam: string|null, date: string|null}}
 */
function describeMatch(input, matchContext) {
  return {
    homeTeam: matchContext.fixture?.homeTeam ?? (typeof input === 'object' ? input.homeTeam : null) ?? null,
    awayTeam: matchContext.fixture?.awayTeam ?? (typeof input === 'object' ? input.awayTeam : null) ?? null,
    date: matchContext.fixture?.date ?? (typeof input === 'object' ? input.date : null) ?? null,
  };
}

/**
 * Validates that `input` is a usable shape before any work begins.
 *
 * @param {unknown} input
 * @returns {void}
 * @throws {PredictMatchError}
 */
function assertValidInput(input) {
  const isPrimitiveId = typeof input === 'number' || typeof input === 'string';
  const isObject = typeof input === 'object' && input !== null && !Array.isArray(input);

  if (!isPrimitiveId && !isObject) {
    throw new PredictMatchError(
      'predictMatch: "input" must be a fixture ID, a {homeTeam, awayTeam} identifier, or a MatchContext object.',
      { stage: 'validation' }
    );
  }

  if (isObject && !isAlreadyMatchContext(input)) {
    const hasFixtureId = input.fixtureId != null;
    const hasTeamPair = input.homeTeam && input.awayTeam;
    if (!hasFixtureId && !hasTeamPair) {
      throw new PredictMatchError(
        'predictMatch: object input must include either a fixtureId or both homeTeam and awayTeam.',
        { stage: 'validation' }
      );
    }
  }
}

/**
 * Shallow-merges user-supplied options over the defaults.
 *
 * @param {PredictMatchOptions} defaults
 * @param {Partial<PredictMatchOptions>} overrides
 * @returns {PredictMatchOptions}
 */
function mergeOptions(defaults, overrides) {
  return {
    ...defaults,
    ...overrides,
    promptOptions: { ...defaults.promptOptions, ...overrides.promptOptions },
    aiProviderOptions: { ...defaults.aiProviderOptions, ...overrides.aiProviderOptions },
  };
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
 * @typedef {Object} PredictMatchOptions
 * @property {string[]} [aiAttemptOrder] - AI providers to try, in order (e.g. ['gemini', 'openrouter']).
 * @property {import('../prompts/predictionPrompt').PromptOptions} [promptOptions]
 * @property {Record<string, unknown>} [aiProviderOptions]
 * @property {boolean} [requireAllSources]
 * @property {string|null} [newsQuery]
 */

/**
 * @typedef {Object} RawProviderResults
 * @property {Record<string, unknown>} data
 * @property {Record<string, unknown>} errors
 */

/**
 * @typedef {Object} AIPrediction
 * @property {{homeTeam: string|null, awayTeam: string|null, date: string|null}} match
 * @property {string} provider - Which AI provider actually served this request.
 * @property {string} text - The raw AI-generated prediction text (markdown).
 * @property {string} prompt - The exact prompt that was sent, for debugging/auditing.
 * @property {unknown} raw - The AI provider's raw, unmodified response.
 * @property {string} generatedAt - ISO timestamp of when the prediction was generated.
 */

/* -------------------------------------------------------------------------- */
/*  Exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  predictMatch,
  PredictMatchError,
};
