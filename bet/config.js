/*
    bet/config.js

    Centralized, immutable configuration for the Zorex football betting
    engine. Every provider under bet/providers/ and every module under
    bet/engine/ should read its settings from this single file rather
    than touching process.env directly — that keeps env-var handling,
    defaulting, and validation in exactly one place.

    This file assumes its own location is bet/config.js. Cache
    directory paths are built from __dirname rather than relative
    "./" paths, so they resolve correctly no matter what working
    directory the main bot process (index.js, at the project root)
    was started from.

    Usage elsewhere in the codebase:

        const config = require("../config");
        // or, from a file directly inside bet/: require("./config")

        const apiKey = config.football.apiFootball.apiKey;
        const cacheDir = config.cache.fixturesDir;
        const cacheFile = config.cache.fixturesFile;

    No base URL, timeout, retry count, or cache file path should ever
    be hardcoded anywhere else in the betting engine — every provider
    module pulls those from this file so there is exactly one place
    to change them.
*/

require("dotenv").config();

const path = require("path");

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

/*
    Reads an env var as-is. Returns `fallback` (default null) if the
    variable is unset or an empty string — an env var set to "" is
    treated the same as not being set at all, since a blank API key
    is never intentional.
*/
function readEnv(name, fallback = null) {

    const value = process.env[name];

    if (value === undefined || value === null || value.trim() === "") {

        return fallback;

    }

    return value.trim();

}

/*
    Reads a required env var. Throws a descriptive error immediately
    if it is missing, rather than letting the betting engine start up
    in a broken state and fail confusingly later on its first API call.
*/
function readRequiredEnv(name, reason) {

    const value = readEnv(name);

    if (value === null) {

        throw new Error(
            `[bet/config.js] Missing required environment variable "${name}". ${reason} ` +
            `Add ${name}=<value> to your .env file.`
        );

    }

    return value;

}

/*
    Parses a numeric env var with Number(). Falls back to
    `defaultValue` if the variable is unset. If the variable IS set
    but does not parse to a finite number, this throws — a present-
    but-garbled value is treated as a configuration mistake worth
    surfacing loudly, rather than silently falling back to the default.
*/
function readNumberEnv(name, defaultValue) {

    const raw = readEnv(name);

    if (raw === null) {

        return defaultValue;

    }

    const parsed = Number(raw);

    if (!Number.isFinite(parsed)) {

        throw new Error(
            `[bet/config.js] Environment variable "${name}" must be a valid number, got "${raw}".`
        );

    }

    return parsed;

}

/*
    Recursively freezes an object and every plain-object value nested
    inside it, so Object.freeze() actually protects the whole config
    tree (a shallow freeze on the top-level object would still allow
    e.g. config.cache.fixturesDir's PARENT object to be mutated if it
    weren't itself frozen too — this closes that gap section by
    section).
*/
function deepFreeze(value) {

    if (value === null || typeof value !== "object") {

        return value;

    }

    Object.values(value).forEach(deepFreeze);

    return Object.freeze(value);

}

// ---------------------------------------------------------------------
// bot — identity of the WhatsApp bot itself
// ---------------------------------------------------------------------

/*
    BOT_JID is NOT treated as critical here: index.js already derives
    the bot's real JID at runtime from sock.user.id once Baileys
    connects (see setBotJid() in commands/chloe.js), so an unset
    BOT_JID does not prevent the bot — or the betting engine — from
    starting. It's still surfaced here for any bet-engine code that
    wants a static fallback/reference value (e.g. logging, or before
    the socket has connected).
*/
if (readEnv("BOT_JID") === null) {

    console.warn(
        "[bet/config.js] BOT_JID is not set in .env. This is not fatal — " +
        "the live bot JID is set at runtime once WhatsApp connects — but " +
        "any code relying on config.bot.jid before that point will see null."
    );

}

const bot = {

    jid: readEnv("BOT_JID")

};

// ---------------------------------------------------------------------
// football — core sports-data providers the engine cannot function without
//
// Nested per-provider objects (apiKey + baseUrl) so bet/providers/
// apiFootball.js and bet/providers/footballOdds.js never need to
// hardcode their own base URL — both live here as the single source
// of truth.
// ---------------------------------------------------------------------

