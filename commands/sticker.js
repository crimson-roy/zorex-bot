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
    const rawWords = String(value || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    if (!rawWords.length) return [];

    // Split unusually long single words too, so even usernames / meme text
    // without spaces cannot run outside the 512x512 sticker.
    const words = [];

    for (const rawWord of rawWords) {
        let word = rawWord;

        while (word.length > maxChars) {
            words.push(
                word.slice(0, maxChars)
            );

            word =
                word.slice(maxChars);
        }

        if (word) {
            words.push(word);
        }
    }

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

function clamp(value, min, max) {
    return Math.max(
        min,
        Math.min(max, value)
    );
}

function fittedFontSize(
    lines,
    {
        baseSize,
        minSize,
        maxWidth,
        widthFactor = 0.62,
        linePenalty = 2
    }
) {
    if (
        !Array.isArray(lines) ||
        lines.length === 0
    ) {
        return baseSize;
    }

    const longestLine =
        lines.reduce(
            (max, line) =>
                Math.max(
                    max,
                    String(line || '').length
                ),
            0
        ) || 1;

    const estimated =
        Math.floor(
            maxWidth /
            (
                longestLine *
                widthFactor
            )
        ) -
        (
            (lines.length - 1) *
            linePenalty
        );

    return clamp(
        estimated,
        minSize,
        baseSize
    );
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

const DEFAULT_STICKER_PACK =
    'Zorex Stickers';

const DEFAULT_STICKER_AUTHOR =
    'Zorex';

function makeWebpChunk(type, payload) {
    const data =
        Buffer.isBuffer(payload)
            ? payload
            : Buffer.from(payload || []);

    const header =
        Buffer.alloc(8);

    header.write(
        type,
        0,
        4,
        'ascii'
    );

    header.writeUInt32LE(
        data.length,
        4
    );

    const padding =
        data.length % 2
            ? Buffer.from([0])
            : Buffer.alloc(0);

    return Buffer.concat([
        header,
        data,
        padding
    ]);
}

function parseWebpChunks(buffer) {
    if (
        !Buffer.isBuffer(buffer) ||
        buffer.length < 12 ||
        buffer.toString('ascii', 0, 4) !== 'RIFF' ||
        buffer.toString('ascii', 8, 12) !== 'WEBP'
    ) {
        throw new Error(
            'Invalid WebP sticker buffer.'
        );
    }

    const chunks = [];
    let offset = 12;

    while (offset + 8 <= buffer.length) {
        const type =
            buffer.toString(
                'ascii',
                offset,
                offset + 4
            );

        const size =
            buffer.readUInt32LE(
                offset + 4
            );

        const start =
            offset + 8;

        const end =
            start + size;

        if (end > buffer.length) {
            throw new Error(
                'Invalid WebP chunk length.'
            );
        }

        chunks.push({
            type,
            data:
                Buffer.from(
                    buffer.subarray(
                        start,
                        end
                    )
                )
        });

        offset =
            end +
            (size % 2);
    }

    return chunks;
}

function read24LE(buffer, offset) {
    return (
        buffer[offset] |
        (buffer[offset + 1] << 8) |
        (buffer[offset + 2] << 16)
    );
}

function write24LE(buffer, value, offset) {
    buffer[offset] =
        value & 0xff;

    buffer[offset + 1] =
        (value >> 8) & 0xff;

    buffer[offset + 2] =
        (value >> 16) & 0xff;
}

function getWebpCanvasSize(chunks) {
    const vp8x =
        chunks.find(
            chunk =>
                chunk.type === 'VP8X'
        );

    if (
        vp8x &&
        vp8x.data.length >= 10
    ) {
        return {
            width:
                read24LE(
                    vp8x.data,
                    4
                ) + 1,
            height:
                read24LE(
                    vp8x.data,
                    7
                ) + 1
        };
    }

    const vp8 =
        chunks.find(
            chunk =>
                chunk.type === 'VP8 '
        );

    if (
        vp8 &&
        vp8.data.length >= 10
    ) {
        return {
            width:
                vp8.data
                    .readUInt16LE(6) &
                0x3fff,
            height:
                vp8.data
                    .readUInt16LE(8) &
                0x3fff
        };
    }

    const vp8l =
        chunks.find(
            chunk =>
                chunk.type === 'VP8L'
        );

    if (
        vp8l &&
        vp8l.data.length >= 5
    ) {
        const bits =
            vp8l.data
                .readUInt32LE(1);

        return {
            width:
                (bits & 0x3fff) + 1,
            height:
                ((bits >>> 14) & 0x3fff) + 1
        };
    }

    throw new Error(
        'Could not determine WebP canvas size.'
    );
}

function hasVp8lAlpha(chunks) {
    const vp8l =
        chunks.find(
            chunk =>
                chunk.type === 'VP8L'
        );

    if (
        !vp8l ||
        vp8l.data.length < 5
    ) {
        return false;
    }

    const bits =
        vp8l.data
            .readUInt32LE(1);

    return Boolean(
        (bits >>> 28) & 1
    );
}

function buildStickerExif(
    packName,
    author
) {
    const json = {
        'sticker-pack-id':
            'zorex-ai',
        'sticker-pack-name':
            packName,
        'sticker-pack-publisher':
            author,
        emojis:
            ['']
    };

    const exifAttr =
        Buffer.from([
            0x49, 0x49, 0x2a, 0x00,
            0x08, 0x00, 0x00, 0x00,
            0x01, 0x00, 0x41, 0x57,
            0x07, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x16, 0x00,
            0x00, 0x00
        ]);

    const jsonBuffer =
        Buffer.from(
            JSON.stringify(json),
            'utf8'
        );

    exifAttr.writeUIntLE(
        jsonBuffer.length,
        14,
        4
    );

    return Buffer.concat([
        exifAttr,
        jsonBuffer
    ]);
}

function addStickerMetadata(
    webpBuffer,
    packName,
    author
) {
    let chunks =
        parseWebpChunks(
            webpBuffer
        )
            .filter(
                chunk =>
                    chunk.type !== 'EXIF'
            );

    const canvas =
        getWebpCanvasSize(
            chunks
        );

    let vp8xIndex =
        chunks.findIndex(
            chunk =>
                chunk.type === 'VP8X'
        );

    if (vp8xIndex >= 0) {
        const data =
            Buffer.from(
                chunks[vp8xIndex].data
            );

        if (data.length < 10) {
            throw new Error(
                'Invalid VP8X chunk.'
            );
        }

        // VP8X EXIF-present flag.
        data[0] |= 0x08;

        chunks[vp8xIndex] = {
            type: 'VP8X',
            data
        };

    } else {
        const data =
            Buffer.alloc(10);

        let flags =
            0x08; // EXIF

        if (
            chunks.some(
                chunk =>
                    chunk.type === 'ICCP'
            )
        ) {
            flags |= 0x20;
        }

        if (
            chunks.some(
                chunk =>
                    chunk.type === 'ALPH'
            ) ||
            hasVp8lAlpha(chunks)
        ) {
            flags |= 0x10;
        }

        if (
            chunks.some(
                chunk =>
                    chunk.type === 'XMP '
            )
        ) {
            flags |= 0x04;
        }

        if (
            chunks.some(
                chunk =>
                    chunk.type === 'ANIM' ||
                    chunk.type === 'ANMF'
            )
        ) {
            flags |= 0x02;
        }

        data[0] =
            flags;

        write24LE(
            data,
            canvas.width - 1,
            4
        );

        write24LE(
            data,
            canvas.height - 1,
            7
        );

        chunks.unshift({
            type: 'VP8X',
            data
        });
    }

    chunks.push({
        type: 'EXIF',
        data:
            buildStickerExif(
                packName,
                author
            )
    });

    const body =
        Buffer.concat(
            chunks.map(
                chunk =>
                    makeWebpChunk(
                        chunk.type,
                        chunk.data
                    )
            )
        );

    const riffHeader =
        Buffer.alloc(12);

    riffHeader.write(
        'RIFF',
        0,
        4,
        'ascii'
    );

    riffHeader.writeUInt32LE(
        body.length + 4,
        4
    );

    riffHeader.write(
        'WEBP',
        8,
        4,
        'ascii'
    );

    return Buffer.concat([
        riffHeader,
        body
    ]);
}

async function createStickerTextOverlay(
    mainText
) {
    if (!mainText) {
        return null;
    }

    const mainLines =
        wrapText(
            mainText,
            18,
            3
        );

    const mainFontSize =
        fittedFontSize(
            mainLines,
            {
                baseSize: 56,
                minSize: 24,
                maxWidth: 452,
                widthFactor: 0.63,
                linePenalty: 3
            }
        );

    const mainStrokeWidth =
        Math.max(
            4,
            Math.round(
                mainFontSize * 0.12
            )
        );

    const mainGap =
        Math.round(
            mainFontSize * 1.08
        );

    const mainStartY =
        Math.max(
            52,
            78 -
            (
                (mainLines.length - 1) *
                10
            )
        );

    const mainSvg =
        mainLines
            .map(
                (line, index) =>
                    `<text x="256" y="${mainStartY + (index * mainGap)}" text-anchor="middle" font-family="sans-serif" font-size="${mainFontSize}" font-weight="800" fill="white" stroke="black" stroke-width="${mainStrokeWidth}" paint-order="stroke fill" stroke-linejoin="round">${escapeXml(line)}</text>`
            )
            .join('');

    const svg =
        `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">${mainSvg}</svg>`;

    return sharp(
        Buffer.from(svg)
    )
        .png()
        .toBuffer();
}

async function imageToSticker(
    buffer,
    mainText = ''
) {
    const overlay =
        await createStickerTextOverlay(
            mainText
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
    mainText = ''
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
                mainText
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
    const framesDir =
        path.join(
            TEMP_DIR,
            crypto.randomBytes(6).toString('hex') + '-sticker-frames'
        );

    fs.writeFileSync(input, buffer);

    let metadata = null;

    try {
        metadata =
            await sharp(
                buffer,
                { animated: true }
            ).metadata();
    } catch (_) {}

    const pages =
        Math.max(
            1,
            Number(metadata?.pages) || 1
        );

    try {
        if (pages <= 1) {
            await runFFmpeg([
                '-y',
                '-loop', '1',
                '-i', input,
                '-vf',
                'scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-t', '3',
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '23',
                '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart',
                '-an',
                '-loglevel', 'error',
                output
            ]);

            return fs.readFileSync(output);
        }

        // WhatsApp "video stickers" are animated WebP files. Some FFmpeg
        // builds do not preserve their animation/timing reliably when the
        // WebP is passed straight in, so decode each page with Sharp first
        // and feed FFmpeg a timed concat sequence.
        fs.mkdirSync(
            framesDir,
            { recursive: true }
        );

        const delays =
            Array.isArray(metadata?.delay)
                ? metadata.delay
                : [];

        const manifest = [];

        for (let i = 0; i < pages; i++) {
            const frameName =
                'frame-' +
                String(i).padStart(5, '0') +
                '.png';

            const framePath =
                path.join(
                    framesDir,
                    frameName
                );

            await sharp(
                buffer,
                {
                    animated: true,
                    page: i,
                    pages: 1
                }
            )
                .png()
                .toFile(
                    framePath
                );

            const delayMs =
                Math.max(
                    20,
                    Number(delays[i]) ||
                    100
                );

            manifest.push(
                `file '${frameName}'`
            );

            manifest.push(
                'duration ' +
                (delayMs / 1000)
                    .toFixed(6)
            );
        }

        // The concat demuxer ignores the final duration unless the last
        // frame is repeated once.
        manifest.push(
            `file 'frame-${String(pages - 1).padStart(5, '0')}.png'`
        );

        const manifestPath =
            path.join(
                framesDir,
                'frames.txt'
            );

        fs.writeFileSync(
            manifestPath,
            manifest.join('\n') + '\n',
            'utf8'
        );

        await runFFmpeg([
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', manifestPath,
            '-vf',
            'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-vsync', 'vfr',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-an',
            '-loglevel', 'error',
            output
        ]);

        return fs.readFileSync(output);

    } finally {
        cleanup(input, output);

        try {
            fs.rmSync(
                framesDir,
                {
                    recursive: true,
                    force: true
                }
            );
        } catch (_) {}
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

            let stickerBuffer;

            if (
                media.kind === 'sticker' &&
                !mainText &&
                captionText
            ) {
                // Author-only change: preserve the existing sticker frames
                // and simply replace its WhatsApp sticker metadata.
                stickerBuffer =
                    media.buffer;

            } else {
                stickerBuffer =
                    media.kind === 'video'
                        ? await videoToSticker(
                            media,
                            mainText
                        )
                        : await imageToSticker(
                            media.buffer,
                            mainText
                        );
            }

            stickerBuffer =
                addStickerMetadata(
                    stickerBuffer,
                    DEFAULT_STICKER_PACK,
                    captionText ||
                    DEFAULT_STICKER_AUTHOR
                );

            return sock.sendMessage(
                chatId,
                {
                    sticker:
                        stickerBuffer
                },
                {
                    quoted: msg
                }
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
