/**
 * commands/video.js
 *
 * .video [2s-10s] [portrait|landscape] <prompt>
 *
 * No source image  -> text-to-video.
 * Replied/direct image -> image-to-video using that image as the first frame.
 *
 * Examples:
 *   .video a neon sports car drifting through Lagos at night
 *   .video 8s landscape waves crashing against black volcanic cliffs
 *   [reply to image] .video make her hair move naturally in the wind
 */

"use strict";

const sharp = require("sharp");

const {
    getQuotedImage
} = require("../lib/imageHelpers");

const {
    cleanupTempFile
} = require("../lib/videoHelper");

const {
    generateVideo
} = require("../providers/videoGeneration");

const {
    startProgress
} = require("../lib/progressIndicator");

const {
    checkCooldown,
    setCooldown
} = require("./cooldown");

const VIDEO_COOLDOWN_MS =
    Number(
        process.env.VIDEO_GENERATION_COOLDOWN_MS ||
        120000
    );

const DEFAULT_DURATION =
    5;

const MIN_DURATION =
    2;

const MAX_DURATION =
    10;

function parseRequest(text) {

    let body =
        String(text || "")
            .replace(/^\.video\b/i, "")
            .trim();

    let duration =
        DEFAULT_DURATION;

    let orientation =
        "portrait";

    let changed =
        true;

    while (
        body &&
        changed
    ) {

        changed =
            false;

        const durationMatch =
            body.match(
                /^(\d{1,2})s\b\s*/i
            );

        if (durationMatch) {

            duration =
                Number(
                    durationMatch[1]
                );

            body =
                body.slice(
                    durationMatch[0].length
                ).trim();

            changed =
                true;

            continue;

        }

        const orientationMatch =
            body.match(
                /^(portrait|landscape)\b\s*/i
            );

        if (orientationMatch) {

            orientation =
                orientationMatch[1]
                    .toLowerCase();

            body =
                body.slice(
                    orientationMatch[0].length
                ).trim();

            changed =
                true;

        }

    }

    return {
        prompt:
            body,
        duration,
        orientation
    };
}

async function getDirectImage(
    msg
) {

    const imageMessage =
        msg?.message
            ?.imageMessage;

    if (!imageMessage) {
        return null;
    }

    const {
        downloadMediaMessage
    } =
        await import(
            "@whiskeysockets/baileys"
        );

    const buffer =
        await downloadMediaMessage(
            msg,
            "buffer",
            {}
        );

    return {
        buffer,
        mimeType:
            imageMessage.mimetype ||
            "image/jpeg"
    };
}

async function getSourceImage(
    sock,
    msg
) {

    let quoted =
        null;

    try {

        quoted =
            await getQuotedImage(
                sock,
                msg
            );

    } catch (_) {}

    if (quoted) {
        return quoted;
    }

    try {

        return await getDirectImage(
            msg
        );

    } catch (err) {

        console.error(
            "[.video] direct image download failed:",
            err.message
        );

        return null;

    }
}

async function prepareSourceImage(
    source
) {

    const buffer =
        await sharp(
            source.buffer
        )
            .rotate()
            .resize({
                width:
                    1280,
                height:
                    1280,
                fit:
                    "inside",
                withoutEnlargement:
                    true
            })
            .jpeg({
                quality:
                    88
            })
            .toBuffer();

    const metadata =
        await sharp(
            buffer
        ).metadata();

    const width =
        Number(
            metadata.width ||
            1
        );

    const height =
        Number(
            metadata.height ||
            1
        );

    let ratio;

    const aspect =
        width /
        height;

    if (
        aspect >= 0.85 &&
        aspect <= 1.15
    ) {

        ratio =
            "960:960";

    } else if (
        height >
        width
    ) {

        ratio =
            "720:1280";

    } else {

        ratio =
            "1280:720";

    }

    return {
        dataUri:
            `data:image/jpeg;base64,${buffer.toString("base64")}`,
        ratio
    };
}

