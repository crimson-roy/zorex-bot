/**
 * gemini.js
 *
 * Provider module responsible for all communication with the Google
 * Gemini (Generative Language) API. Alongside `openrouter.js`, this
 * provider gives the Zorex Football Betting Engine a direct integration
 * with Gemini models for AI-assisted analysis, predictions, and summaries,
 * without routing through a third-party gateway.
 *
 * This module exists to isolate every HTTP call, every piece of response
 * validation, and every provider-specific error into a single place so that
 * the rest of the engine never has to know how the Gemini API is shaped,
 * authenticated against, or how it fails.
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
 * The Gemini API mixes GET endpoints (listing/describing models) and POST
 * endpoints (content generation, token counting), and — unlike
 * `openrouter.js` — authenticates via a `key` query parameter on every
 * request, GET or POST alike, rather than a header. `request()` reflects
 * both of those differences while keeping the same single-helper contract
 * used by every other provider.
 */

const config = require("../config");
const http = require("./httpClient");

/**
 * buildProviderError
 *
 * Builds a single, consistent Error object for every failure that can occur
 * while talking to the Gemini API. Centralizing error construction here
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
        `[gemini] ${message} (endpoint: "${endpoint}")`
    );

    error.provider = "gemini";
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
 * Removes every `undefined` and `null` value from an object before it is
 * sent as a query string or JSON body. This keeps every outgoing request
 * minimal and predictable, and avoids sending literal "undefined"/"null"
 * values for options the caller did not supply.
 *
 * @param {Object} params - The raw object to clean.
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
 * normalizeModelName
 *
 * Gemini model identifiers are sometimes passed around with a leading
 * "models/" prefix (as returned by `listModels()`) and sometimes without it
 * (as a caller would naturally type "gemini-1.5-flash"). This helper
 * normalizes either form down to the bare model name so endpoint paths can
 * be built consistently regardless of which form the caller supplied.
 *
 * @param {string} modelName - The model name, with or without a leading
 *   "models/" prefix.
 * @returns {string} The bare model name, without the "models/" prefix.
 */
function normalizeModelName(modelName) {
    return modelName.startsWith("models/") ? modelName.slice("models/".length) : modelName;
}

/**
 * request
 *
 * The single private helper responsible for every network call this
 * provider makes. Every exported function in this file must route its
 * network access through this helper — nothing else in this module is
 * allowed to call `http.get` or `http.post` directly.
 *
 * Responsibilities:
 *   - Build the full request URL from the configured base URL and endpoint.
 *   - Attach authentication (the `key` query parameter) required by the
 *     Gemini API, on both GET and POST requests.
 *   - Attach the headers the API expects.
 *   - Clean the outgoing parameters/body, removing any `undefined`/`null`
 *     values before they are sent.
 *   - Call `http.get(...)` or `http.post(...)` on the shared httpClient
 *     depending on `method`, tagging the call with `provider: "gemini"` so
 *     retries, logging, and HttpClientError metadata correctly identify
 *     which provider the request belongs to.
 *   - Validate that the response is well-formed JSON.
 *   - Throw descriptive, provider-specific errors on any failure.
 *   - Return only the parsed response payload, never the raw HTTP object.
 *
 * @param {string} endpoint - The API endpoint to call, e.g.
 *   "/models/gemini-1.5-flash:generateContent".
 * @param {Object} [options={}] - Request options.
 * @param {string} [options.method="GET"] - The HTTP method to use, either
 *   "GET" or "POST".
 * @param {Object} [options.params={}] - Extra query parameters. Any
 *   `undefined`/`null` values are stripped before sending.
 * @param {Object} [options.body={}] - JSON body, used for POST requests.
 *   Any `undefined`/`null` values are stripped before sending.
 * @returns {Promise<Object>} The parsed and validated API response payload.
 * @throws {Error} If configuration is missing, the request fails, the
 *   response is not valid JSON, or the API returns an error payload.
 */
