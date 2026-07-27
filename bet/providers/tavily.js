/**
 * tavily.js
 *
 * Provider module responsible for all communication with the Tavily Search
 * API. Tavily is used across the Zorex Football Betting Engine to pull
 * fresh, real-time web context (team news, injury reports, press
 * conferences, transfer rumours, etc.) that is not available from the
 * structured football data providers.
 *
 * This module exists to isolate every HTTP call, every piece of response
 * validation, and every provider-specific error into a single place so that
 * the rest of the engine never has to know how the Tavily API is shaped,
 * authenticated against, or how it fails.
 *
 * Every exported function follows the same contract:
 *   1. Validate its own input parameters and fail loudly if they are wrong.
 *   2. Delegate the actual network call to the private `request()` helper.
 *   3. Return only the parsed, validated data the caller actually needs.
 *
 * No exported function contains its own HTTP logic. All HTTP logic lives in
 * `request()` so there is exactly one place where authentication, headers,
 * request bodies, and response validation happen.
 *
 * Unlike `apiFootball.js` and `footballOdds.js`, the Tavily API is a
 * POST-based JSON API rather than a query-string GET API — every Tavily
 * endpoint expects the API key and search parameters inside a JSON request
 * body, not as query parameters. `request()` reflects that difference, but
 * keeps the same shape and guarantees as the other providers.
 */

const config = require("../config");
const http = require("./httpClient");

/**
 * buildProviderError
 *
 * Builds a single, consistent Error object for every failure that can occur
 * while talking to the Tavily API. Centralizing error construction here
 * means every thrown error carries the same shape, which makes debugging
 * and upstream error handling predictable.
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
        `[tavily] ${message} (endpoint: "${endpoint}")`
    );

    error.provider = "tavily";
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
 * request
 *
 * The single private helper responsible for every network call this
 * provider makes. Every exported function in this file must route its
 * network access through this helper — nothing else in this module is
 * allowed to call `http.post` directly.
 *
 * Responsibilities:
 *   - Build the full request URL from the configured base URL and endpoint.
 *   - Attach authentication (API key) required by the Tavily API. Tavily
 *     expects the key inside the JSON request body, so it is merged into
 *     the body here rather than sent as a header or query parameter.
 *   - Attach the headers Tavily expects (JSON content type).
 *   - Perform the HTTP POST request via the shared httpClient.
 *   - Validate that the response is well-formed JSON.
 *   - Throw descriptive, provider-specific errors on any failure.
 *   - Return only the parsed response body, never the raw HTTP object.
 *
 * @param {string} endpoint - The API endpoint to call, e.g. "/search".
 * @param {Object} [body={}] - The JSON body to send with the request. Must
 *   not include `api_key` — that is attached automatically by this helper.
 * @returns {Promise<Object>} The parsed and validated API response payload.
 * @throws {Error} If configuration is missing, the request fails, or the
 *   response is not valid JSON.
 */
async function request(endpoint, body = {}) {
    if (!endpoint) {
        throw buildProviderError({
            endpoint: endpoint || "(missing)",
            parameters: body,
            message: "An endpoint is required to make a request."
        });
    }

    const apiKey = config.tavily && config.tavily.apiKey;
    const baseUrl = config.tavily && config.tavily.baseUrl;

    if (!apiKey) {
        throw buildProviderError({
            endpoint,
            parameters: body,
            message: "Missing config.tavily.apiKey. The Tavily API key must be configured."
        });
    }

    if (!baseUrl) {
        throw buildProviderError({
            endpoint,
            parameters: body,
            message: "Missing config.tavily.baseUrl. The Tavily API base URL must be configured."
        });
    }

    const url = `${baseUrl.replace(/\/+$/, "")}${endpoint}`;

    const requestBody = {
        ...body,
        api_key: apiKey
    };

    let httpResponse;

    try {
        httpResponse = await http.post(url, requestBody, {
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            }
        });
    } catch (cause) {
        throw buildProviderError({
            endpoint,
            parameters: body,
            message: "The request to the Tavily API failed.",
            cause
        });
    }

    if (!httpResponse) {
        throw buildProviderError({
            endpoint,
            parameters: body,
            message: "The Tavily API returned an empty response."
        });
    }

    const parsed = httpResponse.data !== undefined ? httpResponse.data : httpResponse;

    if (typeof parsed !== "object" || parsed === null) {
        throw buildProviderError({
            endpoint,
            parameters: body,
            message: "The Tavily API did not return valid JSON."
        });
    }

    if (parsed.error) {
        throw buildProviderError({
            endpoint,
            parameters: body,
            message: "The Tavily API returned an error.",
            apiMessage: parsed.error
        });
    }

    if (parsed.detail) {
        // Tavily returns a "detail" field (rather than "error") for many
        // validation and authentication failures, so it must be checked
        // separately from the generic "error" field above.
        throw buildProviderError({
            endpoint,
            parameters: body,
            message: "The Tavily API rejected the request.",
            apiMessage: parsed.detail
        });
    }

    return parsed;
}

