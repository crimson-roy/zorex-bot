"use strict";

const { startProgress } = require("../lib/progressIndicator");

const DEFAULT_SIZE = "1024x1024";

const MAX_GENERATION_ATTEMPTS = 4;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryAfterSeconds(response, errorText, attempt) {

    const headerValue =
        Number(response.headers.get("retry-after"));

    if (
        Number.isFinite(headerValue) &&
        headerValue > 0
    ) {
        return Math.ceil(headerValue);
    }

    const match =
        String(errorText || "")
            .match(/retry after\s+(\d+)\s+seconds?/i);

    if (match) {
        return Math.max(
            1,
            Number(match[1])
        );
    }

    // Fallback backoff when Azure omits Retry-After.
    return Math.min(
        5 * Math.pow(2, attempt),
        30
    );
}

function getImageEndpoint() {

    if (process.env.AZURE_IMAGE_ENDPOINT) {
        return String(process.env.AZURE_IMAGE_ENDPOINT)
            .replace(/\/+$/, "");
    }

    // Derive the Foundry Images endpoint from the existing AIServices
    // resource endpoint:
    // https://zorex-ai.cognitiveservices.azure.com
    // -> https://zorex-ai.services.ai.azure.com
    try {

        const aiEndpoint =
            new URL(process.env.AZURE_AI_ENDPOINT || "");

        const resourceName =
            aiEndpoint.hostname.split(".")[0];

        if (resourceName) {
            return `https://${resourceName}.services.ai.azure.com`;
        }

    } catch (_) {}

    return "";
}

function getImageModel() {
    return (
        process.env.AZURE_IMAGE_MODEL ||
        "zorex-image"
    );
}

function getApiKey() {
    return (
        process.env.AZURE_IMAGE_KEY ||
        process.env.AZURE_AI_KEY ||
        ""
    );
}

async function downloadGeneratedImage(data) {

    const item =
        data?.data?.[0];

    if (!item) {
        throw new Error(
            "Azure image API returned no image data."
        );
    }

    if (item.b64_json) {

        return Buffer.from(
            item.b64_json,
            "base64"
        );

    }

    if (item.url) {

        const response =
            await fetch(item.url);

        if (!response.ok) {
            throw new Error(
                `Generated image download failed: HTTP ${response.status}`
            );
        }

        const arrayBuffer =
            await response.arrayBuffer();

        return Buffer.from(arrayBuffer);

    }

    throw new Error(
        "Azure image API returned neither a URL nor base64 image data."
    );
}

/**
 * Shared image-generation implementation.
 *
 * Direct .image calls create their own progress indicator.
 * .ai can pass its existing progress object so users see only one
 * editable status message for the entire request.
 *
 * @param {object} sock
 * @param {object} msg
 * @param {string} prompt
 * @param {{progress?: object, source?: string}} options
 */