async function request(endpoint, { method = "GET", params = {}, body = {} } = {}) {
    if (!endpoint) {
        throw buildProviderError({
            endpoint: endpoint || "(missing)",
            parameters: method === "POST" ? body : params,
            message: "An endpoint is required to make a request."
        });
    }

    const apiKey = config.gemini && config.gemini.apiKey;
    const baseUrl = config.gemini && config.gemini.baseUrl;
    const requestedParameters = method === "POST" ? body : params;

    if (!apiKey) {
        throw buildProviderError({
            endpoint,
            parameters: requestedParameters,
            message: "Missing config.gemini.apiKey. The Gemini API key must be configured."
        });
    }

    if (!baseUrl) {
        throw buildProviderError({
            endpoint,
            parameters: requestedParameters,
            message: "Missing config.gemini.baseUrl. The Gemini API base URL must be configured."
        });
    }

    const url = `${baseUrl.replace(/\/+$/, "")}${endpoint}`;

    // Gemini authenticates every request, GET or POST, via a "key" query
    // parameter — it is never sent in the body, even for POST calls.
    const queryParams = cleanParams({ ...params, key: apiKey });

    let httpResponse;

    try {
        if (method === "POST") {
            httpResponse = await http.post(url, cleanParams(body), {
                provider: "gemini",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                params: queryParams
            });
        } else {
            httpResponse = await http.get(url, {
                provider: "gemini",
                headers: {
                    "Accept": "application/json"
                },
                params: queryParams
            });
        }
    } catch (cause) {
        throw buildProviderError({
            endpoint,
            parameters: requestedParameters,
            message: "The request to the Gemini API failed.",
            cause
        });
    }

    if (!httpResponse) {
        throw buildProviderError({
            endpoint,
            parameters: requestedParameters,
            message: "The Gemini API returned an empty response."
        });
    }

    const parsed = httpResponse.data !== undefined ? httpResponse.data : httpResponse;

    if (typeof parsed !== "object" || parsed === null) {
        throw buildProviderError({
            endpoint,
            parameters: requestedParameters,
            message: "The Gemini API did not return valid JSON."
        });
    }

    if (parsed.error) {
        throw buildProviderError({
            endpoint,
            parameters: requestedParameters,
            message: "The Gemini API returned an error.",
            apiMessage: parsed.error.message || parsed.error
        });
    }

    return parsed;
}

/**
 * listModels
 *
 * Fetches the full list of Gemini models available to the configured API
 * key, including their supported generation methods and token limits.
 * Used to populate model selection options or to validate a model name
 * before using it in a generation request.
 *
 * @returns {Promise<Array<Object>>} An array of available model descriptors.
 * @throws {Error} If the request fails or the response is missing the
 *   expected model list.
 */
async function listModels() {
    const response = await request("/models");

    if (!Array.isArray(response.models)) {
        throw buildProviderError({
            endpoint: "/models",
            parameters: {},
            message: "The Gemini API response is missing the expected \"models\" array."
        });
    }

    return response.models;
}

/**
 * getModel
 *
 * Fetches the details of a single Gemini model by name.
 *
 * @param {string} modelName - The model name, e.g. "gemini-1.5-flash",
 *   with or without a leading "models/" prefix. Required.
 * @returns {Promise<Object>} The parsed details of the requested model.
 * @throws {Error} If modelName is missing or the request fails.
 */
async function getModel(modelName) {
    requireParam(modelName, "modelName");

    return request(`/models/${normalizeModelName(modelName)}`);
}

/**
 * generateContent
 *
 * Sends a single-turn text generation request to a Gemini model and
 * returns the raw generation response. This is the low-level building
 * block every other content-generation helper in this file is built on
 * top of — use it when the caller needs full control over the request
 * body (safety settings, generation config, multi-part content, etc.).
 *
 * @param {string} modelName - The Gemini model name to use, e.g.
 *   "gemini-1.5-flash". Required.
 * @param {string} prompt - The prompt text to send. Required.
 * @param {Object} [options={}] - Optional generation parameters.
 * @param {number} [options.temperature] - Sampling temperature.
 * @param {number} [options.maxOutputTokens] - Maximum number of tokens to
 *   generate.
 * @param {number} [options.topP] - Nucleus sampling parameter.
 * @param {number} [options.topK] - Top-k sampling parameter.
 * @returns {Promise<Object>} The parsed Gemini generateContent response.
 * @throws {Error} If modelName or prompt is missing, the request fails, or
 *   the response does not contain the expected "candidates" field.
 */
async function generateContent(modelName, prompt, options = {}) {
    requireParam(modelName, "modelName");
    requireParam(prompt, "prompt");

    const response = await request(`/models/${normalizeModelName(modelName)}:generateContent`, {
        method: "POST",
        body: {
            contents: [
                {
                    role: "user",
                    parts: [{ text: prompt }]
                }
            ],
            generationConfig: cleanParams({
                temperature: options.temperature,
                maxOutputTokens: options.maxOutputTokens,
                topP: options.topP,
                topK: options.topK
            })
        }
    });

    if (!Array.isArray(response.candidates) || response.candidates.length === 0) {
        throw buildProviderError({
            endpoint: `/models/${normalizeModelName(modelName)}:generateContent`,
            parameters: { modelName },
            message: "The Gemini API response is missing the expected \"candidates\" field."
        });
    }

    return response;
}