const football = {

    apiFootball: {

        apiKey: readRequiredEnv(
            "API_FOOTBALL_KEY",
            "It powers bet/providers/apiFootball.js (fixtures, teams, leagues, standings) — the betting engine cannot fetch match data without it."
        ),

        baseUrl: readEnv("API_FOOTBALL_BASE_URL", "https://v3.football.api-sports.io")

    },

    odds: {

        apiKey: readRequiredEnv(
            "FOOTBALL_ODDS_KEY",
            "It powers bet/providers/footballOdds.js — the betting engine cannot fetch betting odds without it."
        ),

        baseUrl: readEnv("FOOTBALL_ODDS_BASE_URL", "https://api.football-data-api.com")

    }

};

// ---------------------------------------------------------------------
// ai — prediction / analysis language model providers
//
// `primary` is the PRIMARY provider (AI_API_KEY + AI_MODEL) and is
// required — it's what the prediction engine uses by default. Every
// other provider (groq, gemini, openrouter, deepseek, mistral) is an
// optional fallback/alternate provider exposed as its own top-level
// object (ai.groq, ai.gemini, ...) rather than nested under a
// `providers` wrapper, so callers can do `config.ai.gemini.apiKey`
// directly. bet/providers/<name>.js should individually guard
// against its own key being null and skip itself (or throw its own
// clear error) if a caller tries to use a provider whose key was
// never configured.
// ---------------------------------------------------------------------

const aiPrimaryKey = readRequiredEnv(
    "AI_API_KEY",
    "It is the primary AI provider key used for match predictions and analysis."
);

const aiPrimaryModel = readEnv("AI_MODEL", "gpt-4o-mini");

const groqKey = readEnv("GROQ_API_KEY");
const groqModel = readEnv("GROQ_MODEL", "llama-3.3-70b-versatile");

const geminiKey = readEnv("GEMINI_API_KEY");

const openrouterKey = readEnv("OPENROUTER_API_KEY");
const openrouterBaseUrl = readEnv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");

const deepseekKey = readEnv("DEEPSEEK_API_KEY");
const mistralKey = readEnv("MISTRAL_API_KEY");

[
    ["GROQ_API_KEY", groqKey, "bet/providers/groq.js"],
    ["GEMINI_API_KEY", geminiKey, "bet/providers/gemini.js"],
    ["OPENROUTER_API_KEY", openrouterKey, "bet/providers/openrouter.js"],
    ["DEEPSEEK_API_KEY", deepseekKey, "bet/providers/deepseek.js"],
    ["MISTRAL_API_KEY", mistralKey, "bet/providers/mistral.js"]
].forEach(([envName, value, providerFile]) => {

    if (value === null) {

        console.warn(
            `[bet/config.js] ${envName} is not set — ${providerFile} will be unavailable as a fallback AI provider.`
        );

    }

});

const ai = {

    // Primary provider — required, used by default for predictions.
    primary: {
        apiKey: aiPrimaryKey,
        model: aiPrimaryModel
    },

    // Optional alternate/fallback providers — any of these may have a
    // null apiKey if the corresponding env var was never set.
    groq: {
        apiKey: groqKey,
        model: groqModel
    },

    gemini: {
        apiKey: geminiKey
    },

    openrouter: {
        apiKey: openrouterKey,
        baseUrl: openrouterBaseUrl
    },

    deepseek: {
        apiKey: deepseekKey
    },

    mistral: {
        apiKey: mistralKey
    }

};

// ---------------------------------------------------------------------
// search — news/web search providers used for team-form / injury context
// ---------------------------------------------------------------------

const tavilyKey = readEnv("TAVILY_API_KEY");
const tavilyBaseUrl = readEnv("TAVILY_BASE_URL", "https://api.tavily.com");

const newsdataKey = readEnv("NEWSDATA_API_KEY");
const newsdataBaseUrl = readEnv("NEWSDATA_BASE_URL", "https://newsdata.io/api/1");

