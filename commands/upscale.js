/**
 * commands/upscle.js
 *
 * .enhance
 * .fix / .fixquality
 * ---------------------
 * Image quality commands built on providers/upscale.js (Real-ESRGAN via
 * the Hockman/real-esrgan-upscaler Hugging Face Space — see that file's
 * header comment for why a Space instead of an official API).
 *
 * ---------------------------------------------------------------------
 * SCOPE OF THIS FILE — READ BEFORE ADDING MORE .fix/.graph SUBCOMMANDS
 * ---------------------------------------------------------------------
 * The current provider does exactly one thing: Real-ESRGAN image
 * upscaling at x2 or x4. That's it — no separate denoise/saturation/
 * brightness/color controls, no video support, no FPS interpolation.
 * Only two commands are wired here because only two map onto what the
 * provider can actually do right now:
 *
 *   .enhance            -> x2 (quick, "make it look better" default)
 *   .fix / .fixquality  -> x4 (more aggressive — Real-ESRGAN's stronger
 *                          pass does incidentally reduce JPEG/compression
 *                          artifacts as a side effect of upscaling, which
 *                          is why x4 fits the "recover destroyed footage"
 *                          intent better than x2 — but this is still just
 *                          upscaling under the hood, not a dedicated
 *                          artifact-removal or denoise pass)
 *
 * EVERYTHING ELSE FROM THE BRAINSTORM NEEDS A DIFFERENT BACKEND:
 *
 *   .fix denoise / saturation / brightness / graphs
 *   .graph <color> / .graph inverse / .silhouette
 *     -> Plain image manipulation — brightness/contrast/saturation
 *        curves, channel isolation, inversion, grayscale/silhouette
 *        effects. None of this needs Real-ESRGAN, an AI model, or any
 *        external API at all — it's exactly what the `sharp` npm
 *        package does locally, in milliseconds, for free, with no
 *        dependency on a community Space staying online. Build this as
 *        its own commands/graphics.js on top of `sharp` rather than
 *        forcing it through this upscale provider.
 *
 *   .fps <n>
 *     -> Needs ffmpeg (already installed on this deployment per
 *        providers/youtube.js's header comment). A basic version
 *        (frame duplication/blending via ffmpeg's minterpolate filter)
 *        is doable locally with no external API, though real AI-grade
 *        interpolation (RIFE-style, smoother results) would need a
 *        separate hosted model later.
 *
 *   .bitrate <n>
 *     -> Also just ffmpeg — re-encode the video at a target bitrate.
 *        No AI/API needed here either.
 *
 * None of the above is wired in this file. This file ONLY covers
 * .enhance and .fix/.fixquality, both image-only, both riding on the
 * existing Real-ESRGAN Space provider.
 *
 * NOTE ON INTEGRATION: follows the (sock, msg, text) router shape used
 * by gambleCommands/economyCommands/minesCommands elsewhere in Zorex
 * Bot — export a single upscleCommands() and route internally, so
 * index.js only needs one require + one routing branch.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');

const { upscaleImage } = require('../providers/upscale');
const { startProgress } = require('../lib/progressIndicator');
const { checkCooldown, setCooldown } = require('./cooldown');

const COOLDOWN_MS = 60000; // 1 minute — protects the shared community Space from spam

const TEMP_DIR = path.join(os.tmpdir(), 'zorex-upscle-command');

const IMAGE_EXT_BY_MIME = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
};

function ensureTempDir() {
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
}

/**
 * Removes a temp file if it exists, swallowing any error — cleanup
 * should never mask the real result of the command. Same contract as
 * cleanupTempFile() in play.js/yt.js/ttk.js.
 *
 * @param {string|undefined} filePath
 * @returns {void}
 */
function cleanupTempFile(filePath) {
    if (!filePath) return;
    fs.unlink(filePath, () => {
        /* best-effort cleanup; ignore errors */
    });
}

