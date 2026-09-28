/**
 * commands/graphics.js
 *
 * .fix brightness <amount>
 * .fix saturation <amount>
 * .fix denoise
 * .graph <color>
 * .graph inverse
 * .graph white
 * .graph depth
 * .graph depthvideo
 * .silhouette   (background removal + green-screen compositing — fully wired)
 * ---------------------------------------------------------------------
 * Plain local image manipulation via `sharp` — no AI model, no
 * external API, no dependency on any community Space staying online,
 * for everything except .silhouette's background-removal step. This
 * is deliberately separate from commands/upscle.js, which does real AI
 * upscaling via a Hugging Face Space: these commands don't need that
 * kind of backend at all.
 *
 * ---------------------------------------------------------------------
 * ROUTING NOTE — SHARED ".fix" PREFIX WITH commands/upscle.js
 * ---------------------------------------------------------------------
 * Bare ".fix" and ".fixquality" (no arguments) are handled in
 * commands/upscle.js — they run the AI upscale/restore pass.
 * ".fix brightness <n>", ".fix saturation <n>", and ".fix denoise" are
 * handled HERE instead. index.js disambiguates the two by checking
 * exact equality (".fix" / ".fixquality") for upscle.js vs. a ".fix "
 * (trailing space — i.e. an actual subcommand follows) prefix for this
 * file — see the wiring comment in index.js.
 *
 * ---------------------------------------------------------------------
 * COMMAND SEMANTICS
 * ---------------------------------------------------------------------
 * .fix brightness <n>   - n is a percentage, 100 = unchanged.
 * .fix saturation <n>   - same shape, 100 = unchanged.
 * .fix denoise          - light median-blur noise reduction. Basic
 *                          smoothing, NOT true AI denoising.
 * .graph <color>        - tints toward a named color or #RRGGBB hex.
 * .graph inverse         - inverts all colors.
 * .graph white           - ASSUMED grayscale/black-and-white — flag if wrong.
 * .graph depth           - AI monocular depth estimation; returns a grayscale
 *                          depth map from the replied image.
 *
 * ---------------------------------------------------------------------
 * .silhouette — HOW IT WORKS
 * ---------------------------------------------------------------------
 * Full spec (per user): remove the background entirely, recolor the
 * remaining subject solid WHITE, composite that onto a solid GREEN
 * background — a real chroma-key-ready silhouette.
 *
 * Two stages, both wired in now:
 *
 *   1. providers/removebg.js — background removal via the
 *      briaai/BRIA-RMBG-2.0 Hugging Face Space (@gradio/client). Its
 *      API schema is confirmed (see that file's header comment).
 *      Depends on that community Space staying up, same caveat as
 *      providers/upscale.js's Real-ESRGAN Space — if it goes down,
 *      swap SPACE_NAME there; nothing here needs to change.
 *
 *   2. compositeGreenScreenSilhouette() below. Takes the transparent-
 *      background image stage 1 hands back and produces the white-
 *      subject-on-green result via plain sharp compositing:
 *        a) build a solid white canvas the same size as the source
 *        b) composite the transparent source onto it with blend
 *           'dest-in' (a Porter-Duff mode) — this keeps the white
 *           canvas's pixels ONLY where the source has opacity, giving
 *           a pure white cutout in exactly the subject's shape
 *        c) composite that white cutout over a solid green canvas —
 *           plain alpha-over, no special blend mode needed
 *      No external service dependency — pure local sharp processing.
 *
 * silhouetteCommand() below runs both stages in sequence, protected by
 * the same 60s cooldown providers/upscale.js's AI commands use (not
 * the 5s cooldown the rest of this file's pure-local edits use) —
 * stage 1 hits the same kind of shared community Space that cooldown
 * exists to protect from spam.
 */

'use strict';

const sharp = require('sharp');

const {
    getQuotedImage,
    saveBufferToTemp,
    buildOutputPath,
    cleanupTempFile,
    JPEG_QUALITY,
} = require('../lib/imageHelpers');

const {
    getQuotedVideo,
    saveVideoBufferToTemp,
    extractVideoFrames,
    buildVideoFromFrames,
    cleanupTempDir,
} = require('../lib/videoHelper');

