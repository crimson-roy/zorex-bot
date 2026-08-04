/**
 * lib/imageHelpers.js
 *
 * Shared helpers for any command that downloads a quoted WhatsApp
 * image, processes it (locally via sharp, or via an external
 * provider), and sends a JPEG result back.
 *
 * Pulled out of commands/upscle.js once commands/graphics.js needed
 * the exact same download/cleanup/convert logic — see each command
 * file for what it actually does with these; this file only owns the
 * shared plumbing, no command-specific logic.
 *
 * NOTE: downloadMediaMessage is required directly from
 * @whiskeysockets/baileys via a plain require() — NOT a dynamic
 * `await import(...)`. This project is CommonJS and Baileys ships ESM;
 * requiring the specific named export this way works fine (same
 * pattern already used successfully in commands/ai.js and the
 * pre-refactor commands/upscle.js) — do not change this to a top-level
 * `await import()`, which previously caused
 * "SyntaxError: await is only valid in async functions".
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const sharp = require('sharp');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const TEMP_DIR = path.join(os.tmpdir(), 'zorex-image-commands');
const JPEG_QUALITY = 92; // high quality — this is the final delivered image, not a thumbnail

const IMAGE_EXT_BY_MIME = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
};

/**
 * Ensures the shared temp directory exists.
 * @returns {void}
 */
function ensureTempDir() {
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
}

/**
 * Removes a temp file if it exists, swallowing any error — cleanup
 * should never mask the real result of a command.
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
 * Pulls the quoted message's image out of a reply. Returns null if the
 * reply isn't to an image, or isn't a reply at all.
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
 * Writes a downloaded image buffer to a temp file with an extension
 * matching its real mimetype, returning the local path.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {string} absolute local file path
 */
function saveBufferToTemp(buffer, mimeType) {
    ensureTempDir();
    const ext = IMAGE_EXT_BY_MIME[mimeType] || '.jpg';
    const filePath = path.join(TEMP_DIR, `${crypto.randomBytes(6).toString('hex')}-in${ext}`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

/**
 * Builds a fresh output path in the shared temp dir for a command to
 * write its result to (e.g. via sharp's .toFile()).
 *
 * @param {string} [suffix] - short label for debugging, e.g. "brightness"
 * @returns {string} absolute local file path ending in .jpg
 */
function buildOutputPath(suffix = 'out') {
    ensureTempDir();
    return path.join(TEMP_DIR, `${crypto.randomBytes(6).toString('hex')}-${suffix}.jpg`);
}

/**
 * Converts an existing image file (any format sharp can read — .webp,
 * .png, etc.) to a real, re-encoded JPEG file — not a rename. Needed
 * because WhatsApp's mobile client doesn't reliably render some
 * formats (.webp especially) sent as a regular "image" message, even
 * though WhatsApp Web does.
 *
 * @param {string} sourcePath
 * @returns {Promise<string>} absolute path to the converted .jpg file
 */
async function convertToJpeg(sourcePath) {
    const jpegPath = buildOutputPath('converted');
    await sharp(sourcePath).jpeg({ quality: JPEG_QUALITY }).toFile(jpegPath);
    return jpegPath;
}

module.exports = {
    TEMP_DIR,
    JPEG_QUALITY,
    IMAGE_EXT_BY_MIME,
    ensureTempDir,
    cleanupTempFile,
    getQuotedImage,
    saveBufferToTemp,
    buildOutputPath,
    convertToJpeg,
};