/**
 * Pulls the quoted message's image out of a .enhance/.fix reply.
 * Returns null if the reply isn't to an image, or isn't a reply at all.
 * Image-only — mirrors getQuotedMedia() in commands/ai.js but narrower
 * on purpose, since this command has nothing to do with PDFs.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @returns {Promise<{ buffer: Buffer, mimeType: string }|null>}
 */
async function getQuotedImage(sock, msg) {

    const context = msg.message?.extendedTextMessage?.contextInfo;
    const quoted = context?.quotedMessage;

    if (!quoted || !quoted.imageMessage) return null;

    const fakeMsg = {
        key: {
            remoteJid: msg.key.remoteJid,
            id: context.stanzaId,
            participant: context.participant,
            fromMe: false,
        },
        message: quoted,
    };

    const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {});
    const mimeType = quoted.imageMessage.mimetype || 'image/jpeg';

    return { buffer, mimeType };

}

/**
 * Shared implementation for .enhance and .fix/.fixquality — both are
 * "download the replied-to image, run it through the upscale provider
 * at a fixed scale, send the result back" with different scale/labels.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @param {2|4} scale
 * @param {string} cooldownKey
 * @param {string} statusVerb - e.g. "Enhancing" / "Restoring quality"
 * @returns {Promise<void>}
 */
async function runUpscale(sock, msg, scale, cooldownKey, statusVerb) {

    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;

    const remaining = checkCooldown(sender, cooldownKey, COOLDOWN_MS);

    if (remaining) {
        return await sock.sendMessage(chatId, {
            text: `⏳ Slow down! Try again in ${Math.ceil(remaining / 1000)}s.`,
        }, { quoted: msg });
    }

    let media;
    try {
        media = await getQuotedImage(sock, msg);
    } catch (err) {
        console.error(`[.${cooldownKey}] failed to download quoted image:`, err.message);
        media = null;
    }

    if (!media) {
        return await sock.sendMessage(chatId, {
            text: `⚠️ Reply to an image with this command.`,
        }, { quoted: msg });
    }

    setCooldown(sender, cooldownKey);

    ensureTempDir();

    const ext = IMAGE_EXT_BY_MIME[media.mimeType] || '.jpg';
    const inputPath = path.join(TEMP_DIR, `${crypto.randomBytes(6).toString('hex')}-in${ext}`);
    fs.writeFileSync(inputPath, media.buffer);

    const progress = await startProgress(
        sock,
        msg,
        `🔎 ${statusVerb}... this can take a minute, especially on the first run.`
    );

    let outputPath;

    try {

        const result = await upscaleImage(inputPath, scale);
        outputPath = result.filePath;

        await sock.sendMessage(chatId, {
            image: { url: outputPath },
            mimetype: 'image/webp',
        }, { quoted: msg });

        await progress.succeed();

    } catch (err) {

        console.error(`[.${cooldownKey}] upscale failed:`, err.message);
        await progress.fail();

    } finally {

        cleanupTempFile(inputPath);
        cleanupTempFile(outputPath);

    }

}

/**
 * .enhance — quick, "make it look better" default. x2 upscale.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @returns {Promise<void>}
 */
async function enhanceCommand(sock, msg) {
    return await runUpscale(sock, msg, 2, 'enhance', 'Enhancing');
}

/**
 * .fix / .fixquality — more aggressive recovery pass. x4 upscale.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @returns {Promise<void>}
 */
async function fixCommand(sock, msg) {
    return await runUpscale(sock, msg, 4, 'fix', 'Restoring quality');
}

/**
 * Router — mirrors the (sock, msg, text) shape used by gambleCommands,
 * economyCommands, minesCommands, etc. elsewhere in the codebase.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @param {string} text
 * @returns {Promise<void>}
 */
async function upscleCommands(sock, msg, text) {

    if (text === '.enhance') {
        return await enhanceCommand(sock, msg);
    }

    if (text === '.fix' || text === '.fixquality') {
        return await fixCommand(sock, msg);
    }

}

module.exports = { upscleCommands };