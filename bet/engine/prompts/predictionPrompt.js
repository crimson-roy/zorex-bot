/**
 * @file predictionPrompt.js
 * @module engine/prompts/predictionPrompt
 *
 * @description
 * The Prompt Engine is responsible for a single job: turning an already-normalized
 * football match context object into a high-quality natural-language prompt that
 * can be sent to an AI model (Gemini, OpenRouter, or any future provider) for
 * match analysis and prediction.
 *
 * This module is intentionally provider-agnostic and side-effect free:
 *
 *  - It NEVER calls an external API.
 *  - It NEVER imports apiFootball, footballOdds, newsapi, newsdata, gemini,
 *    openrouter, or tavily.
 *  - It NEVER fetches, caches, or mutates data.
 *  - It ONLY accepts plain JavaScript objects and returns prompt strings.
 *
 * Everything upstream (fetching, merging, normalizing) is someone else's
 * responsibility. Everything downstream (calling the AI, parsing the response)
 * is someone else's responsibility too. This file sits in between and does
 * exactly one thing well: turn data into language.
 *
 * @author Zorex Engineering
 */

'use strict';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The markdown section headings the AI is instructed to produce, in order.
 * Centralized here so the output contract can be changed in exactly one place.
 *
 * @type {string[]}
 */
const OUTPUT_SECTIONS = [
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

/**
 * Default options for {@link buildPredictionPrompt}. Callers may override any
 * subset of these via the `options` parameter.
 *
 * @type {{tone: string, maxNewsItems: number, maxH2HMatches: number, maxFormMatches: number, includeRawStats: boolean, language: string}}
 */
const DEFAULT_OPTIONS = {
  /** Overall voice the AI should write in. */
  tone: 'professional football analyst',
  /** Hard cap on how many news items get inlined into the prompt. */
  maxNewsItems: 6,
  /** Hard cap on how many historical head-to-head matches get inlined. */
  maxH2HMatches: 5,
  /** Hard cap on how many recent form matches (per team) get inlined. */
  maxFormMatches: 5,
  /** Whether to dump raw statistical tables into the prompt verbatim. */
  includeRawStats: true,
  /** Output language for the AI's response. */
  language: 'English',
};

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Builds a complete, structured natural-language prediction prompt from a
 * normalized match context object.
 *
 * This is the only function this module exposes for external use. Everything
 * else is a private helper that supports this function.
 *
 * @param {MatchContext} matchContext - Normalized football data for a single fixture.
 *   See {@link MatchContext} typedef below for the expected shape. Any field
 *   may be missing/undefined; missing sections are simply omitted or marked
 *   as "not available" in the resulting prompt rather than causing an error.
 * @param {PromptOptions} [options={}] - Optional overrides for prompt behavior.
 *   Merged over {@link DEFAULT_OPTIONS}.
 *
 * @returns {string} A fully formed prompt string ready to send to an AI provider.
 *
 * @throws {TypeError} If `matchContext` is not a plain object.
 *
 * @example
 * const prompt = buildPredictionPrompt({
 *   fixture: { homeTeam: 'Liverpool', awayTeam: 'Arsenal', date: '2026-08-10', competition: 'Premier League' },
 *   odds: { home: 2.1, draw: 3.4, away: 3.2 },
 *   injuries: { home: [{ player: 'Alisson', status: 'out' }], away: [] },
 * });
 */
function buildPredictionPrompt(matchContext, options = {}) {
  assertIsPlainObject(matchContext, 'matchContext');
  assertIsPlainObject(options, 'options');

  const opts = { ...DEFAULT_OPTIONS, ...options };

  const sections = [
    buildSystemPreamble(opts),
    buildFixtureSection(matchContext.fixture, matchContext.league, matchContext.venue),
    buildStandingsSection(matchContext.standings),
    buildFormSection(matchContext.form, opts.maxFormMatches),
    buildH2HSection(matchContext.h2h, opts.maxH2HMatches),
    buildInjuriesSection(matchContext.injuries),
    buildStatisticsSection(matchContext.statistics, opts.includeRawStats),
    buildOddsSection(matchContext.odds),
    buildNewsSection(matchContext.news, opts.maxNewsItems),
    buildWeatherSection(matchContext.weather),
    buildExistingPredictionsSection(matchContext.predictions),
    buildAnalysisInstructions(opts),
    buildOutputFormatInstructions(opts),
  ];

  return sections.filter(Boolean).join('\n\n');
}

/* -------------------------------------------------------------------------- */
/*  Section builders                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Builds the opening system-style preamble that frames the AI's role and tone.
 *
 * @param {Required<PromptOptions>} opts - Fully resolved options.
 * @returns {string}
 */
function buildSystemPreamble(opts) {
  return [
    `You are a ${opts.tone} preparing an in-depth pre-match analysis.`,
    `Respond in ${opts.language}.`,
    'Base every conclusion strictly on the data provided below. Do not invent statistics, ' +
      'injuries, quotes, or news that are not present in the supplied data. ' +
      'When information is missing or unclear, explicitly say so rather than guessing.',
  ].join(' ');
}

/**
 * Builds the fixture / competition / venue overview section.
 *
 * @param {FixtureInfo} [fixture]
 * @param {LeagueInfo} [league]
 * @param {VenueInfo} [venue]
 * @returns {string}
 */
function buildFixtureSection(fixture, league, venue) {
  if (!fixture) {
    return heading('FIXTURE') + '\nNo fixture data available.';
  }

  const lines = [
    `Match: ${safe(fixture.homeTeam)} vs ${safe(fixture.awayTeam)}`,
    fixture.date ? `Date: ${safe(fixture.date)}` : null,
    fixture.kickoff ? `Kickoff: ${safe(fixture.kickoff)}` : null,
    league?.name ? `Competition: ${safe(league.name)}${league.round ? ` (${safe(league.round)})` : ''}` : null,
    venue?.name ? `Venue: ${safe(venue.name)}${venue.city ? `, ${safe(venue.city)}` : ''}` : null,
  ].filter(Boolean);

  return heading('FIXTURE') + '\n' + lines.join('\n');
}

/**
 * Builds the current league standings section for both teams, if available.
 *
 * @param {StandingsInfo} [standings]
 * @returns {string}
 */
function buildStandingsSection(standings) {
  if (!standings || (!standings.home && !standings.away)) {
    return '';
  }

  const lines = [];
  if (standings.home) {
    lines.push(`Home team: position ${safe(standings.home.position)}, ${safe(standings.home.points)} points, ` +
      `${safe(standings.home.played)} played (W${safe(standings.home.won)} D${safe(standings.home.drawn)} L${safe(standings.home.lost)})`);
  }
  if (standings.away) {
    lines.push(`Away team: position ${safe(standings.away.position)}, ${safe(standings.away.points)} points, ` +
      `${safe(standings.away.played)} played (W${safe(standings.away.won)} D${safe(standings.away.drawn)} L${safe(standings.away.lost)})`);
  }

  return heading('LEAGUE STANDINGS') + '\n' + lines.join('\n');
}

/**
 * Builds the recent-form section, capped to `maxMatches` per team.
 *
 * @param {FormInfo} [form]
 * @param {number} maxMatches
 * @returns {string}
 */
function buildFormSection(form, maxMatches) {
  if (!form || (!form.home?.length && !form.away?.length)) {
    return heading('RECENT FORM') + '\nNo recent form data available.';
  }

  const lines = [];
  if (form.home?.length) {
    lines.push(`Home team last ${Math.min(form.home.length, maxMatches)} matches:`);
    lines.push(...formatMatchList(form.home.slice(0, maxMatches)));
  }
  if (form.away?.length) {
    lines.push(`Away team last ${Math.min(form.away.length, maxMatches)} matches:`);
    lines.push(...formatMatchList(form.away.slice(0, maxMatches)));
  }

  return heading('RECENT FORM') + '\n' + lines.join('\n');
}

/**
 * Builds the head-to-head history section, capped to `maxMatches`.
 *
 * @param {MatchSummary[]} [h2h]
 * @param {number} maxMatches
 * @returns {string}
 */
function buildH2HSection(h2h, maxMatches) {
  if (!h2h || !h2h.length) {
    return heading('HEAD-TO-HEAD') + '\nNo head-to-head data available.';
  }

  const trimmed = h2h.slice(0, maxMatches);
  return heading('HEAD-TO-HEAD') + '\n' + formatMatchList(trimmed).join('\n');
}

/**
 * Builds the injuries / suspensions section for both teams.
 *
 * @param {InjuriesInfo} [injuries]
 * @returns {string}
 */
function buildInjuriesSection(injuries) {
  if (!injuries || (!injuries.home?.length && !injuries.away?.length)) {
    return heading('KEY INJURIES & SUSPENSIONS') + '\nNo reported injuries or suspensions.';
  }

  const lines = [];
  if (injuries.home?.length) {
    lines.push('Home team:');
    lines.push(...injuries.home.map((i) => `  - ${safe(i.player)}: ${safe(i.status)}${i.detail ? ` (${safe(i.detail)})` : ''}`));
  } else {
    lines.push('Home team: no reported injuries or suspensions.');
  }
  if (injuries.away?.length) {
    lines.push('Away team:');
    lines.push(...injuries.away.map((i) => `  - ${safe(i.player)}: ${safe(i.status)}${i.detail ? ` (${safe(i.detail)})` : ''}`));
  } else {
    lines.push('Away team: no reported injuries or suspensions.');
  }

  return heading('KEY INJURIES & SUSPENSIONS') + '\n' + lines.join('\n');
}

/**
 * Builds the statistics section. When `includeRaw` is false, only a short
 * note is included instead of dumping raw numbers, keeping the prompt lean.
 *
 * @param {Record<string, unknown>} [statistics]
 * @param {boolean} includeRaw
 * @returns {string}
 */
function buildStatisticsSection(statistics, includeRaw) {
  if (!statistics || Object.keys(statistics).length === 0) {
    return '';
  }

  if (!includeRaw) {
    return heading('STATISTICS') + '\nDetailed statistics were collected but omitted from this prompt for brevity.';
  }

  const lines = Object.entries(statistics).map(([key, value]) => `${humanizeKey(key)}: ${formatValue(value)}`);
  return heading('STATISTICS') + '\n' + lines.join('\n');
}

/**
 * Builds the betting odds section, including movement if provided.
 *
 * @param {OddsInfo} [odds]
 * @returns {string}
 */
function buildOddsSection(odds) {
  if (!odds) {
    return heading('ODDS') + '\nNo odds data available.';
  }

  const lines = [
    odds.home != null ? `Home win: ${safe(odds.home)}` : null,
    odds.draw != null ? `Draw: ${safe(odds.draw)}` : null,
    odds.away != null ? `Away win: ${safe(odds.away)}` : null,
    odds.over25 != null ? `Over 2.5 goals: ${safe(odds.over25)}` : null,
    odds.under25 != null ? `Under 2.5 goals: ${safe(odds.under25)}` : null,
    odds.bttsYes != null ? `BTTS Yes: ${safe(odds.bttsYes)}` : null,
    odds.bttsNo != null ? `BTTS No: ${safe(odds.bttsNo)}` : null,
    odds.movement ? `Movement: ${safe(odds.movement)}` : null,
    odds.bookmaker ? `Source bookmaker: ${safe(odds.bookmaker)}` : null,
  ].filter(Boolean);

  return heading('ODDS') + '\n' + (lines.length ? lines.join('\n') : 'No usable odds fields were provided.');
}

/**
 * Builds the news / context section, capped to `maxItems`.
 *
 * @param {NewsItem[]} [news]
 * @param {number} maxItems
 * @returns {string}
 */
function buildNewsSection(news, maxItems) {
  if (!news || !news.length) {
    return heading('RELEVANT NEWS') + '\nNo relevant news items available.';
  }

  const trimmed = news.slice(0, maxItems);
  const lines = trimmed.map((item, idx) => {
    const title = safe(item.title);
    const source = item.source ? ` (${safe(item.source)})` : '';
    const summary = item.summary ? `: ${safe(item.summary)}` : '';
    return `${idx + 1}. ${title}${source}${summary}`;
  });

  return heading('RELEVANT NEWS') + '\n' + lines.join('\n');
}

/**
 * Builds the weather section, if weather data was supplied.
 *
 * @param {WeatherInfo} [weather]
 * @returns {string}
 */
function buildWeatherSection(weather) {
  if (!weather) {
    return '';
  }

  const parts = [
    weather.condition ? `Condition: ${safe(weather.condition)}` : null,
    weather.temperature != null ? `Temperature: ${safe(weather.temperature)}` : null,
    weather.wind ? `Wind: ${safe(weather.wind)}` : null,
    weather.precipitation ? `Precipitation: ${safe(weather.precipitation)}` : null,
  ].filter(Boolean);

  if (!parts.length) {
    return '';
  }

  return heading('WEATHER') + '\n' + parts.join('\n');
}

/**
 * Builds a section surfacing any third-party predictions already gathered
 * (e.g. from apiFootball's own predictions endpoint), purely as extra
 * context for the AI to weigh, not as a source of truth.
 *
 * @param {Record<string, unknown>} [predictions]
 * @returns {string}
 */
function buildExistingPredictionsSection(predictions) {
  if (!predictions || Object.keys(predictions).length === 0) {
    return '';
  }

  const lines = Object.entries(predictions).map(([key, value]) => `${humanizeKey(key)}: ${formatValue(value)}`);
  return heading('THIRD-PARTY PREDICTIONS (for reference only)') + '\n' + lines.join('\n');
}

/**
 * Builds the explicit analysis instructions telling the AI what to evaluate
 * and how to reason about the match.
 *
 * @param {Required<PromptOptions>} opts
 * @returns {string}
 */
function buildAnalysisInstructions(opts) {
  const points = [
    'Analyze the match in depth rather than jumping straight to a conclusion.',
    'Explain your reasoning for every major point instead of stating conclusions alone.',
    'Evaluate recent form for both teams, weighting more recent matches more heavily.',
    'Evaluate the head-to-head history and note any recurring patterns.',
    'Evaluate home and away performance splits where relevant.',
    'Evaluate the statistics provided and connect them to the likely outcome.',
    'Evaluate the odds and what they imply about market expectations.',
    'Evaluate any odds movement and what it may signal about informed money.',
    'Identify and weigh the impact of key injuries and suspensions.',
    'Incorporate relevant news context (morale, transfers, off-field issues, etc.).',
    'Identify the main risk factors that could invalidate the prediction.',
    'Clearly distinguish between facts supported by the data and areas of uncertainty.',
    'Do not make claims that are not supported by the data provided above.',
    'Estimate a confidence level for the prediction and justify why it is not higher or lower.',
  ];

  return heading('ANALYSIS INSTRUCTIONS') + '\n' + points.map((p) => `- ${p}`).join('\n');
}

/**
 * Builds the final instructions describing the exact markdown output format
 * the AI must follow, using {@link OUTPUT_SECTIONS} as the canonical section list.
 *
 * @param {Required<PromptOptions>} opts
 * @returns {string}
 */
function buildOutputFormatInstructions(opts) {
  const sectionList = OUTPUT_SECTIONS.map((s) => `## ${s}`).join('\n');

  return (
    heading('REQUIRED OUTPUT FORMAT') +
    '\n' +
    `Respond only in ${opts.language}, using clean markdown with exactly the following section headings, ` +
    'in this order, each followed by concise, well-reasoned content:\n\n' +
    sectionList +
    '\n\n' +
    'Under "Confidence", give a percentage estimate. Under "Predicted Outcome", state the single most likely ' +
    'result. Under "Recommended Bets", list only markets that are actually supported by the analysis above, ' +
    'and explicitly say "no strong recommendation" if nothing stands out. Keep the "Final Summary" to 2-3 sentences.'
  );
}

/* -------------------------------------------------------------------------- */
/*  Low-level formatting helpers                                              */
/* -------------------------------------------------------------------------- */

/**
 * Formats a section heading in a consistent, visually distinct way.
 *
 * @param {string} title
 * @returns {string}
 */
function heading(title) {
  return `### ${title}`;
}

/**
 * Renders a list of match summaries (used for both form and H2H) as
 * readable one-line strings.
 *
 * @param {MatchSummary[]} matches
 * @returns {string[]}
 */
function formatMatchList(matches) {
  return matches.map((m) => {
    const date = m.date ? `${safe(m.date)}: ` : '';
    const teams = `${safe(m.homeTeam)} ${safe(m.homeScore)} - ${safe(m.awayScore)} ${safe(m.awayTeam)}`;
    const competition = m.competition ? ` (${safe(m.competition)})` : '';
    return `  - ${date}${teams}${competition}`;
  });
}

/**
 * Converts a camelCase or snake_case key into a human-readable label.
 *
 * @param {string} key
 * @returns {string}
 */
function humanizeKey(key) {
  return String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Formats an arbitrary value for inline display in the prompt, handling
 * objects and arrays gracefully instead of printing "[object Object]".
 *
 * @param {unknown} value
 * @returns {string}
 */
function formatValue(value) {
  if (value == null) {
    return 'not available';
  }
  if (Array.isArray(value)) {
    return value.map((v) => formatValue(v)).join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => `${humanizeKey(k)}: ${formatValue(v)}`)
      .join('; ');
  }
  return String(value);
}

/**
 * Safely stringifies a value for inline prompt text, falling back to
 * "unknown" for null/undefined so prompts never contain the literal
 * strings "undefined" or "null".
 *
 * @param {unknown} value
 * @returns {string}
 */
function safe(value) {
  return value == null || value === '' ? 'unknown' : String(value);
}

/* -------------------------------------------------------------------------- */
/*  Validation helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Asserts that a value is a plain object (not null, not an array, not a
 * class instance masquerading as something else), throwing a descriptive
 * TypeError if not.
 *
 * @param {unknown} value
 * @param {string} paramName - Name of the parameter, used in the error message.
 * @returns {void}
 * @throws {TypeError}
 */
function assertIsPlainObject(value, paramName) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`predictionPrompt: "${paramName}" must be a plain object, received ${describeType(value)}.`);
  }
}

