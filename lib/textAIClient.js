// lib/textAIClient.js
//
// Shared Azure Foundry text client for Zorex.
//
// Used by:
// - .ai
// - Chloe
// - .mem
// - Chloe's relationship judge
//
// Expects:
//   AZURE_AI_ENDPOINT=https://<resource>.cognitiveservices.azure.com
//   AZURE_AI_KEY=<secret>
//   AZURE_AI_MODEL=<deployment name, e.g. zorex-luna>
//
// Keeps the same callAI(systemPrompt, messages) interface the old
// Groq/OpenAI clients used so callers do not need provider-specific code.

"use strict";

const AZURE_AI_ENDPOINT =
    String(process.env.AZURE_AI_ENDPOINT || "")
        .replace(/\/+$/, "");

const AZURE_AI_KEY =
    process.env.AZURE_AI_KEY;

const AZURE_AI_MODEL =
    process.env.AZURE_AI_MODEL;

const REQUEST_TIMEOUT_MS =
    Number(process.env.AZURE_AI_TIMEOUT_MS || 60000);

const MAX_RETRIES = 2;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryDelayMs(response, attempt) {

    const retryAfter =
        Number(response.headers.get("retry-after"));

    if (
        Number.isFinite(retryAfter) &&
        retryAfter > 0
    ) {
        return Math.ceil(retryAfter * 1000);
    }

    return Math.min(
        1500 * Math.pow(2, attempt),
        10000
    );
}

/**
 * @param {string} systemPrompt
 * @param {Array<{role:'user'|'assistant', content:string}>} messages
 * @returns {Promise<string>}
 */
async function callAI(systemPrompt, messages, options = {}) {

    if (!AZURE_AI_ENDPOINT) {
        throw new Error(
            "AZURE_AI_ENDPOINT is not set in .env."
        );
    }

    if (!AZURE_AI_KEY) {
        throw new Error(
            "AZURE_AI_KEY is not set in .env."
        );
    }

    if (!AZURE_AI_MODEL) {
        throw new Error(
            "AZURE_AI_MODEL is not set in .env."
        );
    }

    const url =
        `${AZURE_AI_ENDPOINT}/openai/v1/chat/completions`;

    const timeoutMs =
        Number.isFinite(Number(options.timeoutMs))
            ? Math.max(5000, Number(options.timeoutMs))
            : REQUEST_TIMEOUT_MS;

    const maxRetries =
        Number.isInteger(options.maxRetries)
            ? Math.max(0, options.maxRetries)
            : MAX_RETRIES;

    const maxCompletionTokens =
        Number.isFinite(Number(options.maxCompletionTokens))
            ? Math.max(64, Number(options.maxCompletionTokens))
            : 1200;

    const body = {
        model: AZURE_AI_MODEL,
        max_completion_tokens: maxCompletionTokens,
        messages: [
            {
                role: "developer",
                content: String(systemPrompt || "")
            },
            ...(Array.isArray(messages) ? messages : [])
                .map(message => ({
                    role:
                        message.role === "assistant"
                            ? "assistant"
                            : "user",
                    content:
                        String(message.content || "")
                }))
        ]
    };

    let lastError = null;

    for (
        let attempt = 0;
        attempt <= maxRetries;
        attempt++
    ) {

        const controller =
            new AbortController();

        const timer =
            setTimeout(
                () => controller.abort(),
                timeoutMs
            );

        try {

            const response =
                await fetch(
                    url,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "api-key": AZURE_AI_KEY
                        },
                        body:
                            JSON.stringify(body),
                        signal:
                            controller.signal
                    }
                );

            clearTimeout(timer);

            if (response.ok) {

                const data =
                    await response.json();

                const text =
                    data.choices?.[0]?.message?.content;

                return text
                    ? String(text).trim()
                    : "...";
            }

            const errorText =
                await response.text().catch(
                    () => ""
                );

            lastError =
                new Error(
                    `Azure AI error ${response.status}: ${errorText}`
                );

            const retryable =
                response.status === 408 ||
                response.status === 429 ||
                response.status >= 500;

            if (
                retryable &&
                attempt < maxRetries
            ) {

                const waitMs =
                    getRetryDelayMs(
                        response,
                        attempt
                    );

                console.warn(
                    `[Azure AI] HTTP ${response.status}; retrying in ${waitMs}ms...`
                );

                await sleep(waitMs);
                continue;
            }

            throw lastError;

        } catch (err) {

            clearTimeout(timer);

            if (
                err?.name === "AbortError"
            ) {

                lastError =
                    new Error(
                        `Azure AI request timed out after ${timeoutMs}ms`
                    );

            } else {

                lastError =
                    err;

            }

            if (
                attempt < maxRetries &&
                (
                    err?.name === "AbortError" ||
                    err instanceof TypeError
                )
            ) {

                const waitMs =
                    Math.min(
                        1500 * Math.pow(2, attempt),
                        10000
                    );

                console.warn(
                    `[Azure AI] Network/timeout error; retrying in ${waitMs}ms...`
                );

                await sleep(waitMs);
                continue;
            }

            throw lastError;

        }

    }

    throw (
        lastError ||
        new Error("Azure AI request failed.")
    );
}

module.exports = {
    callAI
};
