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

async function imageToSticker(buffer) {
    return sharp(buffer, { animated: true })
        .resize(512, 512, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .webp({
            quality: 88,
            effort: 4
        })
        .toBuffer();
}

async function videoToSticker(media) {
    const input =
        tempPath(
            extensionForMime(media.mimeType, '.mp4'),
            'video-in'
        );

    const output =
        tempPath('.webp', 'sticker-out');

    fs.writeFileSync(input, media.buffer);

    try {
        await runFFmpeg([
            '-y',
            '-i', input,
            '-t', '10',
            '-vf',
            'fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
            '-an',
            '-vcodec', 'libwebp',
            '-lossless', '0',
            '-q:v', '60',
            '-preset', 'default',
            '-loop', '0',
            '-vsync', '0',
            '-loglevel', 'error',
            output
        ]);

        return fs.readFileSync(output);

    } finally {
        cleanup(input, output);
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
            command === '.sticker'
                ? 'Reply to an image or video with *.sticker*.'
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
        if (command === '.sticker') {

            if (media.kind === 'sticker') {
                return sock.sendMessage(
                    chatId,
                    { sticker: media.buffer },
                    { quoted: msg }
                );
            }

            const stickerBuffer =
                media.kind === 'video'
                    ? await videoToSticker(media)
                    : await imageToSticker(media.buffer);

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