/**
 * Produces a human-readable description of a value's type, for error messages.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/* -------------------------------------------------------------------------- */
/*  Type definitions (JSDoc only, for editor intellisense)                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} PromptOptions
 * @property {string} [tone] - Persona/voice for the AI to adopt.
 * @property {number} [maxNewsItems] - Max news items to inline.
 * @property {number} [maxH2HMatches] - Max head-to-head matches to inline.
 * @property {number} [maxFormMatches] - Max recent-form matches per team to inline.
 * @property {boolean} [includeRawStats] - Whether to inline raw statistics.
 * @property {string} [language] - Output language for the AI response.
 */

/**
 * @typedef {Object} FixtureInfo
 * @property {string} homeTeam
 * @property {string} awayTeam
 * @property {string} [date]
 * @property {string} [kickoff]
 */

/**
 * @typedef {Object} LeagueInfo
 * @property {string} [name]
 * @property {string} [round]
 */

/**
 * @typedef {Object} VenueInfo
 * @property {string} [name]
 * @property {string} [city]
 */

/**
 * @typedef {Object} StandingsInfo
 * @property {Object} [home]
 * @property {Object} [away]
 */

/**
 * @typedef {Object} MatchSummary
 * @property {string} [date]
 * @property {string} homeTeam
 * @property {string} awayTeam
 * @property {number|string} [homeScore]
 * @property {number|string} [awayScore]
 * @property {string} [competition]
 */

