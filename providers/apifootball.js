/*
    bet/providers/apiFootball.js

    Provider module for API-Football (v3.football.api-sports.io).

    This is the ONLY file in the betting engine that knows the shape
    of API-Football's endpoints (paths, query parameter names, and its
    response envelope). Every other module — engine code, cache
    writers, prediction logic — should call the functions exported
    here rather than building API-Football URLs or query strings
    itself.

    Architecture rules this file follows:
      - No axios, no fetch, no process.env. All HTTP goes through
        bet/providers/httpClient.js (get/post/etc.), and all
        configuration (API key, base URL) comes from bet/config.js.
      - Every exported function is a thin wrapper around the single
        private request() helper below — none of them build their own
        URL, headers, or error handling. This keeps the "attach the
        API key header" / "unwrap the response envelope" / "detect an
        API-level error" logic in exactly one place.
      - Every exported function validates its own required arguments
        up front and throws a plain, descriptive Error if something
        required is missing — callers get a clear message instead of
        a confusing failure two layers down inside axios.

    API-Football's response envelope looks like:

        {
            "get": "fixtures",
            "parameters": { ... },
            "errors": [] | { "someField": "some message" },
            "results": 12,
            "paging": { "current": 1, "total": 1 },
            "response": [ ... the actual data ... ]
        }

    `errors` is an empty array when the request succeeded, but becomes
    a non-empty array OR a non-empty object (API-Football is
    inconsistent about which, depending on the failure) when something
    went wrong — e.g. an invalid parameter, an exhausted request quota,
    or a bad API key. request() below treats either non-empty shape as
    a failure and throws before any caller ever sees a malformed
    "successful" response. On success, request() returns ONLY the
    `response` field — callers never have to unwrap the envelope
    themselves.
*/

const config = require("../config");
const http = require("./httpClient");

// -----------------------------------------------------------------------
// Internal helpers — not exported
// -----------------------------------------------------------------------

/*
    Builds a single, consistent Error for every kind of failure this
    module can produce (a transport failure from httpClient, or an
    API-level error reported inside a 200 OK response body). Every
    thrown error from this module carries:

        error.provider    → always "apiFootball"
        error.endpoint     → the API-Football path that was called,
                             e.g. "/fixtures"
        error.params        → the query parameters that were sent
                             (a shallow copy, never the caller's own
                             object)
        error.cause          → the underlying error (an HttpClientError
                             from httpClient.js), when there is one

    The message itself is human-readable on its own, so logging just
    `error.message` is still useful without inspecting the extra
    properties.
*/
function buildProviderError(endpoint, params, reason, cause) {

    const error = new Error(
        `[apiFootball] ${endpoint} failed: ${reason}`
    );

    error.name = "ApiFootballError";
    error.provider = "apiFootball";
    error.endpoint = endpoint;
    error.params = { ...params };
    error.cause = cause || null;

    return error;

}

/*
    API-Football reports API-level errors (bad parameter, invalid key,
    quota exceeded, etc.) INSIDE a 200 OK response body, in an
    `errors` field that is either a non-empty array or a non-empty
    object depending on the failure type. This function normalizes
    both shapes into one readable string for buildProviderError(),
    e.g.:

        { "token": "Error/Missing application key..." }
            → "token: Error/Missing application key..."

        ["Invalid league id"]
            → "Invalid league id"
*/
function formatApiErrors(apiErrors) {

    if (Array.isArray(apiErrors)) {

        return apiErrors.join("; ");

    }

    return Object.entries(apiErrors)
        .map(([field, message]) => `${field}: ${message}`)
        .join("; ");

}

/*
    Returns true if API-Football's `errors` field indicates a real
    failure. An empty array (the normal "no errors" case) and an empty
    object are both treated as "no error"; anything with at least one
    entry — array or object — is treated as a failure.
*/
function hasApiErrors(apiErrors) {

    if (!apiErrors) return false;

    if (Array.isArray(apiErrors)) {

        return apiErrors.length > 0;

    }

    if (typeof apiErrors === "object") {

        return Object.keys(apiErrors).length > 0;

    }

    return false;

}