/**
 * generateText
 *
 * Convenience wrapper around `generateContent` for the common case of a
 * single-turn prompt: returns just the generated text content rather than
 * the full generation envelope. Used throughout the engine for quick
 * summaries and analysis snippets where the caller does not need access to
 * safety ratings or finish-reason metadata.
 *
 * @param {string} modelName - The Gemini model name to use, e.g.
 *   "gemini-1.5-flash". Required.
 * @param {string} prompt - The prompt text to send. Required.
 * @param {Object} [options={}] - Optional generation parameters, in the
 *   same shape accepted by `generateContent`.
 * @returns {Promise<string>} The generated text content of the first
 *   candidate.
 * @throws {Error} If modelName or prompt is missing, the request fails, or
 *   the response does not contain usable text content.
 */
async function generateText(modelName, prompt, options = {}) {
    requireParam(modelName, "modelName");
    requireParam(prompt, "prompt");

    const response = await generateContent(modelName, prompt, options);
    const candidate = response.candidates[0];
    const parts = candidate.content && candidate.content.parts;
    const text = Array.isArray(parts) ? parts.map((part) => part.text).join("") : null;

    if (!text) {
        throw buildProviderError({
            endpoint: `/models/${normalizeModelName(modelName)}:generateContent`,
            parameters: { modelName },
            message: "The Gemini API candidate did not contain any usable text content."
        });
    }

    return text;
}

/**
 * generateChatContent
 *
 * Sends a multi-turn conversation to a Gemini model and returns just the
 * generated reply text. Used when the caller needs to preserve back-and-
 * forth conversation history (e.g. iterative refinement of an analysis)
 * rather than a single isolated prompt.
 *
 * @param {string} modelName - The Gemini model name to use, e.g.
 *   "gemini-1.5-flash". Required.
 * @param {Array<Object>} messages - The conversation history to send, each
 *   entry shaped like `{ role: "user"|"model", content: string }`.
 *   Required, must be a non-empty array.
 * @param {Object} [options={}] - Optional generation parameters, in the
 *   same shape accepted by `generateContent`.
 * @returns {Promise<string>} The generated reply text.
 * @throws {Error} If modelName or messages is missing/invalid, the request
 *   fails, or the response does not contain usable text content.
 */
async function generateChatContent(modelName, messages, options = {}) {
    requireParam(modelName, "modelName");
    requireParam(messages, "messages");

    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("messages must be a non-empty array of conversation turns.");
    }

    const contents = messages.map((message) => ({
        role: message.role,
        parts: [{ text: message.content }]
    }));

    const response = await request(`/models/${normalizeModelName(modelName)}:generateContent`, {
        method: "POST",
        body: {
            contents,
            generationConfig: cleanParams({
                temperature: options.temperature,
                maxOutputTokens: options.maxOutputTokens,
                topP: options.topP,
                topK: options.topK
            })
        }
    });

    if (!Array.isArray(response.candidates) || response.candidates.length === 0) {
        throw buildProviderError({
            endpoint: `/models/${normalizeModelName(modelName)}:generateContent`,
            parameters: { modelName },
            message: "The Gemini API response is missing the expected \"candidates\" field."
        });
    }

    const candidate = response.candidates[0];
    const parts = candidate.content && candidate.content.parts;
    const text = Array.isArray(parts) ? parts.map((part) => part.text).join("") : null;

    if (!text) {
        throw buildProviderError({
            endpoint: `/models/${normalizeModelName(modelName)}:generateContent`,
            parameters: { modelName },
            message: "The Gemini API candidate did not contain any usable text content."
        });
    }

    return text;
}

/**
 * countTokens
 *
 * Counts the number of tokens a given prompt would consume for a specific
 * Gemini model, without performing an actual generation. Used for cost
 * estimation and for staying within a model's context window before
 * sending a full generation request.
 *
 * @param {string} modelName - The Gemini model name to use, e.g.
 *   "gemini-1.5-flash". Required.
 * @param {string} prompt - The prompt text to count tokens for. Required.
 * @returns {Promise<number>} The total number of tokens the prompt would
 *   consume.
 * @throws {Error} If modelName or prompt is missing, the request fails, or
 *   the response does not contain a token count.
 */
async function countTokens(modelName, prompt) {
    requireParam(modelName, "modelName");
    requireParam(prompt, "prompt");

    const response = await request(`/models/${normalizeModelName(modelName)}:countTokens`, {
        method: "POST",
        body: {
            contents: [
                {
                    role: "user",
                    parts: [{ text: prompt }]
                }
            ]
        }
    });

    if (typeof response.totalTokens !== "number") {
        throw buildProviderError({
            endpoint: `/models/${normalizeModelName(modelName)}:countTokens`,
            parameters: { modelName },
            message: "The Gemini API response is missing the expected \"totalTokens\" field."
        });
    }

    return response.totalTokens;
}

module.exports = {
    listModels,
    getModel,
    generateContent,
    generateText,
    generateChatContent,
    countTokens
};