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
 * ROUTING NOTE — SHARED ".fix" PREFIX WITH commands/graphics.js
 * ---------------------------------------------------------------------
 * Bare ".fix" and ".fixquality" (no arguments) are handled HERE — they
 * run the AI upscale/restore pass via the Real-ESRGAN provider.
 * ".fix brightness <n>", ".fix saturation <n>", and ".fix denoise" are
 * handled in commands/graphics.js instead — plain local sharp edits,
 * nothing to do with this provider. index.js disambiguates the two by
 * checking exact equality (".fix" / ".fixquality") for this file vs.
 * a ".fix " (trailing space) prefix for graphics.js — see the wiring
 * comment in index.js.
 *
 * ---------------------------------------------------------------------
 * SCOPE OF THIS FILE
 * ---------------------------------------------------------------------
 * The current provider does exactly one thing: Real-ESRGAN image
 * upscaling at x2 or x4. Only two commands are wired here:
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
 * Everything else from the original brainstorm (brightness/saturation/
 * denoise, color tinting/inversion/grayscale, silhouette, video FPS/
 * bitrate) lives in commands/graphics.js or is still pending — see that
 * file's header comment for the full breakdown of what needs what
 * backend.
 *
 * ---------------------------------------------------------------------
 * OUTPUT FORMAT — WEBP -> JPEG CONVERSION BEFORE SENDING
 * ---------------------------------------------------------------------
 * The Hockman/real-esrgan-upscaler Space always returns .webp output.
 * Sending that .webp straight through as a WhatsApp "image" message
 * displayed fine on WhatsApp Web/Desktop but did NOT display on the
 * phone client — WhatsApp mobile treats .webp as sticker territory,
 * not a regular photo. Fix: convertToJpeg() (lib/imageHelpers.js)
 * re-encodes the provider's .webp to a real JPEG before sending.
 * providers/upscale.js itself is untouched — it still returns whatever
 * the Space gives it; the conversion is a WhatsApp-delivery concern,
 * so it lives in the shared helper, not the provider.
 */

'use strict';

const {
    getQuotedImage,
    saveBufferToTemp,
    convertToJpeg,
    cleanupTempFile,
} = require('../lib/imageHelpers');

const { upscaleImage } = require('../providers/upscale');
const { startProgress } = require('../lib/progressIndicator');
const { checkCooldown, setCooldown } = require('./cooldown');

const COOLDOWN_MS = 60000; // 1 minute — protects the shared community Space from spam

/**
 * Shared implementation for .enhance and .fix/.fixquality — both are
 * "download the replied-to image, run it through the upscale provider
 * at a fixed scale, convert the result to JPEG, send it back" with
 * different scale/labels.
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

    const inputPath = saveBufferToTemp(media.buffer, media.mimeType);

    const progress = await startProgress(
        sock,
        msg,
        `🔎 ${statusVerb}... this can take a minute, especially on the first run.`
    );

    let providerOutputPath; // the provider's raw .webp output
    let jpegOutputPath;     // the converted, actually-sendable .jpg

    try {

        const result = await upscaleImage(inputPath, scale);
        providerOutputPath = result.filePath;

        console.log(`[UPSCALE] providerOutputPath: ${providerOutputPath}`);

        jpegOutputPath = await convertToJpeg(providerOutputPath);

        await sock.sendMessage(chatId, {
            image: { url: jpegOutputPath },
            mimetype: 'image/jpeg',
        }, { quoted: msg });

        await progress.succeed();

    } catch (err) {

        console.error(`[.${cooldownKey}] upscale failed:`, err.message);
        await progress.fail();

    } finally {

        cleanupTempFile(inputPath);
        cleanupTempFile(providerOutputPath);
        cleanupTempFile(jpegOutputPath);

    }

}

/**
 * .enhance — quick, "make it look better" default. x2 upscale.
 */
async function enhanceCommand(sock, msg) {
    return await runUpscale(sock, msg, 2, 'enhance', 'Enhancing');
}

/**
 * .fix / .fixquality — more aggressive recovery pass. x4 upscale.
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