const { removeBackground } = require('../providers/removebg');
const { generateDepthMap } = require('../providers/depth');
const { startProgress } = require('../lib/progressIndicator');
const { checkCooldown, setCooldown } = require('./cooldown');

const COOLDOWN_MS = 5000; // short — these are cheap, instant local operations, unlike the AI upscale commands' 60s cooldown

// .silhouette hits the same kind of shared community Space
// providers/upscale.js's AI commands do (BRIA RMBG-2.0, not
// Real-ESRGAN, but the same "protect it from spam" reasoning) — so it
// gets that same longer cooldown instead of the 5s one above.
const SILHOUETTE_COOLDOWN_MS = 60000;
const DEPTH_COOLDOWN_MS = 60000;
const DEPTH_VIDEO_COOLDOWN_MS = 120000;
const DEPTH_VIDEO_SAMPLE_FPS = 3;
const DEPTH_VIDEO_OUTPUT_FPS = 12;
const DEPTH_VIDEO_MAX_SECONDS = 5;

const COLOR_MAP = {
    red: { r: 255, g: 0, b: 0 },
    blue: { r: 0, g: 0, b: 255 },
    green: { r: 0, g: 255, b: 0 },
    yellow: { r: 255, g: 255, b: 0 },
    purple: { r: 128, g: 0, b: 128 },
    orange: { r: 255, g: 165, b: 0 },
    pink: { r: 255, g: 192, b: 203 },
    cyan: { r: 0, g: 255, b: 255 },
    black: { r: 0, g: 0, b: 0 },
};

const HEX_COLOR_PATTERN = /^#?([0-9a-f]{6})$/i;

/**
 * Parses a color token from `.graph <color>` into an {r,g,b} object —
 * either a name from COLOR_MAP or a #RRGGBB hex code.
 *
 * @param {string} token
 * @returns {{r:number,g:number,b:number}|null}
 */
function parseColor(token) {

    const named = COLOR_MAP[token.toLowerCase()];
    if (named) return named;

    const hexMatch = token.match(HEX_COLOR_PATTERN);
    if (hexMatch) {
        const hex = hexMatch[1];
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
        };
    }

    return null;

}

/**
 * Shared runner for every local sharp-based edit — downloads the
 * quoted image, applies the given edit function, sends the JPEG
 * result, cleans up both temp files.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @param {string} cooldownKey
 * @param {(input: sharp.Sharp) => sharp.Sharp} applyEdit
 * @returns {Promise<void>}
 */
async function runImageEdit(sock, msg, cooldownKey, applyEdit) {

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
        console.error(`[${cooldownKey}] failed to download quoted image:`, err.message);
        media = null;
    }

    if (!media) {
        return await sock.sendMessage(chatId, {
            text: `⚠️ Reply to an image with this command.`,
        }, { quoted: msg });
    }

    setCooldown(sender, cooldownKey);

    const inputPath = saveBufferToTemp(media.buffer, media.mimeType);
    const outputPath = buildOutputPath(cooldownKey);

    try {

        const pipeline = applyEdit(sharp(inputPath)).jpeg({ quality: JPEG_QUALITY });
        await pipeline.toFile(outputPath);

        await sock.sendMessage(chatId, {
            image: { url: outputPath },
            mimetype: 'image/jpeg',
        }, { quoted: msg });

    } catch (err) {

        console.error(`[${cooldownKey}] edit failed:`, err.message);
        await sock.sendMessage(chatId, {
            text: `❌ Something went wrong processing that image.`,
        }, { quoted: msg });

    } finally {

        cleanupTempFile(inputPath);
        cleanupTempFile(outputPath);

    }

}

