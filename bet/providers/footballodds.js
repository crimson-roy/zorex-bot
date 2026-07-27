/**
 * footballOdds.js
 *
 * Provider module responsible for all communication with the Football Odds
 * API (fixtures odds, markets, bookmakers, and derived odds utilities).
 *
 * This module exists to isolate every HTTP call, every piece of response
 * validation, and every provider-specific error into a single place so that
 * the rest of the Zorex Football Betting Engine never has to know how the
 * Football Odds API is shaped, authenticated against, or how it fails.
 *
 * Every exported function follows the same contract:
 *   1. Validate its own input parameters and fail loudly if they are wrong.
 *   2. Delegate the actual network call to the private `request()` helper.
 *   3. Return only the parsed, validated data the caller actually needs.
 *
 * No exported function contains its own HTTP logic. All HTTP logic lives in
 * `request()` so there is exactly one place where authentication, headers,
 * URL construction, and response validation happen.
 */

const config = require("../config");
const http = require("./httpClient");

/**
 * buildProviderError
 *
 * Builds a single, consistent Error object for every failure that can occur
 * while talking to the Football Odds API. Centralizing error construction
 * here means every thrown error carries the same shape, which makes
 * debugging and upstream error handling predictable.
 *
 * @param {Object} details - Information describing what went wrong.
 * @param {string} details.endpoint - The API endpoint that was being called.
 * @param {Object} details.parameters - The parameters sent with the request.
 * @param {string} details.message - A human-readable description of the failure.
 * @param {*} [details.apiMessage] - Any error message/body returned by the API itself.
 * @param {Error} [details.cause] - The underlying error that triggered this failure, if any.
 * @returns {Error} A fully-populated Error instance ready to be thrown.
 */
function buildProviderError({ endpoint, parameters, message, apiMessage, cause }) {
    const error = new Error(
        `[footballOdds] ${message} (endpoint: "${endpoint}")`
    );

    error.provider = "footballOdds";
    error.endpoint = endpoint;
    error.parameters = parameters || {};
    error.apiMessage = apiMessage !== undefined ? apiMessage : null;
    error.cause = cause || null;

    return error;
}

/**
 * request
 *
 * The single private helper responsible for every network call this
 * provider makes. Every exported function in this file must route its
 * network access through this helper — nothing else in this module is
 * allowed to call `http.get` directly.
 *
 * Responsibilities:
 *   - Build the full request URL from the configured base URL and endpoint.
 *   - Attach authentication (API key) required by the Football Odds API.
 *   - Attach the headers the API expects.
 *   - Perform the HTTP GET request via the shared httpClient.
 *   - Validate that the response is well-formed JSON with the fields this
 *     provider depends on.
 *   - Throw descriptive, provider-specific errors on any failure.
 *   - Return only the parsed `response` payload, never the raw HTTP object.
 *
 * @param {string} endpoint - The API endpoint to call, e.g. "/odds".
 * @param {Object} [params={}] - Query parameters to send with the request.
 * @returns {Promise<Object>} The parsed and validated API response payload.
 * @throws {Error} If configuration is missing, the request fails, the
 *   response is not valid JSON, or the response does not contain the
 *   fields this provider expects.
 */
