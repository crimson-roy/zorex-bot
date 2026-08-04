/**
 * commands/videoUpscale.js
 *
 * .upscale <2|4|8> [fps] [bitrate]
 * .fps <n>
 * .bitrate <n>
 * ---------------------
 * Video quality commands. Mirrors the structure of commands/upscle.js
 * (image AI upscale) and commands/graphics.js (local sharp edits), but
 * split the same way those two files split image work:
 *
 *   .upscale  -> hits providers/videoUpscale.js, the Real-ESRGAN video
 *                Space on Hugging Face (Nick088/Real-ESRGAN_Pytorch) —
 *                same "free community Space, can go down" caveat as
 *                providers/upscale.js. AI resolution upscaling only;
 *                the Space takes a MULTIPLIER (2x/4x/8x the source
 *                resolution), not a target like "1080p"/"4k" — there's
 *                no such option in its API.
 *
 *   .fps      -> local-only ffmpeg re-encode via
 *                lib/videoHelper.js's reencodeVideo(). No Space call.
 *
 *   .bitrate  -> same, local-only ffmpeg re-encode.
 *
 * .upscale ALWAYS hits the Space (scale is a required argument), so it
 * always uses the 60s AI cooldown, same reasoning as upscle.js's
 * COOLDOWN_MS. .fps and .bitrate alone never touch the Space, so they
 * get graphics.js's short 5s local-edit cooldown instead.
 *
 * .upscale's optional trailing fps/bitrate args run through the SAME
 * local reencodeVideo() step .fps/.bitrate use standalone — so
 * ".upscale 4 60 6000" is "AI upscale x4, then re-encode to 60fps and
 * 6000kbps" in one command, while ".fps 60" alone is just the
 * re-encode with no AI step. That's the "combo command, or do just one
 * part separately" split.
 *
 * ---------------------------------------------------------------------
 * ARGUMENT SHAPE — POSITIONAL, NOT LABELED
 * ---------------------------------------------------------------------
 *   .upscale <scale> [fps] [bitrate]
 *   e.g. .upscale 4            -> AI upscale x4 only
 *        .upscale 4 60         -> AI upscale x4, then re-encode to 60fps
 *        .upscale 4 60 6000    -> AI upscale x4, re-encode to 60fps @ 6000kbps
 *        .upscale 2 0 6000     -> AI upscale x2, keep source fps, set bitrate only
 *                                 (use 0 as a placeholder to skip fps but set bitrate)
 *
 * bitrate is in kbps (e.g. 6000 = ~6 Mbps) — see lib/videoHelper.js's
 * reencodeVideo() header comment for why bitrate mode drops -crf.
 */

'use strict';

const {
    getQuotedVideo,
    saveVideoBufferToTemp,
    cleanupTempFile,
    reencodeVideo,
} = require('../lib/videoHelper');

const { upscaleVideo } = require('../providers/videoUpscale');
const { startProgress } = require('../lib/progressIndicator');
const { checkCooldown, setCooldown } = require('./cooldown');

const AI_COOLDOWN_MS = 60000;    // hits the shared community Space — same as upscle.js
const LOCAL_COOLDOWN_MS = 5000;  // pure local ffmpeg — same as graphics.js's local edits

const VALID_SCALES = ['2', '4', '8'];

/**
 * Downloads the quoted video, or replies with a usage warning and
 * returns null if there isn't one.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @param {string} logLabel
 * @returns {Promise<{buffer: Buffer, mimeType: string}|null>}
 */
async function fetchQuotedVideoOrWarn(sock, msg, logLabel) {

    const chatId = msg.key.remoteJid;

    let media;
    try {
        media = await getQuotedVideo(sock, msg);
    } catch (err) {
        console.error(`[${logLabel}] failed to download quoted video:`, err.message);
        media = null;
    }

    if (!media) {
        await sock.sendMessage(chatId, {
            text: `⚠️ Reply to a video with this command.`,
        }, { quoted: msg });
        return null;
    }

    return media;

}