/**
 * .fix brightness <n> / .fix saturation <n> / .fix denoise
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function fixSubcommand(sock, msg, args) {

    const chatId = msg.key.remoteJid;
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'brightness' || sub === 'saturation') {

        const amount = Number(args[1]);

        if (!args[1] || isNaN(amount) || amount <= 0) {
            return await sock.sendMessage(chatId, {
                text:
`⚠️ Usage:

.fix ${sub} <percentage>

Example:
.fix ${sub} 130   (130% = brighter/more saturated)
.fix ${sub} 70    (70% = dimmer/less saturated)`,
            }, { quoted: msg });
        }

        const factor = amount / 100;

        return await runImageEdit(sock, msg, `fix-${sub}`, (img) =>
            img.modulate(sub === 'brightness' ? { brightness: factor } : { saturation: factor })
        );

    }

    if (sub === 'denoise') {
        return await runImageEdit(sock, msg, 'fix-denoise', (img) => img.median(3));
    }

    return await sock.sendMessage(chatId, {
        text:
`⚠️ Usage:

.fix brightness <n>
.fix saturation <n>
.fix denoise

(For AI-powered quality restoration instead, use .fix or .fixquality with no arguments.)`,
    }, { quoted: msg });

}

/**
 * .graph <color> / .graph inverse / .graph white / .graph depth
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function graphSubcommand(sock, msg, args) {

    const chatId = msg.key.remoteJid;
    const token = (args[0] || '').toLowerCase();

    if (!token) {
        return await sock.sendMessage(chatId, {
            text:
`⚠️ Usage:

.graph <color>     e.g. .graph red, .graph #ff8800
.graph inverse
.graph white
.graph depth
.graph depthvideo    (reply to a video)
.graph depth video   (same thing)`,
        }, { quoted: msg });
    }

    if (token === 'inverse') {
        return await runImageEdit(sock, msg, 'graph-inverse', (img) => img.negate());
    }

    if (token === 'white') {
        return await runImageEdit(sock, msg, 'graph-white', (img) => img.grayscale());
    }

    if (
        token === 'depthvideo' ||
        token === 'depthvid' ||
        (
            token === 'depth' &&
            String(args[1] || '').toLowerCase() === 'video'
        )
    ) {
        return await depthVideoCommand(
            sock,
            msg
        );
    }

    if (token === 'depth') {
        return await depthGraphCommand(
            sock,
            msg
        );
    }

    const color = parseColor(token);

    if (!color) {
        return await sock.sendMessage(chatId, {
            text:
`⚠️ Unknown color "${token}".

Try a name like: ${Object.keys(COLOR_MAP).join(', ')}
or a hex code like #ff8800.`,
        }, { quoted: msg });
    }

    return await runImageEdit(sock, msg, 'graph-color', (img) => img.tint(color));

}

async function depthVideoCommand(
    sock,
    msg
) {

    const chatId =
        msg.key.remoteJid;

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const remaining =
        checkCooldown(
            sender,
            'graph-depthvideo',
            DEPTH_VIDEO_COOLDOWN_MS
        );

    if (remaining) {
        return await sock.sendMessage(
            chatId,
            {
                text:
                    `⏳ Depth-video generation is cooling down. Try again in ${Math.ceil(remaining / 1000)}s.`
            },
            {
                quoted:
                    msg
            }
        );
    }

    let media;

    try {
        media =
            await getQuotedVideo(
                sock,
                msg
            );
    } catch (err) {
        console.error(
            '[.graph depthvideo] failed to download quoted video:',
            err.message
        );

        media =
            null;
    }

    if (!media) {
        return await sock.sendMessage(
            chatId,
            {
                text:
                    '⚠️ Reply to a video with *.graph depthvideo*.'
            },
            {
                quoted:
                    msg
            }
        );
    }

    setCooldown(
        sender,
        'graph-depthvideo'
    );

    const inputPath =
        saveVideoBufferToTemp(
            media.buffer,
            media.mimeType
        );

    const progress =
        await startProgress(
            sock,
            msg,
            '🎞️ Extracting video frames...'
        );

    let framesDir;
    let outputPath;

    try {

        const extracted =
            await extractVideoFrames(
                inputPath,
                {
                    fps:
                        DEPTH_VIDEO_SAMPLE_FPS,
                    maxDuration:
                        DEPTH_VIDEO_MAX_SECONDS,
                    maxWidth:
                        480
                }
            );

        framesDir =
            extracted.framesDir;

        const total =
            extracted.framePaths.length;

        await progress.update(
            `🌖 Estimating depth... 0/${total} frames`
        );

        for (
            let index = 0;
            index < total;
            index++
        ) {

            const framePath =
                extracted.framePaths[index];

            let depthPath;

            try {

                depthPath =
                    await generateDepthMap(
                        framePath
                    );

                const sourceMeta =
                    await sharp(
                        framePath
                    ).metadata();

                const targetPath =
                    require('path').join(
                        framesDir,
                        `depth-${String(index + 1).padStart(5, '0')}.png`
                    );

                await sharp(
                    depthPath
                )
                    .resize(
                        sourceMeta.width,
                        sourceMeta.height,
                        {
                            fit:
                                'fill'
                        }
                    )
                    .grayscale()
                    .png()
                    .toFile(
                        targetPath
                    );

            } finally {

                cleanupTempFile(
                    depthPath
                );

            }

            if (
                index === total - 1 ||
                index % 2 === 1
            ) {
                await progress.update(
                    `🌖 Estimating depth... ${index + 1}/${total} frames`
                );
            }

        }

        await progress.update(
            '🎬 Rebuilding depth video...'
        );

        outputPath =
            await buildVideoFromFrames(
                framesDir,
                inputPath,
                {
                    inputFps:
                        DEPTH_VIDEO_SAMPLE_FPS,
                    outputFps:
                        DEPTH_VIDEO_OUTPUT_FPS,
                    duration:
                        extracted.duration
                }
            );

        const trimmed =
            extracted.sourceDuration >
            extracted.duration +
                0.05;

        await sock.sendMessage(
            chatId,
            {
                video: {
                    url:
                        outputPath
                },
                mimetype:
                    'video/mp4',
                caption:
                    trimmed
                        ? `🌖 *Depth Video*\n\nProcessed the first ${DEPTH_VIDEO_MAX_SECONDS}s for this prototype.`
                        : '🌖 *Depth Video*'
            },
            {
                quoted:
                    msg
            }
        );

        await progress.succeed(
            '✅ Depth video ready'
        );

    } catch (err) {

        console.error(
            '[.graph depthvideo] failed:',
            err.message
        );

        await progress.fail(
            '❌ Depth-video generation failed'
        );

        await sock.sendMessage(
            chatId,
            {
                text:
                    '⚠️ I couldn\'t create the depth video right now. The depth service may be busy, or FFmpeg may have failed on this clip.'
            },
            {
                quoted:
                    msg
            }
        );

    } finally {

        cleanupTempFile(
            inputPath
        );

        cleanupTempFile(
            outputPath
        );

        cleanupTempDir(
            framesDir
        );

    }

}

async function depthGraphCommand(
    sock,
    msg
) {

    const chatId =
        msg.key.remoteJid;

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const remaining =
        checkCooldown(
            sender,
            'graph-depth',
            DEPTH_COOLDOWN_MS
        );

    if (remaining) {
        return await sock.sendMessage(
            chatId,
            {
                text:
                    `⏳ Depth generation is cooling down. Try again in ${Math.ceil(remaining / 1000)}s.`
            },
            {
                quoted:
                    msg
            }
        );
    }

    let media;

    try {
        media =
            await getQuotedImage(
                sock,
                msg
            );
    } catch (err) {
        console.error(
            '[.graph depth] failed to download quoted image:',
            err.message
        );

        media =
            null;
    }

    if (!media) {
        return await sock.sendMessage(
            chatId,
            {
                text:
                    '⚠️ Reply to an image with *.graph depth*.'
            },
            {
                quoted:
                    msg
            }
        );
    }

    setCooldown(
        sender,
        'graph-depth'
    );

    const inputPath =
        saveBufferToTemp(
            media.buffer,
            media.mimeType
        );

    const progress =
        await startProgress(
            sock,
            msg,
            '🌖 Estimating image depth...'
        );

    let depthPath;

    try {

        depthPath =
            await generateDepthMap(
                inputPath
            );

        await sock.sendMessage(
            chatId,
            {
                image: {
                    url:
                        depthPath
                },
                caption:
                    '🌖 *Depth Map*'
            },
            {
                quoted:
                    msg
            }
        );

        await progress.succeed(
            '✅ Depth map ready'
        );

    } catch (err) {

        console.error(
            '[.graph depth] failed:',
            err.message
        );

        await progress.fail(
            '❌ Depth generation failed'
        );

        await sock.sendMessage(
            chatId,
            {
                text:
                    '⚠️ I couldn\'t generate the depth map right now. The depth service may be busy or unavailable.'
            },
            {
                quoted:
                    msg
            }
        );

    } finally {

        cleanupTempFile(
            inputPath
        );

        cleanupTempFile(
            depthPath
        );

    }

}

/**
 * Takes a transparent-background image (RGBA — subject opaque,
 * background alpha=0) and produces a white-subject-on-solid-green
 * result. This is the fully-working half of .silhouette's pipeline —
 * see the header comment for the two-step Porter-Duff compositing
 * approach used here.
 *
 * @param {string} transparentImagePath - path to a transparent-background image
 * @returns {Promise<string>} absolute path to the finished JPEG
 */
