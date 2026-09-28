'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sharp = require('sharp');

const TEMP_DIR = path.join(os.tmpdir(), 'zorex-sticker-tools');

function ensureTempDir() {
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
}

function tempPath(ext, label = 'media') {
    ensureTempDir();
    return path.join(
        TEMP_DIR,
        `${crypto.randomBytes(6).toString('hex')}-${label}${ext}`
    );
}

function cleanup(...files) {
    for (const file of files) {
        if (!file) continue;
        try {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch (_) {}
    }
}

function runFFmpeg(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', args, {
            stdio: ['ignore', 'ignore', 'pipe']
        });

        let stderr = '';

        proc.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });

        proc.on('error', reject);

        proc.on('close', code => {
            if (code === 0) return resolve();
            reject(
                new Error(
                    `ffmpeg exited with code ${code}: ${stderr.slice(-1800)}`
                )
            );
        });
    });
}

async function getQuotedMedia(msg) {
    const context =
        msg.message?.extendedTextMessage?.contextInfo ||
        msg.message?.imageMessage?.contextInfo ||
        msg.message?.videoMessage?.contextInfo ||
        msg.message?.stickerMessage?.contextInfo;

    const quoted = context?.quotedMessage;

    if (!quoted) return null;

    let kind = null;
    let mimeType = null;

    if (quoted.imageMessage) {
        kind = 'image';
        mimeType = quoted.imageMessage.mimetype || 'image/jpeg';
    } else if (quoted.videoMessage) {
        kind = 'video';
        mimeType = quoted.videoMessage.mimetype || 'video/mp4';
    } else if (quoted.stickerMessage) {
        kind = 'sticker';
        mimeType = quoted.stickerMessage.mimetype || 'image/webp';
    } else {
        return null;
    }

    const fakeMsg = {
        key: {
            remoteJid: msg.key.remoteJid,
            id: context.stanzaId,
            participant: context.participant,
            fromMe: false
        },
        message: quoted
    };

    const { downloadMediaMessage } =
        await import('@whiskeysockets/baileys');

    const buffer =
        await downloadMediaMessage(fakeMsg, 'buffer', {});

    return {
        kind,
        mimeType,
        buffer
    };
}

function extensionForMime(mimeType, fallback) {
    const mime = String(mimeType || '').toLowerCase();

    if (mime.includes('png')) return '.png';
    if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
    if (mime.includes('webp')) return '.webp';
    if (mime.includes('gif')) return '.gif';
    if (mime.includes('quicktime')) return '.mov';
    if (mime.includes('3gpp')) return '.3gp';
    if (mime.includes('mp4')) return '.mp4';

    return fallback;
}