async function generateImageFromPrompt(
    sock,
    msg,
    prompt,
    options = {}
) {

    const chatId =
        msg.key.remoteJid;

    const cleanPrompt =
        String(prompt || "").trim();

    if (!cleanPrompt) {

        await sock.sendMessage(
            chatId,
            {
                text:
                    "⚠️ Give me something to generate.\n\nExample:\n.image a futuristic city at night"
            },
            {
                quoted: msg
            }
        );

        return false;
    }

    const ownsProgress =
        !options.progress;

    const progress =
        options.progress ||
        await startProgress(
            sock,
            msg,
            "🎨 Reviewing image prompt..."
        );

    try {

        const endpoint =
            getImageEndpoint();

        const apiKey =
            getApiKey();

        const model =
            getImageModel();

        if (!endpoint) {
            throw new Error(
                "AZURE_IMAGE_ENDPOINT could not be determined."
            );
        }

        if (!apiKey) {
            throw new Error(
                "AZURE_IMAGE_KEY/AZURE_AI_KEY is not configured."
            );
        }

        if (!model) {
            throw new Error(
                "AZURE_IMAGE_MODEL is not configured."
            );
        }

        await progress.update(
            "🖼️ Generating image..."
        );

        let data = null;
        let lastError = null;

        for (
            let attempt = 0;
            attempt < MAX_GENERATION_ATTEMPTS;
            attempt++
        ) {

            const requestUrl =
                `${endpoint}/openai/v1/images/generations?api-version=preview`;

            console.log("[IMAGE PROVIDER] request", {
                host:
                    (() => {
                        try { return new URL(requestUrl).host; }
                        catch (_) { return "invalid-url"; }
                    })(),
                model,
                attempt:
                    attempt + 1
            });

            const response =
                await fetch(
                    requestUrl,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json",
                            "api-key":
                                apiKey
                        },
                        body:
                            JSON.stringify({
                                model,
                                prompt:
                                    cleanPrompt,
                                n: 1,
                                size:
                                    DEFAULT_SIZE
                            })
                    }
                );

            if (response.ok) {

                data =
                    await response.json();

                break;
            }

            const errorText =
                await response.text()
                    .catch(() => "");

            console.error("[IMAGE PROVIDER] Azure response error", {
                status:
                    response.status,
                statusText:
                    response.statusText,
                model,
                endpointHost:
                    (() => {
                        try { return new URL(endpoint).host; }
                        catch (_) { return "invalid-url"; }
                    })(),
                body:
                    String(errorText || "").slice(0, 1200)
            });

            lastError =
                new Error(
                    `Azure image API error ${response.status}: ${errorText}`
                );

            const canRetry =
                attempt <
                MAX_GENERATION_ATTEMPTS - 1;

            if (
                response.status === 429 &&
                canRetry
            ) {

                const waitSeconds =
                    getRetryAfterSeconds(
                        response,
                        errorText,
                        attempt
                    );

                await progress.update(
                    `⏳ Rate limited — retrying in ${waitSeconds}s...`
                );

                await sleep(
                    waitSeconds * 1000
                );

                await progress.update(
                    "🖼️ Generating image..."
                );

                continue;
            }

            // A 404 can mean deployment propagation, but it can also mean
            // the endpoint/deployment/API route is wrong. Retry once only,
            // then surface a configuration-oriented failure.
            if (
                response.status === 404 &&
                canRetry &&
                attempt === 0
            ) {

                const waitSeconds = 5;

                await progress.update(
                    `⏳ Image endpoint returned 404 — retrying once in ${waitSeconds}s...`
                );

                await sleep(
                    waitSeconds * 1000
                );

                await progress.update(
                    "🖼️ Generating image..."
                );

                continue;
            }

            if (
                (
                    response.status === 408 ||
                    response.status >= 500
                ) &&
                canRetry
            ) {

                const waitSeconds =
                    Math.min(
                        3 * Math.pow(2, attempt),
                        15
                    );

                await progress.update(
                    `⏳ Azure is temporarily unavailable — retrying in ${waitSeconds}s...`
                );

                await sleep(
                    waitSeconds * 1000
                );

                await progress.update(
                    "🖼️ Generating image..."
                );

                continue;
            }

            throw lastError;

        }

        if (!data) {
            throw (
                lastError ||
                new Error(
                    "Azure image generation failed after retries."
                )
            );
        }

        await progress.update(
            "📥 Fetching generated image..."
        );

        const imageBuffer =
            await downloadGeneratedImage(
                data
            );

        await progress.update(
            "📤 Sending image..."
        );

        await sock.sendMessage(
            chatId,
            {
                image:
                    imageBuffer,
                caption:
                    `🎨 *Generated Image*\n\n📝 ${cleanPrompt}`
            },
            {
                quoted: msg
            }
        );

        await progress.succeed(
            "✅ Image ready"
        );

        return true;

    } catch (err) {

        console.error(
            "[.image] generation failed:",
            err.message
        );

        await progress.fail(
            "❌ Image generation failed"
        );

        if (ownsProgress || options.source === "ai") {

            const configHint =
                /Azure image API error 404/i.test(err.message)
                    ? "\n\nThe image endpoint or deployment name may be incorrect."
                    : /Azure image API error 401|Azure image API error 403/i.test(err.message)
                        ? "\n\nThe image API credentials or deployment access may be invalid."
                        : "";

            await sock.sendMessage(
                chatId,
                {
                    text:
                        "⚠️ I couldn't generate that image right now." +
                        configHint
                },
                {
                    quoted: msg
                }
            );

        }

        return false;
    }

}

async function imageCommand(
    sock,
    msg,
    text
) {

    const prompt =
        String(text || "")
            .replace(/^\.image\b/i, "")
            .trim();

    return generateImageFromPrompt(
        sock,
        msg,
        prompt
    );
}

module.exports = {
    imageCommand,
    generateImageFromPrompt
};