/*
    The single private helper every exported function in this file
    calls. Responsible for:
      1. Building the full request URL from config.football.apiFootball.baseUrl.
      2. Attaching the required x-apisports-key header from
         config.football.apiFootball.apiKey.
      3. Delegating the actual HTTP call to httpClient's get().
      4. Detecting and throwing on both transport-level failures
         (httpClient already throws a descriptive HttpClientError for
         these — this just wraps it with apiFootball-specific context)
         and API-level failures reported inside a 200 OK body.
      5. Returning ONLY the parsed `response` field of API-Football's
         envelope — never the raw envelope, never the raw axios/http
         wrapper.

    `endpoint` is a path like "/fixtures", always relative to
    config.football.apiFootball.baseUrl. `params` is a plain object of
    query parameters; keys with an undefined/null value are dropped
    before the request is sent, so callers can pass optional params
    unconditionally (e.g. `{ league: leagueId, season }`) without
    manually building a conditional object.
*/
async function request(endpoint, params = {}) {

    const cleanParams = Object.fromEntries(
        Object.entries(params).filter(([, value]) => value !== undefined && value !== null)
    );

    const url = `${config.football.apiFootball.baseUrl}${endpoint}`;

    let httpResponse;

    try {

        httpResponse = await http.get(url, {
            params: cleanParams,
            headers: {
                "x-apisports-key": config.football.apiFootball.apiKey
            },
            provider: "apiFootball"
        });

    } catch (error) {

        // httpClient already produced a descriptive HttpClientError
        // (with status/statusText/url/body/duration) — this just adds
        // apiFootball-specific context (endpoint + params) on top.
        throw buildProviderError(endpoint, cleanParams, error.message, error);

    }

    const body = httpResponse.data;

    if (hasApiErrors(body && body.errors)) {

        throw buildProviderError(endpoint, cleanParams, formatApiErrors(body.errors));

    }

    return body.response;

}

// -----------------------------------------------------------------------
// Leagues
// -----------------------------------------------------------------------

/**
 * Fetches the full list of leagues and cups API-Football knows about.
 *
 * Corresponds to `GET /leagues` with no filters.
 *
 * @returns {Promise<Array<Object>>} An array of league objects, each
 *   including basic league info plus the seasons it has data for.
 */
function getLeagues() {

    return request("/leagues");

}

/**
 * Fetches a single league by its API-Football league id.
 *
 * Corresponds to `GET /leagues?id={id}`.
 *
 * @param {number|string} id - The API-Football league id. Required.
 * @returns {Promise<Array<Object>>} An array (per API-Football's
 *   envelope shape) containing the matching league object, including
 *   its available seasons.
 * @throws {Error} If `id` is not provided.
 */
function getLeague(id) {

    if (!id) {

        throw new Error("id is required.");

    }

    return request("/leagues", { id });

}

/**
 * Fetches the seasons available for a given league.
 *
 * API-Football does not expose a dedicated "seasons for this league"
 * endpoint — season data is embedded in each league object returned
 * by `GET /leagues?id={id}`. This function calls that same endpoint
 * so callers get a single, explicit function for "what seasons exist
 * for this league" without needing to know that detail themselves.
 *
 * @param {number|string} id - The API-Football league id. Required.
 * @returns {Promise<Array<Object>>} An array (per API-Football's
 *   envelope shape) containing the matching league object; each
 *   league object's `.seasons` field lists the available seasons.
 * @throws {Error} If `id` is not provided.
 */
function getSeasons(id) {

    if (!id) {

        throw new Error("id is required.");

    }

    return request("/leagues", { id });

}

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------

/**
 * Fetches all fixtures scheduled on a specific date.
 *
 * Corresponds to `GET /fixtures?date={date}`.
 *
 * @param {string} date - Date in "YYYY-MM-DD" format. Required.
 * @returns {Promise<Array<Object>>} An array of fixture objects.
 * @throws {Error} If `date` is not provided.
 */
function getFixturesByDate(date) {

    if (!date) {

        throw new Error("date is required.");

    }

    return request("/fixtures", { date });

}

/**
 * Fetches all fixtures within a date range (inclusive).
 *
 * Corresponds to `GET /fixtures?from={startDate}&to={endDate}`.
 *
 * @param {string} startDate - Range start, "YYYY-MM-DD" format. Required.
 * @param {string} endDate - Range end, "YYYY-MM-DD" format. Required.
 * @returns {Promise<Array<Object>>} An array of fixture objects.
 * @throws {Error} If `startDate` or `endDate` is not provided.
 */
function getFixturesBetween(startDate, endDate) {

    if (!startDate) {

        throw new Error("startDate is required.");

    }

    if (!endDate) {

        throw new Error("endDate is required.");

    }

    return request("/fixtures", { from: startDate, to: endDate });

}

/**
 * Fetches a single fixture by its API-Football fixture id.
 *
 * Corresponds to `GET /fixtures?id={id}`.
 *
 * @param {number|string} id - The API-Football fixture id. Required.
 * @returns {Promise<Array<Object>>} An array (per API-Football's
 *   envelope shape) containing the matching fixture object.
 * @throws {Error} If `id` is not provided.
 */
function getFixture(id) {

    if (!id) {

        throw new Error("id is required.");

    }

    return request("/fixtures", { id });

}

