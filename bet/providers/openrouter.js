/**
 * openrouter.js
 *
 * Provider module responsible for all communication with the OpenRouter
 * API. OpenRouter is a unified gateway to many large language models, and
 * is used across the Zorex Football Betting Engine to generate AI-assisted
 * analysis, predictions, and summaries once the underlying football data,
 * odds, and news context have been gathered from the other providers.
 *
 * This module exists to isolate every HTTP call, every piece of response
 * validation, and every provider-specific error into a single place so that
 * the rest of the engine never has to know how the OpenRouter API is
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
 * Unlike the earlier GET-based providers, OpenRouter's API mixes both GET
 * endpoints (listing models) and POST endpoints (chat completions).
 * `request()` accepts an HTTP method so both cases share the exact same
 * authentication, header, and validation logic, rather than duplicating
 * that logic once per method.
 */

const config = require("../config");
const http = require("./httpClient");

/**
 * buildProviderError
 *
 * Builds a single, consistent Error object for every failure that can occur
 * while talking to the OpenRouter API. Centralizing error construction
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
        `[openrouter] ${message} (endpoint: "${endpoint}")`
    );

    error.provider = "openrouter";
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
 * request
 *
 * The single private helper responsible for every network call this
 * provider makes. Every exported function in this file must route its
 * network access through this helper — nothing else in this module is
 * allowed to call `http.get` or `http.post` directly.
 *
 * Responsibilities:
 *   - Build the full request URL from the configured base URL and endpoint.
 *   - Attach authentication (a Bearer token) required by the OpenRouter API.
 *   - Attach the headers the API expects.
 *   - Clean the outgoing parameters/body, removing any `undefined`/`null`
 *     values before they are sent.
 *   - Call `http.get(...)` or `http.post(...)` on the shared httpClient
 *     depending on `method`, tagging the call with `provider: "openrouter"`
 *     so retries, logging, and HttpClientError metadata correctly identify
 *     which provider the request belongs to.
 *   - Validate that the response is well-formed JSON.
 *   - Throw descriptive, provider-specific errors on any failure.
 *   - Return only the parsed response payload, never the raw HTTP object.
 *
 * @param {string} endpoint - The API endpoint to call, e.g. "/chat/completions".
 * @param {Object} [options={}] - Request options.
 * @param {string} [options.method="GET"] - The HTTP method to use, either
 *   "GET" or "POST".
 * @param {Object} [options.params={}] - Query parameters, used for GET
 *   requests. Any `undefined`/`null` values are stripped before sending.
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

    const apiKey = config.openrouter && config.openrouter.apiKey;
    const baseUrl = config.openrouter && config.openrouter.baseUrl;
    const requestedParameters = method === "POST" ? body : params;

    if (!apiKey) {
        throw buildProviderError({
            endpoint,
            parameters: requestedParameters,
            message: "Missing config.openrouter.apiKey. The OpenRouter API key must be configured."
        });
    }

    if (!baseUrl) {
        throw buildProviderError({
            endpoint,
            parameters: requestedParameters,
            message: "Missing config.openrouter.baseUrl. The OpenRouter API base URL must be configured."
        });
    }

    const url = `${baseUrl.replace(/\/+$/, "")}${endpoint}`;

    const headers = {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
    };

    let httpResponse;

    try {
        if (method === "POST") {
            httpResponse = await http.post(url, cleanParams(body), {
                provider: "openrouter",
                headers
            });
        } else {
            httpResponse = await http.get(url, {
                provider: "openrouter",
                headers,
                params: cleanParams(params)
            });
        }
    } catch (cause) {
        throw buildProviderError({
            endpoint,
            parameters: requestedParameters,
            message: "The request to the OpenRouter API failed.",
            cause
        });
    }

    if (!httpResponse) {
        throw buildProviderError({
            endpoint,
            parameters: requestedParameters,
            message: "The OpenRouter API returned an empty response."
        });
    }

    const parsed = httpResponse.data !== undefined ? httpResponse.data : httpResponse;

    if (typeof parsed !== "object" || parsed === null) {
        throw buildProviderError({
            endpoint,
            parameters: requestedParameters,
            message: "The OpenRouter API did not return valid JSON."
        });
    }

    if (parsed.error) {
        throw buildProviderError({
            endpoint,
            parameters: requestedParameters,
            message: "The OpenRouter API returned an error.",
            apiMessage: parsed.error.message || parsed.error
        });
    }

    return parsed;
}

/**
 * listModels
 *
 * Fetches the full list of models available through OpenRouter, including
 * their identifiers, context lengths, and pricing. Used to populate model
 * selection options or to validate a model id before using it in a
 * completion request.
 *
 * @returns {Promise<Array<Object>>} An array of available model descriptors.
 * @throws {Error} If the request fails or the response is missing the
 *   expected model list.
 */
async function listModels() {
    const response = await request("/models");

    if (!Array.isArray(response.data)) {
        throw buildProviderError({
            endpoint: "/models",
            parameters: {},
            message: "The OpenRouter API response is missing the expected \"data\" array of models."
        });
    }

    return response.data;
}