/**
 * .upscale <2|4|8> [fps] [bitrate]
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function upscaleCommand(sock, msg, args) {

    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;

    const [scaleArg, fpsArg, bitrateArg] = args;

    if (!scaleArg || !VALID_SCALES.includes(scaleArg)) {
        return await sock.sendMessage(chatId, {
            text:
`⚠️ Usage:

.upscale <2|4|8> [fps] [bitrate]

Examples:
.upscale 4            (AI upscale x4)
.upscale 4 60         (AI upscale x4, then re-encode to 60fps)
.upscale 4 60 6000    (AI upscale x4, re-encode to 60fps @ 6000kbps)

scale must be 2, 4, or 8 — it's a multiplier of the source resolution, not a fixed target like "1080p".`,
        }, { quoted: msg });
    }

    const fps = fpsArg ? Number(fpsArg) : 0;
    const bitrateKbps = bitrateArg ? Number(bitrateArg) : 0;

    if (fpsArg && (isNaN(fps) || fps < 0)) {
        return await sock.sendMessage(chatId, { text: `⚠️ fps must be a positive number.` }, { quoted: msg });
    }
    if (bitrateArg && (isNaN(bitrateKbps) || bitrateKbps <= 0)) {
        return await sock.sendMessage(chatId, { text: `⚠️ bitrate must be a positive number (kbps).` }, { quoted: msg });
    }

    const remaining = checkCooldown(sender, 'video-upscale', AI_COOLDOWN_MS);
    if (remaining) {
        return await sock.sendMessage(chatId, {
            text: `⏳ Slow down! Try again in ${Math.ceil(remaining / 1000)}s.`,
        }, { quoted: msg });
    }

    const media = await fetchQuotedVideoOrWarn(sock, msg, 'upscale');
    if (!media) return;

    setCooldown(sender, 'video-upscale');

    const inputPath = saveVideoBufferToTemp(media.buffer, media.mimeType);

    const progress = await startProgress(
        sock,
        msg,
        `🔎 Upscaling video x${scaleArg}... this can take a while, especially on the first run.`
    );

    let upscaledPath;
    let finalPath;

    try {

        const result = await upscaleVideo(inputPath, scaleArg);
        upscaledPath = result.filePath;

        if (fps > 0 || bitrateKbps > 0) {
            finalPath = await reencodeVideo(upscaledPath, {
                fps: fps > 0 ? fps : undefined,
                bitrateKbps: bitrateKbps > 0 ? bitrateKbps : undefined,
            });
        } else {
            finalPath = upscaledPath;
        }

        await sock.sendMessage(chatId, {
            video: { url: finalPath },
            mimetype: 'video/mp4',
        }, { quoted: msg });

        await progress.succeed();

    } catch (err) {

        console.error('[.upscale] failed:', err.message);
        await progress.fail();

    } finally {

        cleanupTempFile(inputPath);
        cleanupTempFile(upscaledPath);
        if (finalPath !== upscaledPath) cleanupTempFile(finalPath);

    }

}

/**
 * Shared runner for the local-only .fps / .bitrate commands — no
 * Space call, just lib/videoHelper.js's reencodeVideo().
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @param {string} cooldownKey
 * @param {{ fps?: number, bitrateKbps?: number }} reencodeOptions
 * @returns {Promise<void>}
 */
async function runLocalReencode(sock, msg, cooldownKey, reencodeOptions) {

    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;

    const remaining = checkCooldown(sender, cooldownKey, LOCAL_COOLDOWN_MS);
    if (remaining) {
        return await sock.sendMessage(chatId, {
            text: `⏳ Slow down! Try again in ${Math.ceil(remaining / 1000)}s.`,
        }, { quoted: msg });
    }

    const media = await fetchQuotedVideoOrWarn(sock, msg, cooldownKey);
    if (!media) return;

    setCooldown(sender, cooldownKey);

    const inputPath = saveVideoBufferToTemp(media.buffer, media.mimeType);

    let outputPath;

    try {

        outputPath = await reencodeVideo(inputPath, reencodeOptions);

        await sock.sendMessage(chatId, {
            video: { url: outputPath },
            mimetype: 'video/mp4',
        }, { quoted: msg });

    } catch (err) {

        console.error(`[${cooldownKey}] failed:`, err.message);
        await sock.sendMessage(chatId, {
            text: `❌ Something went wrong processing that video.`,
        }, { quoted: msg });

    } finally {

        cleanupTempFile(inputPath);
        cleanupTempFile(outputPath);

    }

}

/**
 * .fps <n>
 */
async function fpsCommand(sock, msg, args) {

    const chatId = msg.key.remoteJid;
    const fps = Number(args[0]);

    if (!args[0] || isNaN(fps) || fps <= 0) {
        return await sock.sendMessage(chatId, {
            text:
`⚠️ Usage:

.fps <n>

Example:
.fps 60`,
        }, { quoted: msg });
    }

    return await runLocalReencode(sock, msg, 'video-fps', { fps });

}

/**
 * .bitrate <n>  (kbps)
 */
async function bitrateCommand(sock, msg, args) {

    const chatId = msg.key.remoteJid;
    const bitrateKbps = Number(args[0]);

    if (!args[0] || isNaN(bitrateKbps) || bitrateKbps <= 0) {
        return await sock.sendMessage(chatId, {
            text:
`⚠️ Usage:

.bitrate <n>   (in kbps, e.g. 6000 = ~6 Mbps)

Example:
.bitrate 6000`,
        }, { quoted: msg });
    }

    return await runLocalReencode(sock, msg, 'video-bitrate', { bitrateKbps });

}

/**
 * Router — mirrors the (sock, msg, text) shape used elsewhere in the
 * codebase (upscleCommands, graphicsCommands, etc.).
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @param {string} text
 * @returns {Promise<void>}
 */
async function videoUpscaleCommands(sock, msg, text) {

    if (text.startsWith('.upscale')) {
        const args = text.replace('.upscale', '').trim().split(/\s+/).filter(Boolean);
        return await upscaleCommand(sock, msg, args);
    }

    if (text.startsWith('.fps')) {
        const args = text.replace('.fps', '').trim().split(/\s+/).filter(Boolean);
        return await fpsCommand(sock, msg, args);
    }

    if (text.startsWith('.bitrate')) {
        const args = text.replace('.bitrate', '').trim().split(/\s+/).filter(Boolean);
        return await bitrateCommand(sock, msg, args);
    }

}

module.exports = { videoUpscaleCommands };