function escapeXml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function wrapText(value, maxChars = 18, maxLines = 3) {
    const words = String(value || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    if (!words.length) return [];

    const lines = [];
    let current = '';

    for (const word of words) {
        const candidate =
            current
                ? `${current} ${word}`
                : word;

        if (
            candidate.length <= maxChars ||
            !current
        ) {
            current = candidate;
            continue;
        }

        lines.push(current);
        current = word;

        if (lines.length >= maxLines - 1) {
            break;
        }
    }

    if (
        current &&
        lines.length < maxLines
    ) {
        lines.push(current);
    }

    return lines;
}

function parseStickerText(text) {
    const body =
        String(text || '')
            .replace(/^\.(?:sticker|s)\b/i, '')
            .trim();

    if (!body) {
        return {
            mainText: '',
            captionText: ''
        };
    }

    const captionMatch =
        body.match(/\(([^()]*)\)\s*$/);

    if (!captionMatch) {
        return {
            mainText: body,
            captionText: ''
        };
    }

    return {
        mainText:
            body
                .slice(
                    0,
                    captionMatch.index
                )
                .trim(),
        captionText:
            captionMatch[1]
                .trim()
    };
}

async function createStickerTextOverlay(
    mainText,
    captionText
) {
    if (!mainText && !captionText) {
        return null;
    }

    const mainLines =
        wrapText(
            mainText,
            18,
            3
        );

    const captionLines =
        wrapText(
            captionText,
            28,
            2
        );

    const mainFontSize =
        mainLines.length > 1
            ? 48
            : 56;

    const mainStartY = 54;
    const mainGap =
        Math.round(
            mainFontSize * 1.05
        );

    const captionFontSize = 28;
    const captionGap = 32;
    const captionStartY =
        476 -
        (
            Math.max(
                captionLines.length - 1,
                0
            ) *
            captionGap
        );

    const mainSvg =
        mainLines
            .map(
                (line, index) =>
                    `<text x="256" y="${mainStartY + (index * mainGap)}" text-anchor="middle" font-family="sans-serif" font-size="${mainFontSize}" font-weight="800" fill="white" stroke="black" stroke-width="7" paint-order="stroke fill" stroke-linejoin="round">${escapeXml(line)}</text>`
            )
            .join('');

    const captionSvg =
        captionLines
            .map(
                (line, index) =>
                    `<text x="256" y="${captionStartY + (index * captionGap)}" text-anchor="middle" font-family="sans-serif" font-size="${captionFontSize}" font-weight="700" fill="white" stroke="black" stroke-width="5" paint-order="stroke fill" stroke-linejoin="round">${escapeXml(line)}</text>`
            )
            .join('');

    const svg =
        `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">${mainSvg}${captionSvg}</svg>`;

    return sharp(
        Buffer.from(svg)
    )
        .png()
        .toBuffer();
}

async function imageToSticker(
    buffer,
    mainText = '',
    captionText = ''
) {
    const overlay =
        await createStickerTextOverlay(
            mainText,
            captionText
        );

    let pipeline =
        sharp(
            buffer,
            { animated: false }
        )
            .resize(
                512,
                512,
                {
                    fit: 'cover',
                    position: 'centre'
                }
            );

    if (overlay) {
        pipeline =
            pipeline.composite([
                {
                    input: overlay,
                    top: 0,
                    left: 0
                }
            ]);
    }

    return pipeline
        .webp({
            quality: 88,
            effort: 4
        })
        .toBuffer();
}

async function videoToSticker(
    media,
    mainText = '',
    captionText = ''
) {
    const input =
        tempPath(
            extensionForMime(media.mimeType, '.mp4'),
            'video-in'
        );

    const output =
        tempPath('.webp', 'sticker-out');

    const overlayPath =
        tempPath('.png', 'sticker-overlay');

    fs.writeFileSync(input, media.buffer);

    try {
        const overlay =
            await createStickerTextOverlay(
                mainText,
                captionText
            );

        if (overlay) {
            fs.writeFileSync(
                overlayPath,
                overlay
            );
        }

        const args = [
            '-y',
            '-i', input
        ];

        if (overlay) {
            args.push(
                '-i',
                overlayPath
            );
        }

        args.push(
            '-t', '10',
            '-filter_complex',
            overlay
                ? '[0:v]fps=15,scale=512:512:force_original_aspect_ratio=increase,crop=512:512[base];[base][1:v]overlay=0:0:shortest=1[out]'
                : '[0:v]fps=15,scale=512:512:force_original_aspect_ratio=increase,crop=512:512[out]',
            '-map', '[out]',
            '-an',
            '-vcodec', 'libwebp',
            '-lossless', '0',
            '-q:v', '60',
            '-preset', 'default',
            '-loop', '0',
            '-vsync', '0',
            '-loglevel', 'error',
            output
        );

        await runFFmpeg(args);

        return fs.readFileSync(output);

    } finally {
        cleanup(
            input,
            output,
            overlayPath
        );
    }
}

async function stickerToImage(buffer) {
    return sharp(buffer, { animated: false })
        .png()
        .toBuffer();
}

async function stickerToVideo(buffer) {
    const input = tempPath('.webp', 'sticker-in');
    const output = tempPath('.mp4', 'video-out');

    fs.writeFileSync(input, buffer);

    let pages = 1;

    try {
        const metadata =
            await sharp(buffer, { animated: true }).metadata();

        pages = Number(metadata.pages) || 1;
    } catch (_) {}

    try {
        const args = ['-y'];

        if (pages <= 1) {
            args.push('-loop', '1');
        }

        args.push(
            '-i', input,
            '-vf',
            'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart'
        );

        if (pages <= 1) {
            args.push('-t', '3');
        }

        args.push(
            '-an',
            '-loglevel', 'error',
            output
        );

        await runFFmpeg(args);

        return fs.readFileSync(output);

    } finally {
        cleanup(input, output);
    }
}

async function stickerCommands(sock, msg, text) {
    const chatId = msg.key.remoteJid;
    const command =
        String(text || '')
            .trim()
            .split(/\s+/)[0]
            .toLowerCase();

    const isStickerCommand =
        command === '.sticker' ||
        command === '.s';

    const {
        mainText,
        captionText
    } =
        isStickerCommand
            ? parseStickerText(text)
            : {
                mainText: '',
                captionText: ''
            };

    let media;

    try {
        media = await getQuotedMedia(msg);
    } catch (err) {
        console.error('[sticker tools] media download failed:', err);

        return sock.sendMessage(
            chatId,
            {
                text:
                    '❌ I could not download that media. Try replying to it again.'
            },
            { quoted: msg }
        );
    }

    if (!media) {
        const help =
            isStickerCommand
                ? 'Reply to an image or video with *.sticker* or *.s*. You can also add text, e.g. *.s Legend (Made by Zorex)*.'
                : command === '.tovid'
                    ? 'Reply to a sticker with *.tovid*.'
                    : 'Reply to a sticker with *.toimage* (or *.toimg*).';

        return sock.sendMessage(
            chatId,
            { text: `⚠️ ${help}` },
            { quoted: msg }
        );
    }

    try {
        if (isStickerCommand) {

            if (
                media.kind === 'sticker' &&
                !mainText &&
                !captionText
            ) {
                return sock.sendMessage(
                    chatId,
                    { sticker: media.buffer },
                    { quoted: msg }
                );
            }

            const stickerBuffer =
                media.kind === 'video'
                    ? await videoToSticker(
                        media,
                        mainText,
                        captionText
                    )
                    : await imageToSticker(
                        media.buffer,
                        mainText,
                        captionText
                    );

            return sock.sendMessage(
                chatId,
                { sticker: stickerBuffer },
                { quoted: msg }
            );
        }

        if (command === '.toimage' || command === '.toimg') {

            if (media.kind !== 'sticker') {
                return sock.sendMessage(
                    chatId,
                    {
                        text:
                            '⚠️ *.toimage* only works when you reply to a sticker.'
                    },
                    { quoted: msg }
                );
            }

            const imageBuffer =
                await stickerToImage(media.buffer);

            return sock.sendMessage(
                chatId,
                {
                    image: imageBuffer,
                    mimetype: 'image/png',
                    caption: '🖼️ Sticker converted to image.'
                },
                { quoted: msg }
            );
        }

        if (command === '.tovid') {

            if (media.kind !== 'sticker') {
                return sock.sendMessage(
                    chatId,
                    {
                        text:
                            '⚠️ *.tovid* only works when you reply to a sticker.'
                    },
                    { quoted: msg }
                );
            }

            const videoBuffer =
                await stickerToVideo(media.buffer);

            return sock.sendMessage(
                chatId,
                {
                    video: videoBuffer,
                    mimetype: 'video/mp4',
                    caption: '🎬 Sticker converted to video.'
                },
                { quoted: msg }
            );
        }

    } catch (err) {
        console.error('[sticker tools] conversion failed:', err);

        return sock.sendMessage(
            chatId,
            {
                text:
                    '❌ Conversion failed. Make sure the media is valid and FFmpeg is available.'
            },
            { quoted: msg }
        );
    }
}

module.exports = {
    stickerCommands
};
