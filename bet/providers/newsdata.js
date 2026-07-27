/**
 * newsdata.js
 *
 * Provider module responsible for all communication with the NewsData.io
 * API. This provider is used across the Zorex Football Betting Engine to
 * pull structured, categorized news articles (sports headlines, breaking
 * news, source-specific coverage) that complement the raw web search
 * results returned by `tavily.js`.
 *
 * This module exists to isolate every HTTP call, every piece of response
 * validation, and every provider-specific error into a single place so that
 * the rest of the engine never has to know how the NewsData.io API is
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
 * The NewsData.io API is a GET-based, query-string API (like
 * `apiFootball.js` and `footballOdds.js`), authenticated via an `apikey`
 * query parameter rather than a header. `request()` reflects that.
 */

const config = require("../config");
const http = require("./httpClient");

/**
 * buildProviderError
 *
 * Builds a single, consistent Error object for every failure that can occur
 * while talking to the NewsData.io API. Centralizing error construction
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
        `[newsdata] ${message} (endpoint: "${endpoint}")`
    );

    error.provider = "newsdata";
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
 * did not supply them (e.g. `country: options.country`); without cleaning,
 * those would be serialized as literal "undefined"/"null" query values and
 * sent straight through to the NewsData.io API. This keeps every outgoing
 * request minimal and predictable.
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
 * request
 *
 * The single private helper responsible for every network call this
 * provider makes. Every exported function in this file must route its
 * network access through this helper — nothing else in this module is
 * allowed to call `http.get` directly.
 *
 * Responsibilities:
 *   - Build the full request URL from the configured base URL and endpoint.
 *   - Attach authentication (the `apikey` query parameter) required by the
 *     NewsData.io API.
 *   - Attach the headers the API expects.
 *   - Clean the outgoing query parameters, removing any `undefined`/`null`
 *     values before they are sent.
 *   - Call `http.get(...)` on the shared httpClient, tagging the call with
 *     `provider: "newsdata"` so retries, logging, and HttpClientError
 *     metadata correctly identify which provider the request belongs to.
 *   - Validate that the response is well-formed JSON and reports success.
 *   - Throw descriptive, provider-specific errors on any failure.
 *   - Return only the parsed payload — normalized down to the article
 *     results plus pagination metadata — never the raw envelope or the raw
 *     HTTP response object.
 *
 * @param {string} endpoint - The API endpoint to call, e.g. "/news".
 * @param {Object} [params={}] - Query parameters to send with the request.
 *   Must not include `apikey` — that is attached automatically by this
 *   helper. Any `undefined`/`null` values are stripped before sending.
 * @returns {Promise<Object>} A normalized payload of the form
 *   `{ results, nextPage, totalResults }`, where `results` is the array of
 *   articles/sources returned by the API.
 * @throws {Error} If configuration is missing, the request fails, the
 *   response is not valid JSON, or the API reports a non-success status.
 */
async function request(endpoint, params = {}) {
    if (!endpoint) {
        throw buildProviderError({
            endpoint: endpoint || "(missing)",
            parameters: params,
            message: "An endpoint is required to make a request."
        });
    }

    const apiKey = config.newsdata && config.newsdata.apiKey;
    const baseUrl = config.newsdata && config.newsdata.baseUrl;

    if (!apiKey) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "Missing config.newsdata.apiKey. The NewsData.io API key must be configured."
        });
    }

    if (!baseUrl) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "Missing config.newsdata.baseUrl. The NewsData.io API base URL must be configured."
        });
    }

    const url = `${baseUrl.replace(/\/+$/, "")}${endpoint}`;

    const requestParams = cleanParams({
        ...params,
        apikey: apiKey
    });

    let httpResponse;

    try {
        httpResponse = await http.get(url, {
            provider: "newsdata",
            headers: {
                "Accept": "application/json"
            },
            params: requestParams
        });
    } catch (cause) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The request to the NewsData.io API failed.",
            cause
        });
    }

    if (!httpResponse) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The NewsData.io API returned an empty response."
        });
    }

    const body = httpResponse.data !== undefined ? httpResponse.data : httpResponse;

    if (typeof body !== "object" || body === null) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The NewsData.io API did not return valid JSON."
        });
    }

    if (body.status !== "success") {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The NewsData.io API reported a non-success status.",
            apiMessage: body.results || body.message || body.status
        });
    }

    if (!("results" in body)) {
        throw buildProviderError({
            endpoint,
            parameters: params,
            message: "The NewsData.io API response is missing the expected \"results\" field.",
            apiMessage: body
        });
    }

    return {
        results: body.results,
        nextPage: body.nextPage !== undefined ? body.nextPage : null,
        totalResults: body.totalResults !== undefined ? body.totalResults : null
    };
}

/**
 * getLatestNews
 *
 * Fetches the most recent news articles, optionally filtered by a free-text
 * query. This is the primary entry point for pulling general breaking news
 * relevant to upcoming or in-play fixtures.
 *
 * @param {Object} [options={}] - Optional filters.
 * @param {string} [options.query] - Free-text keyword search, e.g. a team
 *   or player name.
 * @param {string} [options.language="en"] - Two-letter language code to
 *   filter results by.
 * @param {string} [options.country] - Two-letter country code to filter
 *   results by.
 * @param {number} [options.page] - Pagination token returned by a previous
 *   call, used to fetch the next page of results.
 * @returns {Promise<Object>} A normalized payload of the form
 *   `{ results, nextPage, totalResults }`.
 * @throws {Error} If the request fails.
 */
