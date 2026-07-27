/**
 * newsapi.js
 *
 * Provider module responsible for all communication with the NewsAPI.org
 * API. Alongside `newsdata.js`, this provider gives the Zorex Football
 * Betting Engine a second, independent source of structured news articles
 * — useful both as a fallback when one provider is rate-limited or down,
 * and as a way to cross-check coverage of the same story across outlets.
 *
 * This module exists to isolate every HTTP call, every piece of response
 * validation, and every provider-specific error into a single place so that
 * the rest of the engine never has to know how the NewsAPI.org API is
 * shaped, authenticated against, or how it fails.
 *
 * Every exported function follows the same contract:
 *   1. Validate its own input parameters and fail loudly if they are wrong.
 *   2. Delegate the actual network call to the private `request()` helper.
 *   3. Return only the parsed, validated data the caller actually needs.
 *
 * No exported function contains its own HTTP logic. All HTTP logic lives in
 * `request()` so there is exactly one place where authentication, headers,
 * URL construction, and response validation happen.
 *
 * The NewsAPI.org API is a GET-based, query-string API (like
 * `apiFootball.js`, `footballOdds.js`, and `newsdata.js`), authenticated via
 * an `apiKey` query parameter. `request()` reflects that.
 */

const config = require("../config");
const http = require("./httpClient");

/**
 * buildProviderError
 *
 * Builds a single, consistent Error object for every failure that can occur
 * while talking to the NewsAPI.org API. Centralizing error construction
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
        `[newsapi] ${message} (endpoint: "${endpoint}")`
    );

    error.provider = "newsapi";
    error.endpoint = endpoint;
    error.parameters = parameters || {};
    error.apiMessage = apiMessage !== undefined ? apiMessage : null;
    error.cause = cause || null;

    return error;
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

/**
 * cleanParams
 *
 * Removes every `undefined` and `null` value from a parameters object
 * before it is sent as a query string. Callers in this file build their
 * params objects with optional fields left as `undefined` when the caller
 * did not supply them; without cleaning, those would be serialized as
 * literal "undefined"/"null" query values and sent straight through to the
 * NewsAPI.org API. This keeps every outgoing request minimal and
 * predictable.
 *
 * @param {Object} params - The raw parameters object to clean.
 * @returns {Object} A new object containing only the defined, non-null
 *   entries from `params`.
 */
function cleanParams(params) {
    const cleaned = {};

    for (const key of Object.keys(params)) {
        const value = params[key];

        if (value !== undefined && value !== null) {
            cleaned[key] = value;
        }
    }

    return cleaned;
}

/**
 * fetchEnvelope
 *
 * The single private helper responsible for every network call this
 * provider makes. Every exported function in this file must route its
 * network access through this helper (directly, or via `request()`) —
 * nothing else in this module is allowed to call `http.get` directly.
 *
 * This helper only handles the parts of a request that are identical
 * across every NewsAPI.org endpoint this provider calls: URL construction,
 * authentication, header/param cleaning, the HTTP call itself, JSON
 * validation, and the shared `status: "ok"` success check. It deliberately
 * stops short of extracting a specific field (e.g. "articles" vs
 * "sources") because different NewsAPI.org endpoints use different field
 * names for their payload — that final extraction step is left to
 * `request()` and to `getSources()`, so the field-agnostic HTTP mechanics
 * are never duplicated between them.
 *
 * @param {string} endpoint - The API endpoint to call, e.g. "/everything".
 * @param {Object} [params={}] - Query parameters to send with the request.
 *   Must not include `apiKey` — that is attached automatically by this
 *   helper. Any `undefined`/`null` values are stripped before sending.
 * @returns {Promise<Object>} The parsed, validated JSON response body
 *   (the full envelope, e.g. `{ status, articles, totalResults }` or
 *   `{ status, sources }`).
 * @throws {Error} If configuration is missing, the request fails, the
 *   response is not valid JSON, or the API reports a non-"ok" status.
 */