async function request(endpoint, params = {}) {
    if (!endpoint) {
        throw buildProviderError({
            endpoint: endpoint || "(missing)",
            parameters: params,
            message: "An endpoint is required to make a request."
        });
    }

    const apiKey = config.football && config.football.odds && config.football.odds.apiKey;
    const baseUrl = config.football && config.football.odds && config.football.odds.baseUrl;

    if (!apiKey) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "Missing config.football.odds.apiKey. The Football Odds API key must be configured."
        });
    }

    if (!baseUrl) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "Missing config.football.odds.baseUrl. The Football Odds API base URL must be configured."
        });
    }

    const url = `${baseUrl.replace(/\/+$/, "")}${endpoint}`;

    let httpResponse;

    try {
        httpResponse = await http.get(url, {
            headers: {
                "x-api-key": apiKey,
                "Accept": "application/json"
            },
            params
        });
    } catch (cause) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The request to the Football Odds API failed.",
            cause
        });
    }

    if (!httpResponse) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The Football Odds API returned an empty response."
        });
    }

    const body = httpResponse.data !== undefined ? httpResponse.data : httpResponse;

    if (typeof body !== "object" || body === null) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The Football Odds API did not return valid JSON."
        });
    }

    if (body.error) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The Football Odds API returned an error.",
            apiMessage: body.error
        });
    }

    if (!("response" in body)) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The Football Odds API response is missing the expected \"response\" field.",
            apiMessage: body
        });
    }

    return body.response;
}

/**
 * requireParam
 *
 * Small defensive helper used by every exported function to validate a
 * required parameter before any network call is attempted. Keeping this
 * check in one place avoids duplicating the same `if (!x) throw` pattern
 * across every function in the file.
 *
 * @param {*} value - The value being validated.
 * @param {string} name - The name of the parameter, used in the error message.
 * @throws {Error} If the value is missing (undefined, null, or empty string).
 */
function requireParam(value, name) {
    if (value === undefined || value === null || value === "") {
        throw new Error(`${name} is required.`);
    }
}

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

/**
 * getUpcomingOdds
 *
 * Fetches odds for all upcoming (not yet started) fixtures. Useful for
 * building a "next matches" board where users pick pre-match bets.
 *
 * @returns {Promise<Object>} The parsed odds data for upcoming fixtures.
 * @throws {Error} If the request to the Football Odds API fails.
 */
async function getUpcomingOdds() {
    return request("/odds", { status: "NS" });
}

/**
 * getLiveOdds
 *
 * Fetches odds for fixtures that are currently in play. This powers any
 * "live betting" surface where odds fluctuate as the match progresses.
 *
 * @returns {Promise<Object>} The parsed odds data for live fixtures.
 * @throws {Error} If the request to the Football Odds API fails.
 */
async function getLiveOdds() {
    return request("/odds/live");
}

/**
 * getPrematchOdds
 *
 * Fetches pre-match odds only, excluding live/in-play markets. This is
 * distinct from `getUpcomingOdds` in that the provider may return a
 * different market set for strictly pre-match products.
 *
 * @returns {Promise<Object>} The parsed pre-match odds data.
 * @throws {Error} If the request to the Football Odds API fails.
 */
async function getPrematchOdds() {
    return request("/odds", { bet: "prematch" });
}

/**
 * getOddsByFixture
 *
 * Fetches all available odds for a single fixture. This is the primary
 * lookup used when a user opens a specific match to place a bet.
 *
 * @param {number|string} fixtureId - The unique identifier of the fixture.
 * @returns {Promise<Object>} The parsed odds data for the given fixture.
 * @throws {Error} If fixtureId is missing or the request fails.
 */
async function getOddsByFixture(fixtureId) {
    requireParam(fixtureId, "fixtureId");

    return request("/odds", { fixture: fixtureId });
}

/**
 * getOddsByLeague
 *
 * Fetches odds for every fixture belonging to a given league. Useful for
 * league-wide odds boards (e.g. "all Premier League odds this week").
 *
 * @param {number|string} leagueId - The unique identifier of the league.
 * @returns {Promise<Object>} The parsed odds data for the given league.
 * @throws {Error} If leagueId is missing or the request fails.
 */
async function getOddsByLeague(leagueId) {
    requireParam(leagueId, "leagueId");

    return request("/odds", { league: leagueId });
}