const newsApiKey = readEnv("NEWS_API_KEY");
const newsApiBaseUrl = readEnv("NEWS_API_BASE_URL", "https://newsapi.org/v2");

[
    ["TAVILY_API_KEY", tavilyKey, "bet/providers/tavily.js"],
    ["NEWSDATA_API_KEY", newsdataKey, "bet/providers/newsdata.js"],
    ["NEWS_API_KEY", newsApiKey, "bet/providers/newsapi.js"]
].forEach(([envName, value, providerFile]) => {

    if (value === null) {

        console.warn(
            `[bet/config.js] ${envName} is not set — ${providerFile} will be unavailable for news/context lookups.`
        );

    }

});

const search = {

    tavily: {
        apiKey: tavilyKey,
        baseUrl: tavilyBaseUrl
    },

    newsdata: {
        apiKey: newsdataKey,
        baseUrl: newsdataBaseUrl
    },

    newsapi: {
        apiKey: newsApiKey,
        baseUrl: newsApiBaseUrl
    }

};

// ---------------------------------------------------------------------
// network — shared HTTP behavior every provider module should use
//
// A single place to control outbound request timeout, retry count/
// delay, and the User-Agent string, so no provider file reinvents
// (or forgets) its own retry logic.
// ---------------------------------------------------------------------

const network = {

    timeout: readNumberEnv("NETWORK_TIMEOUT_MS", 15000),
    retries: readNumberEnv("NETWORK_RETRIES", 3),
    retryDelay: readNumberEnv("NETWORK_RETRY_DELAY_MS", 1000),
    userAgent: readEnv("NETWORK_USER_AGENT", "ZorexBot/1.0")

};

if (network.timeout <= 0) {

    throw new Error(
        `[bet/config.js] NETWORK_TIMEOUT_MS must be greater than 0, got ${network.timeout}.`
    );

}

if (network.retries < 0) {

    throw new Error(
        `[bet/config.js] NETWORK_RETRIES must be 0 or greater, got ${network.retries}.`
    );

}

if (network.retryDelay < 0) {

    throw new Error(
        `[bet/config.js] NETWORK_RETRY_DELAY_MS must be 0 or greater, got ${network.retryDelay}.`
    );

}

// ---------------------------------------------------------------------
// cache — on-disk cache directories, one per data domain, plus each
// domain's default JSON file path so providers never hardcode a
// filename inline.
// ---------------------------------------------------------------------

const cacheRootDir = path.join(__dirname, "cache");

const fixturesDir = path.join(cacheRootDir, "fixtures");
const leaguesDir = path.join(cacheRootDir, "leagues");
const oddsDir = path.join(cacheRootDir, "odds");
const predictionsDir = path.join(cacheRootDir, "predictions");
const standingsDir = path.join(cacheRootDir, "standings");
const teamsDir = path.join(cacheRootDir, "teams");

const cache = {

    rootDir: cacheRootDir,

    fixturesDir,
    leaguesDir,
    oddsDir,
    predictionsDir,
    standingsDir,
    teamsDir,

    // Default JSON file paths inside each of the directories above —
    // e.g. cache/fixtures/fixtures.json. Providers/engine modules that
    // need a different filename (per-league, per-date, etc.) can still
    // build their own path off the *Dir values; these are just the
    // sensible single-file defaults.
    fixturesFile: path.join(fixturesDir, "fixtures.json"),
    leaguesFile: path.join(leaguesDir, "leagues.json"),
    oddsFile: path.join(oddsDir, "odds.json"),
    predictionsFile: path.join(predictionsDir, "predictions.json"),
    standingsFile: path.join(standingsDir, "standings.json"),
    teamsFile: path.join(teamsDir, "teams.json")

};

// ---------------------------------------------------------------------
// bet — timing/refresh intervals that drive the engine's background jobs
// ---------------------------------------------------------------------

const betCacheUpdateMinutes = readNumberEnv("BET_CACHE_UPDATE_MINUTES", 15);
const liveMatchUpdateSeconds = readNumberEnv("LIVE_MATCH_UPDATE_SECONDS", 30);
const predictionRefreshHours = readNumberEnv("PREDICTION_REFRESH_HOURS", 6);