async function fetchEnvelope(endpoint, params = {}) {
    if (!endpoint) {
        throw buildProviderError({
            endpoint: endpoint || "(missing)",
            parameters: params,
            message: "An endpoint is required to make a request."
        });
    }

    const apiKey = config.newsapi && config.newsapi.apiKey;
    const baseUrl = config.newsapi && config.newsapi.baseUrl;

    if (!apiKey) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "Missing config.newsapi.apiKey. The NewsAPI.org API key must be configured."
        });
    }

    if (!baseUrl) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "Missing config.newsapi.baseUrl. The NewsAPI.org API base URL must be configured."
        });
    }

    const url = `${baseUrl.replace(/\/+$/, "")}${endpoint}`;

    const requestParams = cleanParams({
        ...params,
        apiKey
    });

    let httpResponse;

    try {
        httpResponse = await http.get(url, {
            provider: "newsapi",
            headers: {
                "Accept": "application/json"
            },
            params: requestParams
        });
    } catch (cause) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The request to the NewsAPI.org API failed.",
            cause
        });
    }

    if (!httpResponse) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The NewsAPI.org API returned an empty response."
        });
    }

    const body = httpResponse.data !== undefined ? httpResponse.data : httpResponse;

    if (typeof body !== "object" || body === null) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The NewsAPI.org API did not return valid JSON."
        });
    }

    if (body.status !== "ok") {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The NewsAPI.org API reported a non-\"ok\" status.",
            apiMessage: body.message || body.code || body.status
        });
    }

    return body;
}

/**
 * request
 *
 * Builds on `fetchEnvelope()` for the common case shared by every
 * article-returning endpoint ("/top-headlines" and "/everything"):
 * validating that the envelope contains an `articles` field, and returning
 * only the normalized payload the rest of the engine actually needs.
 *
 * @param {string} endpoint - The API endpoint to call, e.g. "/everything".
 * @param {Object} [params={}] - Query parameters to send with the request,
 *   in the same shape accepted by `fetchEnvelope()`.
 * @returns {Promise<Object>} A normalized payload of the form
 *   `{ articles, totalResults }`.
 * @throws {Error} If configuration is missing, the request fails, the
 *   response is not valid JSON, the API reports a non-"ok" status, or the
 *   envelope is missing the expected "articles" field.
 */
async function request(endpoint, params = {}) {
    const body = await fetchEnvelope(endpoint, params);

    if (!("articles" in body)) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The NewsAPI.org API response is missing the expected \"articles\" field.",
            apiMessage: body
        });
    }

    return {
        articles: body.articles,
        totalResults: body.totalResults !== undefined ? body.totalResults : null
    };
}

/**
 * getTopHeadlines
 *
 * Fetches the current top headlines, optionally filtered by country,
 * category, or a free-text query. This is the primary entry point for
 * pulling general breaking news relevant to upcoming or in-play fixtures.
 *
 * @param {Object} [options={}] - Optional filters.
 * @param {string} [options.query] - Free-text keyword search, e.g. a team
 *   or player name.
 * @param {string} [options.country] - Two-letter country code to filter
 *   results by.
 * @param {string} [options.category] - Category to filter by, e.g. "sports".
 * @param {number} [options.page] - Page number for paginated results.
 * @param {number} [options.pageSize] - Number of results to return per page.
 * @returns {Promise<Object>} A normalized payload of the form
 *   `{ articles, totalResults }`.
 * @throws {Error} If the request fails.
 */
async function getTopHeadlines(options = {}) {
    return request("/top-headlines", {
        q: options.query,
        country: options.country,
        category: options.category,
        page: options.page,
        pageSize: options.pageSize
    });
}