async function getLatestNews(options = {}) {
    return request("/news", {
        q: options.query,
        language: options.language || "en",
        country: options.country,
        page: options.page
    });
}

/**
 * searchNewsByKeyword
 *
 * Searches news articles for a specific, required keyword or phrase. This
 * differs from `getLatestNews` in that a query is mandatory here — it is
 * meant for targeted lookups (e.g. "Manchester United injury") rather than
 * a general news feed.
 *
 * @param {string} keyword - The keyword or phrase to search for. Required.
 * @param {Object} [options={}] - Optional filters, in the same shape
 *   accepted by `getLatestNews` (excluding `query`).
 * @returns {Promise<Object>} A normalized payload of the form
 *   `{ results, nextPage, totalResults }` for the matching articles.
 * @throws {Error} If keyword is missing or the request fails.
 */
async function searchNewsByKeyword(keyword, options = {}) {
    requireParam(keyword, "keyword");

    return request("/news", {
        q: keyword,
        language: options.language || "en",
        country: options.country,
        page: options.page
    });
}

/**
 * getNewsByCategory
 *
 * Fetches the latest news articles within a specific category (e.g.
 * "sports"). Used to build category-specific feeds without relying on a
 * free-text keyword match.
 *
 * @param {string} category - The category to filter by, e.g. "sports".
 *   Required.
 * @param {Object} [options={}] - Optional filters, in the same shape
 *   accepted by `getLatestNews`.
 * @returns {Promise<Object>} A normalized payload of the form
 *   `{ results, nextPage, totalResults }` for the requested category.
 * @throws {Error} If category is missing or the request fails.
 */
async function getNewsByCategory(category, options = {}) {
    requireParam(category, "category");

    return request("/news", {
        category,
        language: options.language || "en",
        country: options.country,
        page: options.page
    });
}

/**
 * getNewsBySource
 *
 * Fetches the latest news articles published by a specific source (e.g.
 * "bbc-sport"). Used when the engine needs to prioritize or restrict
 * coverage to a trusted outlet.
 *
 * @param {string} sourceId - The NewsData.io source identifier. Required.
 * @param {Object} [options={}] - Optional filters, in the same shape
 *   accepted by `getLatestNews`.
 * @returns {Promise<Object>} A normalized payload of the form
 *   `{ results, nextPage, totalResults }` for the requested source.
 * @throws {Error} If sourceId is missing or the request fails.
 */
async function getNewsBySource(sourceId, options = {}) {
    requireParam(sourceId, "sourceId");

    return request("/news", {
        domain: sourceId,
        language: options.language || "en",
        page: options.page
    });
}

/**
 * getArchivedNews
 *
 * Fetches historical news articles published within a specific date range.
 * Used for building context around events that happened further in the
 * past than the "latest news" endpoint covers (e.g. reviewing coverage of
 * a team's form over the last month).
 *
 * @param {string} fromDate - The start date of the range, formatted
 *   "YYYY-MM-DD". Required.
 * @param {string} toDate - The end date of the range, formatted
 *   "YYYY-MM-DD". Required.
 * @param {Object} [options={}] - Optional filters.
 * @param {string} [options.query] - Free-text keyword search.
 * @param {string} [options.language="en"] - Two-letter language code to
 *   filter results by.
 * @param {number} [options.page] - Pagination token for subsequent pages.
 * @returns {Promise<Object>} A normalized payload of the form
 *   `{ results, nextPage, totalResults }` for the requested date range.
 * @throws {Error} If fromDate or toDate is missing or the request fails.
 */
async function getArchivedNews(fromDate, toDate, options = {}) {
    requireParam(fromDate, "fromDate");
    requireParam(toDate, "toDate");

    return request("/archive", {
        q: options.query,
        from_date: fromDate,
        to_date: toDate,
        language: options.language || "en",
        page: options.page
    });
}

/**
 * getSources
 *
 * Fetches the list of news sources available through the NewsData.io API,
 * optionally filtered by country, language, or category. Used to populate
 * source filters or to validate a source identifier before calling
 * `getNewsBySource`.
 *
 * @param {Object} [options={}] - Optional filters.
 * @param {string} [options.country] - Two-letter country code to filter by.
 * @param {string} [options.language] - Two-letter language code to filter by.
 * @param {string} [options.category] - Category to filter by, e.g. "sports".
 * @returns {Promise<Object>} A normalized payload of the form
 *   `{ results, nextPage, totalResults }` containing the list of matching
 *   sources.
 * @throws {Error} If the request fails.
 */
async function getSources(options = {}) {
    return request("/sources", {
        country: options.country,
        language: options.language,
        category: options.category
    });
}

module.exports = {
    getLatestNews,
    searchNewsByKeyword,
    getNewsByCategory,
    getNewsBySource,
    getArchivedNews,
    getSources
};