/**
 * Fetches every fixture currently live, across all leagues.
 *
 * Corresponds to `GET /fixtures?live=all`.
 *
 * @returns {Promise<Array<Object>>} An array of currently in-play
 *   fixture objects.
 */
function getLiveFixtures() {

    return request("/fixtures", { live: "all" });

}

/**
 * Fetches all fixtures for a given league and season.
 *
 * Corresponds to `GET /fixtures?league={leagueId}&season={season}`.
 *
 * @param {number|string} leagueId - The API-Football league id. Required.
 * @param {number|string} season - The season year, e.g. 2026. Required.
 * @returns {Promise<Array<Object>>} An array of fixture objects.
 * @throws {Error} If `leagueId` or `season` is not provided.
 */
function getFixturesByLeague(leagueId, season) {

    if (!leagueId) {

        throw new Error("leagueId is required.");

    }

    if (!season) {

        throw new Error("season is required.");

    }

    return request("/fixtures", { league: leagueId, season });

}

/**
 * Fetches all fixtures for a given team and season.
 *
 * Corresponds to `GET /fixtures?team={teamId}&season={season}`.
 *
 * @param {number|string} teamId - The API-Football team id. Required.
 * @param {number|string} season - The season year, e.g. 2026. Required.
 * @returns {Promise<Array<Object>>} An array of fixture objects.
 * @throws {Error} If `teamId` or `season` is not provided.
 */
function getFixturesByTeam(teamId, season) {

    if (!teamId) {

        throw new Error("teamId is required.");

    }

    if (!season) {

        throw new Error("season is required.");

    }

    return request("/fixtures", { team: teamId, season });

}

/**
 * Fetches the head-to-head fixture history between two teams.
 *
 * Corresponds to `GET /fixtures/headtohead?h2h={team1}-{team2}`.
 *
 * @param {number|string} team1 - The API-Football id of the first team. Required.
 * @param {number|string} team2 - The API-Football id of the second team. Required.
 * @returns {Promise<Array<Object>>} An array of past fixture objects
 *   between the two teams, most recent typically first.
 * @throws {Error} If `team1` or `team2` is not provided.
 */
function getHeadToHead(team1, team2) {

    if (!team1) {

        throw new Error("team1 is required.");

    }

    if (!team2) {

        throw new Error("team2 is required.");

    }

    return request("/fixtures/headtohead", { h2h: `${team1}-${team2}` });

}

// -----------------------------------------------------------------------
// Teams
// -----------------------------------------------------------------------

/**
 * Fetches a single team by its API-Football team id.
 *
 * Corresponds to `GET /teams?id={teamId}`.
 *
 * @param {number|string} teamId - The API-Football team id. Required.
 * @returns {Promise<Array<Object>>} An array (per API-Football's
 *   envelope shape) containing the matching team object.
 * @throws {Error} If `teamId` is not provided.
 */
function getTeam(teamId) {

    if (!teamId) {

        throw new Error("teamId is required.");

    }

    return request("/teams", { id: teamId });

}

/**
 * Searches for teams by name.
 *
 * Corresponds to `GET /teams?search={name}`.
 *
 * @param {string} name - Full or partial team name to search for. Required.
 * @returns {Promise<Array<Object>>} An array of matching team objects.
 * @throws {Error} If `name` is not provided.
 */
function searchTeams(name) {

    if (!name) {

        throw new Error("name is required.");

    }

    return request("/teams", { search: name });

}

/**
 * Fetches aggregated statistics for a team within a specific league
 * and season (form, goals for/against, clean sheets, etc.).
 *
 * Corresponds to
 * `GET /teams/statistics?team={teamId}&league={leagueId}&season={season}`.
 *
 * @param {number|string} teamId - The API-Football team id. Required.
 * @param {number|string} leagueId - The API-Football league id. Required.
 * @param {number|string} season - The season year, e.g. 2026. Required.
 * @returns {Promise<Object>} The statistics object for that team/league/season.
 * @throws {Error} If `teamId`, `leagueId`, or `season` is not provided.
 */
function getTeamStatistics(teamId, leagueId, season) {

    if (!teamId) {

        throw new Error("teamId is required.");

    }

    if (!leagueId) {

        throw new Error("leagueId is required.");

    }

    if (!season) {

        throw new Error("season is required.");

    }

    return request("/teams/statistics", { team: teamId, league: leagueId, season });

}

/**
 * Fetches the current squad/player list for a team.
 *
 * Corresponds to `GET /players?team={teamId}`.
 *
 * @param {number|string} teamId - The API-Football team id. Required.
 * @returns {Promise<Array<Object>>} An array of player objects.
 * @throws {Error} If `teamId` is not provided.
 */
