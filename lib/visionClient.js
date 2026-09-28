// lib/visionClient.js
//
// Azure Foundry multimodal vision client for Zorex.
// Replaces the old Gemini dependency completely.
//
// Uses the same Azure credentials as lib/textAIClient.js by default:
//   AZURE_AI_ENDPOINT
//   AZURE_AI_KEY
//   AZURE_AI_MODEL
//
// Optional:
//   AZURE_VISION_MODEL=<separate vision-capable deployment>
//   AZURE_AI_TIMEOUT_MS=<request timeout>
//
// The selected model must support image input.

"use strict";

const AZURE_AI_ENDPOINT =
    String(
        process.env.AZURE_AI_ENDPOINT ||
        ""
    ).replace(/\/+$/, "");

const AZURE_AI_KEY =
    process.env.AZURE_AI_KEY;

const AZURE_VISION_MODEL =
    process.env.AZURE_VISION_MODEL ||
    process.env.AZURE_AI_MODEL;

const REQUEST_TIMEOUT_MS =
    Number(
        process.env.AZURE_AI_TIMEOUT_MS ||
        60000
    );

const MAX_RETRIES = 2;

function sleep(ms) {
    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

function getRetryDelayMs(
    response,
    attempt
) {
    const retryAfter =
        Number(
            response.headers.get(
                "retry-after"
            )
        );

    if (
        Number.isFinite(
            retryAfter
        ) &&
        retryAfter > 0
    ) {
        return Math.ceil(
            retryAfter *
            1000
        );
    }

    return Math.min(
        1500 *
            Math.pow(
                2,
                attempt
            ),
        10000
    );
}

async function callVision(
    systemPrompt,
    userText,
    imageBuffer,
    mimeType
) {
    if (!AZURE_AI_ENDPOINT) {
        throw new Error(
            "AZURE_AI_ENDPOINT is not set."
        );
    }

    if (!AZURE_AI_KEY) {
        throw new Error(
            "AZURE_AI_KEY is not set."
        );
    }

    if (!AZURE_VISION_MODEL) {
        throw new Error(
            "AZURE_VISION_MODEL/AZURE_AI_MODEL is not set."
        );
    }

    if (!Buffer.isBuffer(imageBuffer)) {
        throw new Error(
            "Vision input must be a Buffer."
        );
    }

    const imageMime =
        String(
            mimeType ||
            "image/jpeg"
        );

    const dataUrl =
        `data:${imageMime};base64,${imageBuffer.toString("base64")}`;

    const body = {
        model:
            AZURE_VISION_MODEL,
        max_completion_tokens:
            1400,
        messages: [
            {
                role:
                    "developer",
                content:
                    String(
                        systemPrompt ||
                        ""
                    )
            },
            {
                role:
                    "user",
                content: [
                    {
                        type:
                            "text",
                        text:
                            String(
                                userText ||
                                "Describe and analyze this image."
                            )
                    },
                    {
                        type:
                            "image_url",
                        image_url: {
                            url:
                                dataUrl
                        }
                    }
                ]
            }
        ]
    };

    const url =
        `${AZURE_AI_ENDPOINT}/openai/v1/chat/completions`;

    let lastError =
        null;

    for (
        let attempt = 0;
        attempt <= MAX_RETRIES;
        attempt++
    ) {
        const controller =
            new AbortController();

        const timer =
            setTimeout(
                () =>
                    controller.abort(),
                REQUEST_TIMEOUT_MS
            );

        try {
            const response =
                await fetch(
                    url,
                    {
                        method:
                            "POST",
                        headers: {
                            "Content-Type":
                                "application/json",
                            "api-key":
                                AZURE_AI_KEY
                        },
                        body:
                            JSON.stringify(
                                body
                            ),
                        signal:
                            controller.signal
                    }
                );

            clearTimeout(
                timer
            );

            if (response.ok) {
                const data =
                    await response.json();

                const text =
                    data.choices?.[0]
                        ?.message
                        ?.content;

                return text
                    ? String(
                        text
                    ).trim()
                    : "...";
            }

            const errorText =
                await response
                    .text()
                    .catch(
                        () => ""
                    );

            lastError =
                new Error(
                    `Azure vision error ${response.status}: ${errorText}`
                );

            const retryable =
                response.status === 408 ||
                response.status === 429 ||
                response.status >= 500;

            if (
                retryable &&
                attempt < MAX_RETRIES
            ) {
                const waitMs =
                    getRetryDelayMs(
                        response,
                        attempt
                    );

                console.warn(
                    `[Azure Vision] HTTP ${response.status}; retrying in ${waitMs}ms...`
                );

                await sleep(
                    waitMs
                );

                continue;
            }

            throw lastError;

        } catch (err) {
            clearTimeout(
                timer
            );

            lastError =
                err?.name ===
                "AbortError"
                    ? new Error(
                        `Azure vision request timed out after ${REQUEST_TIMEOUT_MS}ms`
                    )
                    : err;

            if (
                attempt < MAX_RETRIES &&
                (
                    err?.name ===
                        "AbortError" ||
                    err instanceof
                        TypeError
                )
            ) {
                const waitMs =
                    Math.min(
                        1500 *
                            Math.pow(
                                2,
                                attempt
                            ),
                        10000
                    );

                await sleep(
                    waitMs
                );

                continue;
            }

            throw lastError;
        }
    }

    throw (
        lastError ||
        new Error(
            "Azure vision request failed."
        )
    );
}

module.exports = {
    callVision
};