async function compositeGreenScreenSilhouette(transparentImagePath) {

    const metadata = await sharp(transparentImagePath).metadata();
    const { width, height } = metadata;

    // Step A: white canvas, cut to the subject's exact shape via 'dest-in'
    const whiteSilhouette = await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
    })
        .composite([{ input: transparentImagePath, blend: 'dest-in' }])
        .png()
        .toBuffer();

    // Step B: lay the white cutout over a solid green canvas
    const outputPath = buildOutputPath('silhouette');

    await sharp({
        create: {
            width,
            height,
            channels: 3,
            background: { r: 0, g: 255, b: 0 },
        },
    })
        .composite([{ input: whiteSilhouette }])
        .jpeg({ quality: JPEG_QUALITY })
        .toFile(outputPath);

    return outputPath;

}

/**
 * .silhouette — removes the background (providers/removebg.js), then
 * composites the result into a white-subject-on-green silhouette
 * (compositeGreenScreenSilhouette above). Not routed through
 * runImageEdit() like the other commands in this file, since this is
 * an async multi-stage pipeline (external Space call + local
 * compositing) rather than a single synchronous sharp transform.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @returns {Promise<void>}
 */
async function silhouetteCommand(sock, msg) {

    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;

    const remaining = checkCooldown(sender, 'silhouette', SILHOUETTE_COOLDOWN_MS);

    if (remaining) {
        return await sock.sendMessage(chatId, {
            text: `⏳ Slow down! Try again in ${Math.ceil(remaining / 1000)}s.`,
        }, { quoted: msg });
    }

    let media;
    try {
        media = await getQuotedImage(sock, msg);
    } catch (err) {
        console.error('[.silhouette] failed to download quoted image:', err.message);
        media = null;
    }

    if (!media) {
        return await sock.sendMessage(chatId, {
            text: `⚠️ Reply to an image with this command.`,
        }, { quoted: msg });
    }

    setCooldown(sender, 'silhouette');

    const inputPath = saveBufferToTemp(media.buffer, media.mimeType);

    const progress = await startProgress(
        sock,
        msg,
        `🔎 Removing background... this can take a minute, especially on the first run.`
    );

    let transparentPath; // stage 1 output — removeBackground()
    let finalPath;        // stage 2 output — compositeGreenScreenSilhouette()

    try {

        transparentPath = await removeBackground(inputPath);
        finalPath = await compositeGreenScreenSilhouette(transparentPath);

        await sock.sendMessage(chatId, {
            image: { url: finalPath },
            mimetype: 'image/jpeg',
        }, { quoted: msg });

        await progress.succeed();

    } catch (err) {

        console.error('[.silhouette] failed:', err.message);
        await progress.fail();

    } finally {

        cleanupTempFile(inputPath);
        cleanupTempFile(transparentPath);
        cleanupTempFile(finalPath);

    }

}

/**
 * Router — mirrors the (sock, msg, text) shape used elsewhere in the
 * codebase. Only called for text starting with ".fix " (a real
 * subcommand follows — bare ".fix"/".fixquality" are handled by
 * commands/upscle.js instead), ".graph", or exactly ".silhouette" —
 * see index.js's routing branch for the exact dispatch condition.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @param {string} text
 * @returns {Promise<void>}
 */
async function graphicsCommands(sock, msg, text) {

    if (text.startsWith('.fix ')) {
        const args = text.replace('.fix', '').trim().split(/\s+/);
        return await fixSubcommand(sock, msg, args);
    }

    if (text.startsWith('.graph')) {
        const args = text.replace('.graph', '').trim().split(/\s+/).filter(Boolean);
        return await graphSubcommand(sock, msg, args);
    }

    if (text === '.silhouette') {
        return await silhouetteCommand(sock, msg);
    }

}

module.exports = { graphicsCommands, compositeGreenScreenSilhouette };