if (betCacheUpdateMinutes <= 0) {

    throw new Error(
        `[bet/config.js] BET_CACHE_UPDATE_MINUTES must be greater than 0, got ${betCacheUpdateMinutes}.`
    );

}

if (liveMatchUpdateSeconds <= 0) {

    throw new Error(
        `[bet/config.js] LIVE_MATCH_UPDATE_SECONDS must be greater than 0, got ${liveMatchUpdateSeconds}.`
    );

}

if (predictionRefreshHours <= 0) {

    throw new Error(
        `[bet/config.js] PREDICTION_REFRESH_HOURS must be greater than 0, got ${predictionRefreshHours}.`
    );

}

const bet = {

    cacheUpdateMinutes: betCacheUpdateMinutes,
    cacheUpdateMs: betCacheUpdateMinutes * 60 * 1000,

    liveMatchUpdateSeconds: liveMatchUpdateSeconds,
    liveMatchUpdateMs: liveMatchUpdateSeconds * 1000,

    predictionRefreshHours: predictionRefreshHours,
    predictionRefreshMs: predictionRefreshHours * 60 * 60 * 1000

};

// ---------------------------------------------------------------------
// prediction — thresholds the prediction engine uses to decide whether
// a prediction is confident/consistent enough to act on, and how much
// work it's allowed to do at once
// ---------------------------------------------------------------------

const predictionMinimumConfidence = readNumberEnv("PREDICTION_MINIMUM_CONFIDENCE", 65);
const predictionMaxConsensusDifference = readNumberEnv("PREDICTION_MAX_CONSENSUS_DIFFERENCE", 25);
const predictionMaxConcurrent = readNumberEnv("PREDICTION_MAX_CONCURRENT", 3);

if (predictionMinimumConfidence < 0 || predictionMinimumConfidence > 100) {

    throw new Error(
        `[bet/config.js] PREDICTION_MINIMUM_CONFIDENCE must be between 0 and 100, got ${predictionMinimumConfidence}.`
    );

}

if (predictionMaxConsensusDifference < 0 || predictionMaxConsensusDifference > 100) {

    throw new Error(
        `[bet/config.js] PREDICTION_MAX_CONSENSUS_DIFFERENCE must be between 0 and 100, got ${predictionMaxConsensusDifference}.`
    );

}

if (predictionMaxConcurrent <= 0) {

    throw new Error(
        `[bet/config.js] PREDICTION_MAX_CONCURRENT must be greater than 0, got ${predictionMaxConcurrent}.`
    );

}

const prediction = {

    minimumConfidence: predictionMinimumConfidence,
    maxConsensusDifference: predictionMaxConsensusDifference,
    maxConcurrentPredictions: predictionMaxConcurrent

};

// ---------------------------------------------------------------------
// odds — bounds and defaults used when reading/validating betting odds
// ---------------------------------------------------------------------

const oddsMinimum = readNumberEnv("ODDS_MINIMUM", 1.10);
const oddsMaximum = readNumberEnv("ODDS_MAXIMUM", 1000);
const oddsDefaultMarket = readEnv("ODDS_DEFAULT_MARKET", "Match Winner");

if (oddsMinimum <= 1) {

    throw new Error(
        `[bet/config.js] ODDS_MINIMUM must be greater than 1 (odds below evens make no sense), got ${oddsMinimum}.`
    );

}

if (oddsMaximum <= oddsMinimum) {

    throw new Error(
        `[bet/config.js] ODDS_MAXIMUM (${oddsMaximum}) must be greater than ODDS_MINIMUM (${oddsMinimum}).`
    );

}

const odds = {

    minimumOdds: oddsMinimum,
    maximumOdds: oddsMaximum,
    defaultMarket: oddsDefaultMarket

};

// ---------------------------------------------------------------------
// Assemble + freeze
// ---------------------------------------------------------------------

const config = {
    bot,
    football,
    ai,
    search,
    network,
    cache,
    bet,
    prediction,
    odds
};

module.exports = deepFreeze(config);