/**
 * getModel
 *
 * Fetches the full list of models and returns the single entry matching
 * the given model id. OpenRouter does not expose a dedicated
 * single-model endpoint, so this is implemented as a filter over
 * `listModels()` rather than a separate request.
 *
 * @param {string} modelId - The OpenRouter model identifier, e.g.
 *   "openai/gpt-4o". Required.
 * @returns {Promise<Object>} The matching model descriptor.
 * @throws {Error} If modelId is missing, the request fails, or no model
 *   with that id is found.
 */
async function getModel(modelId) {
    requireParam(modelId, "modelId");

    const models = await listModels();
    const model = models.find((candidate) => candidate.id === modelId);

    if (!model) {
        throw buildProviderError({
            endpoint: "/models",
            parameters: { modelId },
            message: `No model with id "${modelId}" was found in the OpenRouter model list.`
        });
    }

    return model;
}

/**
 * createChatCompletion
 *
 * Sends a full chat-style completion request to OpenRouter and returns the
 * raw completion response. This is the low-level building block every
 * other completion helper in this file is built on top of — use it when
 * the caller needs full control over the message history, model, and
 * generation options.
 *
 * @param {Array<Object>} messages - The chat message history to send, each
 *   entry shaped like `{ role: "system"|"user"|"assistant", content: string }`.
 *   Required, must be a non-empty array.
 * @param {Object} [options={}] - Optional generation parameters.
 * @param {string} [options.model] - The OpenRouter model id to use. If
 *   omitted, OpenRouter falls back to its own default routing behavior.
 * @param {number} [options.temperature] - Sampling temperature.
 * @param {number} [options.maxTokens] - Maximum number of tokens to generate.
 * @param {number} [options.topP] - Nucleus sampling parameter.
 * @returns {Promise<Object>} The parsed OpenRouter chat completion response.
 * @throws {Error} If messages is missing/invalid, the request fails, or the
 *   response does not contain the expected "choices" field.
 */
async function createChatCompletion(messages, options = {}) {
    requireParam(messages, "messages");

    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("messages must be a non-empty array of chat messages.");
    }

    const response = await request("/chat/completions", {
        method: "POST",
        body: {
            model: options.model,
            messages,
            temperature: options.temperature,
            max_tokens: options.maxTokens,
            top_p: options.topP
        }
    });

    if (!Array.isArray(response.choices) || response.choices.length === 0) {
        throw buildProviderError({
            endpoint: "/chat/completions",
            parameters: { model: options.model },
            message: "The OpenRouter API response is missing the expected \"choices\" field."
        });
    }

    return response;
}

/**
 * generateText
 *
 * Convenience wrapper around `createChatCompletion` for the common case of
 * a single-turn prompt: builds a one-message chat history and returns just
 * the generated text content, rather than the full completion envelope.
 * Used throughout the engine for quick summaries and analysis snippets
 * where the caller does not need message history control.
 *
 * @param {string} prompt - The prompt text to send. Required.
 * @param {Object} [options={}] - Optional generation parameters, in the
 *   same shape accepted by `createChatCompletion` (excluding `messages`).
 * @param {string} [options.systemPrompt] - An optional system message to
 *   prepend before the user prompt.
 * @returns {Promise<string>} The generated text content of the first
 *   completion choice.
 * @throws {Error} If prompt is missing, the request fails, or the response
 *   does not contain usable message content.
 */
async function generateText(prompt, options = {}) {
    requireParam(prompt, "prompt");

    const messages = [];

    if (options.systemPrompt) {
        messages.push({ role: "system", content: options.systemPrompt });
    }

    messages.push({ role: "user", content: prompt });

    const response = await createChatCompletion(messages, options);
    const content = response.choices[0].message && response.choices[0].message.content;

    if (!content) {
        throw buildProviderError({
            endpoint: "/chat/completions",
            parameters: { model: options.model },
            message: "The OpenRouter API completion did not contain any message content."
        });
    }

    return content;
}

/**
 * getGenerationStats
 *
 * Fetches metadata about a previously completed generation (token usage,
 * cost, latency) using the generation id returned by a chat completion
 * response. Used for cost tracking and monitoring model usage across the
 * engine.
 *
 * @param {string} generationId - The generation id to look up. Required.
 * @returns {Promise<Object>} The parsed generation statistics.
 * @throws {Error} If generationId is missing or the request fails.
 */
async function getGenerationStats(generationId) {
    requireParam(generationId, "generationId");

    const response = await request("/generation", {
        method: "GET",
        params: { id: generationId }
    });

    if (!response.data) {
        throw buildProviderError({
            endpoint: "/generation",
            parameters: { generationId },
            message: `No generation statistics were found for generation id "${generationId}".`
        });
    }

    return response.data;
}

module.exports = {
    listModels,
    getModel,
    createChatCompletion,
    generateText,
    getGenerationStats
};