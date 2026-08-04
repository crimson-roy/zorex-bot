/**
 * providers/removebg.js
 *
 * Background Removal Provider (Zorex Bot)
 * ------------------------------------------
 * Thin integration with the briaai/BRIA-RMBG-2.0 Hugging Face Space,
 * following the same shape as providers/upscale.js (see that file's
 * header comment for the general "why a Space, not an official API"
 * reasoning — the same logic applies here: this depends on one Space
 * staying up rather than a guaranteed official endpoint, so if it goes
 * down, swap SPACE_NAME — nothing outside this file needs to change,
 * since removeBackground() is the only thing callers touch).
 *
 * ---------------------------------------------------------------------
 * CONFIRMED API SCHEMA
 * ---------------------------------------------------------------------
 * Unlike providers/upscale.js's endpoint mapping (which shipped
 * unconfirmed, pending a manual verification step), this Space's
 * schema is already confirmed:
 *
 *   endpoint: /image
 *   input:    a single handle_file() image
 *   output:   result.data is a 2-element array — data[0] is NOT the
 *             image we want; data[1] is the transparent-background
 *             PNG output. Read index 1, not 0.
 *
 * ---------------------------------------------------------------------
 * RETURN CONTRACT — MATCHES commands/graphics.js's TODO EXACTLY
 * ---------------------------------------------------------------------
 * graphics.js's silhouetteCommand() TODO comment calls this as:
 *
 *   const transparentPath = await removeBackground(inputPath);
 *
 * i.e. it expects a plain string (the local file path) back directly —
 * NOT an { filePath, ... } object like upscaleImage() returns. That's
 * a deliberate difference from upscale.js's shape: this provider only
 * ever does one thing with one output, so there's no `label`-style
 * second piece of metadata worth wrapping in an object for. Kept as a
 * bare string specifically to match the already-committed call site.
 *
 * Usage:
 *   const { removeBackground } = require('./providers/removebg');
 *   const transparentPath = await removeBackground('/path/to/image.jpg');
 *   // transparentPath -> local path to a transparent-background PNG
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Client, handle_file } = require('@gradio/client');

const SPACE_NAME = 'briaai/BRIA-RMBG-2.0';
const ENDPOINT = '/image';

const CONNECT_TIMEOUT_MS = 30000; // Space cold starts can be slow on first call
const PREDICT_TIMEOUT_MS = 90000; // background removal can take a while on shared CPU

const TEMP_DIR = path.join(os.tmpdir(), 'zorex-removebg-provider');

/* -------------------------------------------------------------------- */
/*  Utilities                                                            */
/* -------------------------------------------------------------------- */

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

/**
 * Races a promise against a timeout, rejecting with a descriptive error
 * if the timeout wins. Same pattern as providers/upscale.js — kept as
 * its own local copy rather than a shared import, consistent with how
 * the other providers in this codebase (spotify.js/youtube.js/
 * tiktok.js/upscale.js) each own their own small utility helpers
 * instead of depending on one another.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} operationLabel
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs, operationLabel) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Removebg provider: ${operationLabel} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Downloads the Space's output image (a hosted URL) to a local temp
 * file, so callers get a normal filesystem path — same contract as
 * upscale.js's downloadToTemp().
 *
 * @param {string} url
 * @returns {Promise<string>} absolute local file path
 */
async function downloadToTemp(url) {
  ensureTempDir();

  const urlExt = path.extname(new URL(url).pathname);
  const ext = urlExt || '.png';
  const destPath = path.join(TEMP_DIR, `${crypto.randomBytes(6).toString('hex')}${ext}`);

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Removebg provider: failed to download result image (HTTP ${res.status})`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);

  return destPath;
}

/**
 * Connects to the Space. Isolated so retry/reconnect logic can be added
 * later without touching call sites.
 *
 * @returns {Promise<import('@gradio/client').Client>}
 */
async function connectToSpace() {
  try {
    return await withTimeout(
      Client.connect(SPACE_NAME, {
        token: process.env.HUGGINGFACE_API_TOKEN,
      }),
      CONNECT_TIMEOUT_MS,
      `connecting to ${SPACE_NAME}`
    );
  } catch (err) {
    throw new Error(`Removebg provider: could not connect to ${SPACE_NAME} — ${err.message}`);
  }
}

/* -------------------------------------------------------------------- */
/*  Public provider API                                                  */
/* -------------------------------------------------------------------- */

/**
 * Removes the background from a single image via the
 * briaai/BRIA-RMBG-2.0 Space, returning a local path to the resulting
 * transparent-background PNG.
 *
 * @param {string} inputPathOrUrl - local file path or public URL of the source image
 * @returns {Promise<string>} absolute local path to the transparent PNG output
 * @throws {Error} on connection failure, prediction failure, or a malformed/missing result
 */
async function removeBackground(inputPathOrUrl) {

  const app = await connectToSpace();

  let result;
  try {
    result = await withTimeout(
      app.predict(ENDPOINT, [handle_file(inputPathOrUrl)]),
      PREDICT_TIMEOUT_MS,
      `removing background via ${ENDPOINT}`
    );
  } catch (err) {
    throw new Error(`Removebg provider: prediction failed — ${err.message}`);
  }

  const data = result.data || [];

  // Confirmed schema: index 1 holds the transparent-background image,
  // NOT index 0 — see the header comment.
  const outputImage = data[1];

  if (!outputImage || !outputImage.url) {
    throw new Error('Removebg provider: Space returned no output image at the expected index (data[1])');
  }

  return await downloadToTemp(outputImage.url);

}

module.exports = { removeBackground };