/**
 * searchEverything
 *
 * Searches the full NewsAPI.org article archive for a required keyword or
 * phrase, across all sources and dates the plan allows. This is meant for
 * targeted lookups (e.g. "Manchester United injury") rather than a curated
 * headlines feed.
 *
 * @param {string} keyword - The keyword or phrase to search for. Required.
 * @param {Object} [options={}] - Optional filters.
 * @param {string} [options.language="en"] - Two-letter language code to
 *   filter results by.
 * @param {string} [options.sortBy="publishedAt"] - How to sort results.
 *   One of "relevancy", "popularity", or "publishedAt".
 * @param {string} [options.fromDate] - Restrict results to articles
 *   published on or after this date, formatted "YYYY-MM-DD".
 * @param {string} [options.toDate] - Restrict results to articles
 *   published on or before this date, formatted "YYYY-MM-DD".
 * @param {number} [options.page] - Page number for paginated results.
 * @param {number} [options.pageSize] - Number of results to return per page.
 * @returns {Promise<Object>} A normalized payload of the form
 *   `{ articles, totalResults }` for the matching articles.
 * @throws {Error} If keyword is missing or the request fails.
 */
async function searchEverything(keyword, options = {}) {
    requireParam(keyword, "keyword");

    return request("/everything", {
        q: keyword,
        language: options.language || "en",
        sortBy: options.sortBy || "publishedAt",
        from: options.fromDate,
        to: options.toDate,
        page: options.page,
        pageSize: options.pageSize
    });
}

/**
 * getNewsBySource
 *
 * Fetches the latest headlines published by a specific, known NewsAPI.org
 * source identifier (e.g. "bbc-sport"). Used when the engine needs to
 * prioritize or restrict coverage to a trusted outlet.
 *
 * @param {string} sourceId - The NewsAPI.org source identifier. Required.
 * @param {Object} [options={}] - Optional filters.
 * @param {number} [options.page] - Page number for paginated results.
 * @param {number} [options.pageSize] - Number of results to return per page.
 * @returns {Promise<Object>} A normalized payload of the form
 *   `{ articles, totalResults }` for the requested source.
 * @throws {Error} If sourceId is missing or the request fails.
 */
async function getNewsBySource(sourceId, options = {}) {
    requireParam(sourceId, "sourceId");

    return request("/top-headlines", {
        sources: sourceId,
        page: options.page,
        pageSize: options.pageSize
    });
}

/**
 * getSources
 *
 * Fetches the list of news sources available through the NewsAPI.org API,
 * optionally filtered by category, language, or country. Used to populate
 * source filters or to validate a source identifier before calling
 * `getNewsBySource`.
 *
 * @param {Object} [options={}] - Optional filters.
 * @param {string} [options.category] - Category to filter by, e.g. "sports".
 * @param {string} [options.language] - Two-letter language code to filter by.
 * @param {string} [options.country] - Two-letter country code to filter by.
 * @returns {Promise<Object>} A normalized payload of the form
 *   `{ articles, totalResults }`, where `articles` holds the list of
 *   matching sources returned by the API.
 * @throws {Error} If the request fails.
 */
async function getSources(options = {}) {
    const endpoint = "/top-headlines/sources";

    const requestParams = {
        category: options.category,
        language: options.language,
        country: options.country
    };

    // The "sources" endpoint returns its list under a "sources" field
    // rather than "articles", so it goes through fetchEnvelope() directly
    // instead of request() — this reuses every piece of shared HTTP
    // mechanics (auth, headers, param cleaning, the HTTP call itself, JSON
    // validation) without duplicating any of it, and only adds the
    // field-specific validation this endpoint needs.
    const body = await fetchEnvelope(endpoint, requestParams);

    if (!("sources" in body)) {
        throw buildProviderError({
            endpoint,
            parameters: requestParams,
            message: "The NewsAPI.org API response is missing the expected \"sources\" field.",
            apiMessage: body
        });
    }

    return {
        articles: body.sources,
        totalResults: body.sources.length
    };
}

module.exports = {
    getTopHeadlines,
    searchEverything,
    getNewsBySource,
    getSources
};