/**
 * getOddsByDate
 *
 * Fetches odds for every fixture scheduled on a given calendar date.
 * Expected format is whatever the Football Odds API expects for a date
 * filter (typically "YYYY-MM-DD"); this function does not reformat the
 * value, it only validates that one was provided.
 *
 * @param {string} date - The date to filter fixtures by.
 * @returns {Promise<Object>} The parsed odds data for fixtures on that date.
 * @throws {Error} If date is missing or the request fails.
 */
async function getOddsByDate(date) {
    requireParam(date, "date");

    return request("/odds", { date });
}

/* ------------------------------------------------------------------------ *
 * Markets
 * ------------------------------------------------------------------------ */

/**
 * getMarkets
 *
 * Fetches the full list of betting markets supported by the Football Odds
 * API (e.g. Match Winner, Over/Under, Both Teams To Score). This is
 * typically used to populate market filters in the UI.
 *
 * @returns {Promise<Object>} The parsed list of available markets.
 * @throws {Error} If the request to the Football Odds API fails.
 */
async function getMarkets() {
    return request("/odds/bets");
}

/**
 * getMarket
 *
 * Fetches the details of a single betting market by its identifier.
 *
 * @param {number|string} marketId - The unique identifier of the market.
 * @returns {Promise<Object>} The parsed details of the requested market.
 * @throws {Error} If marketId is missing or the request fails.
 */
async function getMarket(marketId) {
    requireParam(marketId, "marketId");

    return request("/odds/bets", { id: marketId });
}

/**
 * getFixtureMarkets
 *
 * Fetches every market available for a specific fixture, without the
 * accompanying odds values. Useful when the UI first needs to know which
 * markets exist for a match before drilling into their odds.
 *
 * @param {number|string} fixtureId - The unique identifier of the fixture.
 * @returns {Promise<Object>} The parsed list of markets for the fixture.
 * @throws {Error} If fixtureId is missing or the request fails.
 */
async function getFixtureMarkets(fixtureId) {
    requireParam(fixtureId, "fixtureId");

    return request("/odds/bets", { fixture: fixtureId });
}

/* ------------------------------------------------------------------------ *
 * Bookmakers
 * ------------------------------------------------------------------------ */

/**
 * getBookmakers
 *
 * Fetches the full list of bookmakers supported by the Football Odds API.
 * Used to populate bookmaker filters and to resolve bookmaker names/ids
 * elsewhere in the engine.
 *
 * @returns {Promise<Object>} The parsed list of bookmakers.
 * @throws {Error} If the request to the Football Odds API fails.
 */
async function getBookmakers() {
    return request("/odds/bookmakers");
}

/**
 * getBookmaker
 *
 * Fetches the details of a single bookmaker by its identifier.
 *
 * @param {number|string} bookmakerId - The unique identifier of the bookmaker.
 * @returns {Promise<Object>} The parsed details of the requested bookmaker.
 * @throws {Error} If bookmakerId is missing or the request fails.
 */
async function getBookmaker(bookmakerId) {
    requireParam(bookmakerId, "bookmakerId");

    return request("/odds/bookmakers", { id: bookmakerId });
}

/* ------------------------------------------------------------------------ *
 * Odds Utilities
 * ------------------------------------------------------------------------ */

/**
 * getBestOddsForFixture
 *
 * Fetches the odds for a fixture and, for each market/selection, resolves
 * the single highest odd across all bookmakers. This gives users the best
 * possible price without having to compare bookmakers manually.
 *
 * The Football Odds API returns odds grouped by bookmaker, each with its
 * own list of bets and values. This function flattens that structure down
 * to "market label -> best value found" per bookmaker entry it receives.
 *
 * @param {number|string} fixtureId - The unique identifier of the fixture.
 * @returns {Promise<Array<Object>>} An array of bookmaker odds entries for
 *   the fixture, unchanged from the API, alongside a `best` summary object
 *   produced by `findHighestOdd`.
 * @throws {Error} If fixtureId is missing, the request fails, or the
 *   response does not contain the bookmakers data expected for this
 *   calculation.
 */