async function generateVideoFromPrompt(
    sock,
    msg,
    prompt,
    options = {}
) {

    const chatId =
        msg.key.remoteJid;

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const request =
        options.parsedRequest ||
        parseRequest(
            `.video ${prompt || ""}`
        );

    if (
        request.duration <
            MIN_DURATION ||
        request.duration >
            MAX_DURATION
    ) {

        await sock.sendMessage(
            chatId,
            {
                text:
                    `⚠️ Video duration must be between ${MIN_DURATION}s and ${MAX_DURATION}s.\n\nExample:\n.video 5s portrait a futuristic city at night`
            },
            {
                quoted:
                    msg
            }
        );

        return false;

    }

    const sourceImage =
        await getSourceImage(
            sock,
            msg
        );

    const cleanPrompt =
        String(
            request.prompt ||
            ""
        ).trim() ||
        (
            sourceImage
                ? "Natural cinematic motion based on the source image."
                : ""
        );

    if (!cleanPrompt) {

        await sock.sendMessage(
            chatId,
            {
                text:
                    "⚠️ Give me a video prompt.\n\nExample:\n.video a futuristic race car drifting through neon streets"
            },
            {
                quoted:
                    msg
            }
        );

        return false;

    }

    const remaining =
        checkCooldown(
            sender,
            "video-generation",
            VIDEO_COOLDOWN_MS
        );

    if (remaining) {

        await sock.sendMessage(
            chatId,
            {
                text:
                    `⏳ Video generation is cooling down. Try again in ${Math.ceil(remaining / 1000)}s.`
            },
            {
                quoted:
                    msg
            }
        );

        return false;

    }

    setCooldown(
        sender,
        "video-generation"
    );

    const ownsProgress =
        !options.progress;

    const progress =
        options.progress ||
        await startProgress(
            sock,
            msg,
            sourceImage
                ? "🖼️ Preparing image-to-video..."
                : "🎬 Preparing text-to-video..."
        );

    let generatedPath;

    try {

        let promptImage =
            null;

        let ratio =
            request.orientation ===
            "landscape"
                ? "1280:720"
                : "720:1280";

        if (sourceImage) {

            await progress.update(
                "🖼️ Preparing source image..."
            );

            const prepared =
                await prepareSourceImage(
                    sourceImage
                );

            promptImage =
                prepared.dataUri;

            ratio =
                prepared.ratio;

        }

        await progress.update(
            sourceImage
                ? "🎥 Animating image..."
                : "🎥 Generating video..."
        );

        const result =
            await generateVideo({
                promptText:
                    cleanPrompt,
                promptImage,
                ratio,
                duration:
                    request.duration,
                onStatus:
                    async status => {

                        if (
                            status ===
                            "PENDING"
                        ) {
                            await progress.update(
                                "⏳ Video is queued..."
                            );
                        } else if (
                            status ===
                            "THROTTLED"
                        ) {
                            await progress.update(
                                "⏳ Runway is busy — waiting for a generation slot..."
                            );
                        } else if (
                            status ===
                            "RUNNING"
                        ) {
                            await progress.update(
                                "🎥 Generating video..."
                            );
                        }

                    }
            });

        generatedPath =
            result.filePath;

        await progress.update(
            "📤 Sending generated video..."
        );

        await sock.sendMessage(
            chatId,
            {
                video: {
                    url:
                        generatedPath
                },
                mimetype:
                    "video/mp4",
                caption:
                    `🎬 *Generated Video*\n\n📝 ${cleanPrompt}\n⏱️ ${request.duration}s`
            },
            {
                quoted:
                    msg
            }
        );

        await progress.succeed(
            "✅ Video ready"
        );

        return true;

    } catch (err) {

        console.error(
            "[.video] generation failed:",
            err.message
        );

        await progress.fail(
            "❌ Video generation failed"
        );

        if (
            ownsProgress ||
            options.source ===
                "ai"
        ) {

            const missingKey =
                /RUNWAYML_API_SECRET/i.test(
                    err.message
                );

            await sock.sendMessage(
                chatId,
                {
                    text:
                        missingKey
                            ? "⚠️ Runway video generation is not configured yet. Add RUNWAYML_API_SECRET to Zorex's .env."
                            : "⚠️ I couldn't generate that video right now."
                },
                {
                    quoted:
                        msg
                }
            );

        }

        return false;

    } finally {

        cleanupTempFile(
            generatedPath
        );

    }

}

async function videoCommand(
    sock,
    msg,
    text
) {

    const parsedRequest =
        parseRequest(
            text
        );

    return generateVideoFromPrompt(
        sock,
        msg,
        parsedRequest.prompt,
        {
            parsedRequest
        }
    );
}

module.exports = {
    videoCommand,
    generateVideoFromPrompt
};