/**
 * search
 *
 * Performs a general-purpose Tavily web search for the given query. This is
 * the core building block every other search-related function in this file
 * is built on top of.
 *
 * @param {string} query - The search query text. Required.
 * @param {Object} [options={}] - Optional Tavily search parameters.
 * @param {string} [options.searchDepth="basic"] - Either "basic" or
 *   "advanced". "advanced" performs a deeper, slower, more thorough search.
 * @param {string} [options.topic="general"] - Either "general" or "news".
 *   Use "news" to bias results toward recent news coverage.
 * @param {number} [options.maxResults=5] - Maximum number of results to return.
 * @param {boolean} [options.includeAnswer=false] - Whether Tavily should
 *   generate a short, direct answer summarizing the search results.
 * @param {Array<string>} [options.includeDomains] - Domains to restrict
 *   results to.
 * @param {Array<string>} [options.excludeDomains] - Domains to exclude
 *   from results.
 * @returns {Promise<Object>} The parsed Tavily search response, containing
 *   the results array and, if requested, a generated answer.
 * @throws {Error} If query is missing or the request fails.
 */
async function search(query, options = {}) {
    requireParam(query, "query");

    return request("/search", {
        query,
        search_depth: options.searchDepth || "basic",
        topic: options.topic || "general",
        max_results: options.maxResults || 5,
        include_answer: options.includeAnswer || false,
        include_domains: options.includeDomains || [],
        exclude_domains: options.excludeDomains || []
    });
}

/**
 * searchNews
 *
 * Performs a Tavily search biased toward recent news coverage. This is a
 * thin, purpose-built wrapper around `search()` for the common case of
 * wanting football news (injuries, lineups, press conferences) rather than
 * general web results.
 *
 * @param {string} query - The news search query text. Required.
 * @param {Object} [options={}] - Optional Tavily search parameters, in the
 *   same shape accepted by `search()`. The `topic` option is always forced
 *   to "news" regardless of what is passed here.
 * @returns {Promise<Object>} The parsed Tavily search response, biased
 *   toward news results.
 * @throws {Error} If query is missing or the request fails.
 */
async function searchNews(query, options = {}) {
    requireParam(query, "query");

    return search(query, {
        ...options,
        topic: "news"
    });
}

/**
 * getSearchContext
 *
 * Fetches search results for a query and returns them formatted as a
 * single context string, ready to be dropped into an LLM prompt. This is
 * used when the engine needs to ground an AI-generated prediction or
 * analysis with real, current web context rather than the model's own
 * training data.
 *
 * @param {string} query - The search query text. Required.
 * @param {Object} [options={}] - Optional Tavily search parameters, in the
 *   same shape accepted by `search()`.
 * @param {number} [options.maxTokens=4000] - The approximate maximum number
 *   of tokens the returned context string should contain.
 * @returns {Promise<string>} A single string of concatenated, context-ready
 *   search content.
 * @throws {Error} If query is missing, the request fails, or the response
 *   does not contain a context string.
 */
async function getSearchContext(query, options = {}) {
    requireParam(query, "query");

    const response = await request("/search", {
        query,
        search_depth: options.searchDepth || "basic",
        topic: options.topic || "general",
        max_results: options.maxResults || 5,
        include_domains: options.includeDomains || [],
        exclude_domains: options.excludeDomains || [],
        max_tokens: options.maxTokens || 4000
    });

    if (!Array.isArray(response.results)) {
        throw buildProviderError({
            endpoint: "/search",
            parameters: { query },
            message: "The Tavily API response is missing the expected \"results\" array needed to build search context."
        });
    }

    return response.results
        .map((result) => `${result.title}\n${result.content}`)
        .join("\n\n");
}

/**
 * answerQuestion
 *
 * Asks Tavily a direct question and returns its generated short answer,
 * rather than a list of raw search results. Useful for quick factual
 * lookups (e.g. "who won the last match between Team A and Team B") where
 * a single answer is more useful than a results list.
 *
 * @param {string} question - The question to ask. Required.
 * @returns {Promise<string>} The generated answer text.
 * @throws {Error} If question is missing, the request fails, or the
 *   response does not contain an answer.
 */
async function answerQuestion(question) {
    requireParam(question, "question");

    const response = await request("/search", {
        query: question,
        search_depth: "advanced",
        include_answer: true,
        max_results: 5
    });

    if (!response.answer) {
        throw buildProviderError({
            endpoint: "/search",
            parameters: { query: question },
            message: "The Tavily API did not return a direct answer for this question."
        });
    }

    return response.answer;
}

/**
 * extractContent
 *
 * Extracts the full, cleaned text content of one or more URLs. This is
 * used when a search result is relevant enough that the engine needs the
 * complete article content rather than the short snippet returned by
 * `search()`.
 *
 * @param {Array<string>|string} urls - A single URL string or an array of
 *   URL strings to extract content from. Required.
 * @returns {Promise<Array<Object>>} An array of extraction results, one per
 *   URL, each containing the URL and its extracted raw content.
 * @throws {Error} If urls is missing, empty, or the request fails.
 */
async function extractContent(urls) {
    requireParam(urls, "urls");

    const urlList = Array.isArray(urls) ? urls : [urls];

    if (urlList.length === 0) {
        throw new Error("urls must contain at least one URL.");
    }

    const response = await request("/extract", { urls: urlList });

    if (!Array.isArray(response.results)) {
        throw buildProviderError({
            endpoint: "/extract",
            parameters: { urls: urlList },
            message: "The Tavily API response is missing the expected \"results\" array."
        });
    }

    return response.results;
}

module.exports = {
    search,
    searchNews,
    getSearchContext,
    answerQuestion,
    extractContent
};