async function getBestOddsForFixture(fixtureId) {
    requireParam(fixtureId, "fixtureId");

    const oddsResponse = await getOddsByFixture(fixtureId);

    if (!Array.isArray(oddsResponse) || oddsResponse.length === 0) {
        throw buildProviderError({
            endpoint: "/odds",
            parameters: { fixture: fixtureId },
            message: `No odds data was returned for fixture "${fixtureId}", so the best odds cannot be calculated.`
        });
    }

    const bookmakers = oddsResponse[0].bookmakers;

    if (!Array.isArray(bookmakers) || bookmakers.length === 0) {
        throw buildProviderError({
            endpoint: "/odds",
            parameters: { fixture: fixtureId },
            message: `Fixture "${fixtureId}" has no bookmakers in its odds data.`
        });
    }

    return {
        fixtureId,
        bookmakers,
        best: findHighestOdd(bookmakers)
    };
}

/**
 * getAccumulatorOdds
 *
 * Fetches the best available odds for every fixture in the given list of
 * fixture identifiers. This is the data-gathering step that precedes
 * building an accumulator (multi-bet); it does not combine the odds
 * together, it only collects them per fixture.
 *
 * @param {Array<number|string>} fixtures - An array of fixture identifiers.
 * @returns {Promise<Array<Object>>} An array of best-odds results, one per
 *   fixture, in the same order the fixtures were supplied.
 * @throws {Error} If fixtures is missing, not an array, empty, or if any
 *   individual fixture lookup fails.
 */
async function getAccumulatorOdds(fixtures) {
    requireParam(fixtures, "fixtures");

    if (!Array.isArray(fixtures) || fixtures.length === 0) {
        throw new Error("fixtures must be a non-empty array of fixture identifiers.");
    }

    const results = [];

    for (const fixtureId of fixtures) {
        // Sequential requests are used deliberately here rather than
        // Promise.all so that, on failure, the error clearly identifies
        // which single fixture in the list could not be resolved.
        const bestOdds = await getBestOddsForFixture(fixtureId);
        results.push(bestOdds);
    }

    return results;
}

/**
 * calculateAccumulator
 *
 * Builds a full accumulator (multi-bet) summary for the given fixtures:
 * fetches the best odds for each fixture and combines them into a single
 * combined odd using `calculateCombinedOdds`.
 *
 * @param {Array<number|string>} fixtures - An array of fixture identifiers
 *   to include in the accumulator.
 * @returns {Promise<Object>} An object containing the per-fixture best-odds
 *   legs and the combined odd for the whole accumulator.
 * @throws {Error} If fixtures is missing/invalid or any fixture lookup fails.
 */
async function calculateAccumulator(fixtures) {
    requireParam(fixtures, "fixtures");

    const legs = await getAccumulatorOdds(fixtures);

    const oddsValues = legs.map((leg) => leg.best.odd);
    const combinedOdds = calculateCombinedOdds(oddsValues);

    return {
        legs,
        combinedOdds
    };
}

/**
 * calculatePotentialWin
 *
 * Calculates the potential return on a stake given a decimal odd. This is
 * a pure calculation with no network access, exposed here because it is
 * directly tied to the odds this provider fetches.
 *
 * @param {number} stake - The amount being staked. Must be a positive number.
 * @param {number} odds - The decimal odd to apply to the stake. Must be a
 *   positive number greater than or equal to 1.
 * @returns {number} The potential total return (stake included) if the bet wins.
 * @throws {Error} If stake or odds is missing, not a number, or not positive.
 */
function calculatePotentialWin(stake, odds) {
    requireParam(stake, "stake");
    requireParam(odds, "odds");

    if (typeof stake !== "number" || Number.isNaN(stake) || stake <= 0) {
        throw new Error("stake must be a positive number.");
    }

    if (typeof odds !== "number" || Number.isNaN(odds) || odds < 1) {
        throw new Error("odds must be a number greater than or equal to 1.");
    }

    return stake * odds;
}

