"use strict";

const {
    getQuotedImage
} = require("../lib/imageHelpers");

const {
    createJob
} = require("../lib/editorJobs");

const {
    checkCooldown,
    setCooldown
} = require("./cooldown");

const COOLDOWN_MS =
    30000;

async function runEnhance(
    sock,
    msg,
    {
        scale,
        mode
    }
) {

    const chatId =
        msg.key.remoteJid;

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const cooldownKey =
        mode ===
        "fix"
            ? "fix"
            : "enhance";

    const remaining =
        checkCooldown(
            sender,
            cooldownKey,
            COOLDOWN_MS
        );

    if (remaining) {
        return await sock.sendMessage(
            chatId,
            {
                text:
                    "⏳ Slow down! Try again in " +
                    Math.ceil(
                        remaining /
                        1000
                    ) +
                    "s."
            },
            {
                quoted:
                    msg
            }
        );
    }

    let media =
        null;

    try {
        media =
            await getQuotedImage(
                sock,
                msg
            );
    } catch (err) {
        console.error(
            "[." +
            cooldownKey +
            "] failed to download quoted image:",
            err.message
        );
    }

    if (!media) {
        return await sock.sendMessage(
            chatId,
            {
                text:
                    "⚠️ Reply to an image with this command."
            },
            {
                quoted:
                    msg
            }
        );
    }

    setCooldown(
        sender,
        cooldownKey
    );

    const job =
        createJob({
            type:
                "image_enhance",
            ownerId:
                sender,
            chatId,
            inputBuffer:
                media.buffer,
            mimeType:
                media.mimeType ||
                "image/jpeg",
            sourceMessageId:
                msg.key.id ||
                null,
            options: {
                scale,
                profile:
                    mode
            },
            requirements: {
                gpu:
                    true,
                minVramGb:
                    1,
                capabilities: [
                    "realesrgan",
                    "image-enhance"
                ]
            }
        });

    return await sock.sendMessage(
        chatId,
        {
            text:
                (
                    mode ===
                    "fix"
                        ? "🛠️ *Quality restoration queued*"
                        : "✨ *Image enhancement queued*"
                ) +
                "\n\nJob: *" +
                job.id +
                "*\nScale: " +
                scale +
                "×\nRenderer: Zorex GPU worker\n\n" +
                "Use:\n.queue " +
                job.id
        },
        {
            quoted:
                msg
        }
    );
}

async function enhanceCommand(
    sock,
    msg
) {
    return await runEnhance(
        sock,
        msg,
        {
            scale:
                2,
            mode:
                "enhance"
        }
    );
}

async function fixCommand(
    sock,
    msg
) {
    return await runEnhance(
        sock,
        msg,
        {
            scale:
                4,
            mode:
                "fix"
        }
    );
}

async function upscleCommands(
    sock,
    msg,
    text
) {

    if (
        text ===
        ".enhance"
    ) {
        return await enhanceCommand(
            sock,
            msg
        );
    }

    if (
        text ===
            ".fix" ||
        text ===
            ".fixquality"
    ) {
        return await fixCommand(
            sock,
            msg
        );
    }

}

module.exports = {
    upscleCommands
};