function getTeamPlayers(teamId) {

    if (!teamId) {

        throw new Error("teamId is required.");

    }

    return request("/players", { team: teamId });

}

/**
 * Fetches current injury information for a team.
 *
 * Corresponds to `GET /injuries?team={teamId}`.
 *
 * @param {number|string} teamId - The API-Football team id. Required.
 * @returns {Promise<Array<Object>>} An array of injury records.
 * @throws {Error} If `teamId` is not provided.
 */
function getTeamInjuries(teamId) {

    if (!teamId) {

        throw new Error("teamId is required.");

    }

    return request("/injuries", { team: teamId });

}

/**
 * Fetches transfer history for a team.
 *
 * Corresponds to `GET /transfers?team={teamId}`.
 *
 * @param {number|string} teamId - The API-Football team id. Required.
 * @returns {Promise<Array<Object>>} An array of transfer records.
 * @throws {Error} If `teamId` is not provided.
 */
function getTeamTransfers(teamId) {

    if (!teamId) {

        throw new Error("teamId is required.");

    }

    return request("/transfers", { team: teamId });

}

// -----------------------------------------------------------------------
// Standings
// -----------------------------------------------------------------------

/**
 * Fetches the league table/standings for a league and season.
 *
 * Corresponds to `GET /standings?league={leagueId}&season={season}`.
 *
 * @param {number|string} leagueId - The API-Football league id. Required.
 * @param {number|string} season - The season year, e.g. 2026. Required.
 * @returns {Promise<Array<Object>>} An array (per API-Football's
 *   envelope shape) containing the league's standings data, typically
 *   with the table itself nested inside as one or more groups.
 * @throws {Error} If `leagueId` or `season` is not provided.
 */
function getStandings(leagueId, season) {

    if (!leagueId) {

        throw new Error("leagueId is required.");

    }

    if (!season) {

        throw new Error("season is required.");

    }

    return request("/standings", { league: leagueId, season });

}

// -----------------------------------------------------------------------
// Predictions
// -----------------------------------------------------------------------

/**
 * Fetches API-Football's own built-in prediction for a fixture
 * (win/draw/lose percentages, advice, comparison stats, etc.). This is
 * API-Football's native prediction, separate from — and typically used
 * as one input into — this engine's own AI-driven prediction pipeline.
 *
 * Corresponds to `GET /predictions?fixture={fixtureId}`.
 *
 * @param {number|string} fixtureId - The API-Football fixture id. Required.
 * @returns {Promise<Array<Object>>} An array (per API-Football's
 *   envelope shape) containing the prediction object for that fixture.
 * @throws {Error} If `fixtureId` is not provided.
 */
function getApiPrediction(fixtureId) {

    if (!fixtureId) {

        throw new Error("fixtureId is required.");

    }

    return request("/predictions", { fixture: fixtureId });

}

// -----------------------------------------------------------------------
// Odds
// -----------------------------------------------------------------------

/**
 * Fetches bookmaker odds for a single fixture, across whichever
 * bookmakers and markets API-Football has available for it.
 *
 * Corresponds to `GET /odds?fixture={fixtureId}`.
 *
 * @param {number|string} fixtureId - The API-Football fixture id. Required.
 * @returns {Promise<Array<Object>>} An array of odds records for that fixture.
 * @throws {Error} If `fixtureId` is not provided.
 */
function getFixtureOdds(fixtureId) {

    if (!fixtureId) {

        throw new Error("fixtureId is required.");

    }

    return request("/odds", { fixture: fixtureId });

}

/**
 * Fetches bookmaker odds across all fixtures in a league.
 *
 * Corresponds to `GET /odds?league={leagueId}`.
 *
 * @param {number|string} leagueId - The API-Football league id. Required.
 * @returns {Promise<Array<Object>>} An array of odds records across
 *   the league's fixtures.
 * @throws {Error} If `leagueId` is not provided.
 */
function getLeagueOdds(leagueId) {

    if (!leagueId) {

        throw new Error("leagueId is required.");

    }

    return request("/odds", { league: leagueId });

}

// -----------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------

module.exports = {

    // Leagues
    getLeagues,
    getLeague,
    getSeasons,

    // Fixtures
    getFixturesByDate,
    getFixturesBetween,
    getFixture,
    getLiveFixtures,
    getFixturesByLeague,
    getFixturesByTeam,
    getHeadToHead,

    // Teams
    getTeam,
    searchTeams,
    getTeamStatistics,
    getTeamPlayers,
    getTeamInjuries,
    getTeamTransfers,

    // Standings
    getStandings,

    // Predictions
    getApiPrediction,

    // Odds
    getFixtureOdds,
    getLeagueOdds

};