/**
 * calculateCombinedOdds
 *
 * Combines an array of decimal odds into a single accumulator odd by
 * multiplying them together. This is the standard way multi-bet/accumulator
 * odds are calculated across bookmakers.
 *
 * @param {Array<number>} oddsArray - An array of decimal odds, each greater
 *   than or equal to 1.
 * @returns {number} The combined decimal odd for the whole accumulator.
 * @throws {Error} If oddsArray is missing, not an array, empty, or contains
 *   any value that is not a valid decimal odd.
 */
function calculateCombinedOdds(oddsArray) {
    requireParam(oddsArray, "oddsArray");

    if (!Array.isArray(oddsArray) || oddsArray.length === 0) {
        throw new Error("oddsArray must be a non-empty array of decimal odds.");
    }

    return oddsArray.reduce((combined, odd, index) => {
        if (typeof odd !== "number" || Number.isNaN(odd) || odd < 1) {
            throw new Error(`oddsArray contains an invalid odd at index ${index}: "${odd}".`);
        }

        return combined * odd;
    }, 1);
}

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

/**
 * findHighestOdd
 *
 * Scans a list of bookmaker odds entries and finds the single highest odd
 * value across all of them, along with which bookmaker offered it. Used to
 * surface the best available price to the user.
 *
 * Each bookmaker entry is expected to look like:
 *   { id, name, bets: [ { id, name, values: [ { value, odd }, ... ] }, ... ] }
 *
 * @param {Array<Object>} bookmakers - An array of bookmaker odds entries.
 * @returns {Object} An object describing the highest odd found: the
 *   bookmaker name/id, the bet/market name, the selection value, and the
 *   odd itself.
 * @throws {Error} If bookmakers is missing, not an array, empty, or does
 *   not contain any usable odd values.
 */
function findHighestOdd(bookmakers) {
    requireParam(bookmakers, "bookmakers");

    if (!Array.isArray(bookmakers) || bookmakers.length === 0) {
        throw new Error("bookmakers must be a non-empty array.");
    }

    let highest = null;

    for (const bookmaker of bookmakers) {
        const bets = Array.isArray(bookmaker.bets) ? bookmaker.bets : [];

        for (const bet of bets) {
            const values = Array.isArray(bet.values) ? bet.values : [];

            for (const value of values) {
                const odd = parseFloat(value.odd);

                if (Number.isNaN(odd)) {
                    continue;
                }

                if (!highest || odd > highest.odd) {
                    highest = {
                        bookmakerId: bookmaker.id,
                        bookmakerName: bookmaker.name,
                        marketId: bet.id,
                        marketName: bet.name,
                        selection: value.value,
                        odd
                    };
                }
            }
        }
    }

    if (!highest) {
        throw new Error("No valid odd values were found in the provided bookmakers data.");
    }

    return highest;
}

/**
 * findLowestOdd
 *
 * Scans a list of bookmaker odds entries and finds the single lowest odd
 * value across all of them, along with which bookmaker offered it. Useful
 * for risk analysis or for showing users the worst available price.
 *
 * @param {Array<Object>} bookmakers - An array of bookmaker odds entries,
 *   in the same shape described in `findHighestOdd`.
 * @returns {Object} An object describing the lowest odd found: the
 *   bookmaker name/id, the bet/market name, the selection value, and the
 *   odd itself.
 * @throws {Error} If bookmakers is missing, not an array, empty, or does
 *   not contain any usable odd values.
 */