/**
 * @typedef {Object} FormInfo
 * @property {MatchSummary[]} [home]
 * @property {MatchSummary[]} [away]
 */

/**
 * @typedef {Object} InjuryEntry
 * @property {string} player
 * @property {string} status
 * @property {string} [detail]
 */

/**
 * @typedef {Object} InjuriesInfo
 * @property {InjuryEntry[]} [home]
 * @property {InjuryEntry[]} [away]
 */

/**
 * @typedef {Object} OddsInfo
 * @property {number} [home]
 * @property {number} [draw]
 * @property {number} [away]
 * @property {number} [over25]
 * @property {number} [under25]
 * @property {number} [bttsYes]
 * @property {number} [bttsNo]
 * @property {string} [movement]
 * @property {string} [bookmaker]
 */

/**
 * @typedef {Object} NewsItem
 * @property {string} title
 * @property {string} [source]
 * @property {string} [summary]
 */

/**
 * @typedef {Object} WeatherInfo
 * @property {string} [condition]
 * @property {number|string} [temperature]
 * @property {string} [wind]
 * @property {string} [precipitation]
 */

/**
 * @typedef {Object} MatchContext
 * @property {FixtureInfo} [fixture]
 * @property {LeagueInfo} [league]
 * @property {VenueInfo} [venue]
 * @property {StandingsInfo} [standings]
 * @property {FormInfo} [form]
 * @property {MatchSummary[]} [h2h]
 * @property {InjuriesInfo} [injuries]
 * @property {Record<string, unknown>} [statistics]
 * @property {OddsInfo} [odds]
 * @property {NewsItem[]} [news]
 * @property {WeatherInfo} [weather]
 * @property {Record<string, unknown>} [predictions]
 */

/* -------------------------------------------------------------------------- */
/*  Exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  buildPredictionPrompt,
};