function findLowestOdd(bookmakers) {
    requireParam(bookmakers, "bookmakers");

    if (!Array.isArray(bookmakers) || bookmakers.length === 0) {
        throw new Error("bookmakers must be a non-empty array.");
    }

    let lowest = null;

    for (const bookmaker of bookmakers) {
        const bets = Array.isArray(bookmaker.bets) ? bookmaker.bets : [];

        for (const bet of bets) {
            const values = Array.isArray(bet.values) ? bet.values : [];

            for (const value of values) {
                const odd = parseFloat(value.odd);

                if (Number.isNaN(odd)) {
                    continue;
                }

                if (!lowest || odd < lowest.odd) {
                    lowest = {
                        bookmakerId: bookmaker.id,
                        bookmakerName: bookmaker.name,
                        marketId: bet.id,
                        marketName: bet.name,
                        selection: value.value,
                        odd
                    };
                }
            }
        }
    }

    if (!lowest) {
        throw new Error("No valid odd values were found in the provided bookmakers data.");
    }

    return lowest;
}

/**
 * averageOdds
 *
 * Calculates the average of every odd value found across a list of
 * bookmaker odds entries. Gives a sense of the "market consensus" price
 * rather than the best or worst single price.
 *
 * @param {Array<Object>} bookmakers - An array of bookmaker odds entries,
 *   in the same shape described in `findHighestOdd`.
 * @returns {number} The average of all valid odd values found.
 * @throws {Error} If bookmakers is missing, not an array, empty, or does
 *   not contain any usable odd values.
 */
function averageOdds(bookmakers) {
    requireParam(bookmakers, "bookmakers");

    if (!Array.isArray(bookmakers) || bookmakers.length === 0) {
        throw new Error("bookmakers must be a non-empty array.");
    }

    let total = 0;
    let count = 0;

    for (const bookmaker of bookmakers) {
        const bets = Array.isArray(bookmaker.bets) ? bookmaker.bets : [];

        for (const bet of bets) {
            const values = Array.isArray(bet.values) ? bet.values : [];

            for (const value of values) {
                const odd = parseFloat(value.odd);

                if (Number.isNaN(odd)) {
                    continue;
                }

                total += odd;
                count += 1;
            }
        }
    }

    if (count === 0) {
        throw new Error("No valid odd values were found in the provided bookmakers data.");
    }

    return total / count;
}

/**
 * removeDuplicateBookmakers
 *
 * Removes duplicate bookmaker entries from a list, keeping the first
 * occurrence of each unique bookmaker id. The Football Odds API can, in
 * some responses, return the same bookmaker more than once (e.g. when
 * merging data across multiple upstream sources); this helper guarantees
 * callers get a clean, de-duplicated list before running further
 * calculations such as `findHighestOdd` or `averageOdds`.
 *
 * @param {Array<Object>} bookmakers - An array of bookmaker odds entries,
 *   each expected to have an `id` field.
 * @returns {Array<Object>} A new array containing only the first occurrence
 *   of each unique bookmaker id.
 * @throws {Error} If bookmakers is missing or not an array.
 */
function removeDuplicateBookmakers(bookmakers) {
    requireParam(bookmakers, "bookmakers");

    if (!Array.isArray(bookmakers)) {
        throw new Error("bookmakers must be an array.");
    }

    const seen = new Set();
    const deduplicated = [];

    for (const bookmaker of bookmakers) {
        if (!bookmaker || bookmaker.id === undefined || bookmaker.id === null) {
            continue;
        }

        if (seen.has(bookmaker.id)) {
            continue;
        }

        seen.add(bookmaker.id);
        deduplicated.push(bookmaker);
    }

    return deduplicated;
}

module.exports = {
    getUpcomingOdds,
    getLiveOdds,
    getPrematchOdds,
    getOddsByFixture,
    getOddsByLeague,
    getOddsByDate,
    getMarkets,
    getMarket,
    getFixtureMarkets,
    getBookmakers,
    getBookmaker,
    getBestOddsForFixture,
    getAccumulatorOdds,
    calculateAccumulator,
    calculatePotentialWin,
    calculateCombinedOdds,
    findHighestOdd,
    findLowestOdd,
    averageOdds,
    removeDuplicateBookmakers
};