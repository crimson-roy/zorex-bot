/**
 * providers/upscale.js
 *
 * Image Upscale Provider (Zorex Bot)
 * ------------------------------------
 * Thin integration with the Hockman/real-esrgan-upscaler Hugging Face
 * Space, following the same shape as youtube.js/spotify.js.
 *
 * WHY A SPACE INSTEAD OF THE OFFICIAL INFERENCE API
 * ---------------------------------------------------------------------
 * Real-ESRGAN is not deployed on Hugging Face's official Inference
 * Providers — the standard serverless Inference API mainly covers
 * text/LLM/image-generation models, not classic image-to-image
 * upscaling models. The working free, no-credit-card route is calling
 * a community Space directly through its own Gradio API, via the
 * @gradio/client package. This means we're depending on one person's
 * demo Space staying up rather than an official, guaranteed endpoint —
 * if it goes down or gets taken offline, swap SPACE_NAME (or migrate to
 * a paid API like Replicate later) — nothing outside this file needs
 * to change, since upscaleImage() is the only thing callers touch.
 *
 * ---------------------------------------------------------------------
 * ENDPOINT MAPPING — NOT YET CONFIRMED
 * ---------------------------------------------------------------------
 * The Space exposes two real prediction endpoints (its other named
 * endpoints — /lambda, /lambda_1, /lambda_2, /toggle_buttons,
 * /toggle_buttons_1 — are UI plumbing: tab switching / button
 * enable-disable, not upscaling calls):
 *
 *   /process_and_get_output
 *   /process_and_get_output_1
 *
 * Per the Space's own description ("Choose to upscale by x2 or x4"),
 * one of these is the x2 tab and the other is x4 — but the API schema
 * doesn't say which is which; both take the same `img` input and
 * return the same [image, html_label] shape. ENDPOINT_BY_SCALE below
 * is a GUESS (2 -> first endpoint, 4 -> second, in declaration order).
 *
 * BEFORE RELYING ON THIS: run testUpscaleEndpoints() once (see bottom
 * of this file) with a real image and read the returned `label` for
 * each endpoint — the Space's HTML label output should say something
 * like "2x" or "4x" — then fix ENDPOINT_BY_SCALE if the guess was
 * backwards.
 *
 * Usage:
 *   const upscale = require('./providers/upscale');
 *   const result = await upscale.upscaleImage('/path/to/image.jpg', 4);
 *   // result.filePath -> local path to the upscaled image
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Client, handle_file } = require('@gradio/client');

const SPACE_NAME = 'Hockman/real-esrgan-upscaler';

// UNCONFIRMED — see the big comment above. Verify before shipping.
const ENDPOINT_BY_SCALE = {
  2: '/process_and_get_output',
  4: '/process_and_get_output_1',
};

const CONNECT_TIMEOUT_MS = 30000; // Space cold starts can be slow on first call
const PREDICT_TIMEOUT_MS = 90000; // upscaling itself can take a while on shared CPU

const TEMP_DIR = path.join(os.tmpdir(), 'zorex-upscale-provider');

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
 * if the timeout wins. Mirrors the pattern already used in
 * providers/youtube.js.
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
      reject(new Error(`Upscale provider: ${operationLabel} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Downloads the Space's output image (a hosted URL) to a local temp
 * file, so callers get a normal filesystem path — same contract as
 * downloadAudio()/downloadVideo() in youtube.js.
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
    throw new Error(`Upscale provider: failed to download result image (HTTP ${res.status})`);
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
    throw new Error(`Upscale provider: could not connect to ${SPACE_NAME} — ${err.message}`);
  }
}

/* -------------------------------------------------------------------- */
/*  Public provider API                                                  */
/* -------------------------------------------------------------------- */

/**
 * Upscales a single image via the Hockman/real-esrgan-upscaler Space.
 *
 * @param {string} inputPathOrUrl - local file path or public URL of the source image
 * @param {2|4} scale - upscale factor; only 2 and 4 are available on this Space
 * @returns {Promise<{ filePath: string, label: string }>}
 * @throws {Error} on invalid scale, connection failure, or Space error
 */
async function upscaleImage(inputPathOrUrl, scale) {

  const endpoint = ENDPOINT_BY_SCALE[scale];

  if (!endpoint) {
    throw new Error(
      `Upscale provider: unsupported scale "${scale}" — only ${Object.keys(ENDPOINT_BY_SCALE).join(' or ')} are available on this Space`
    );
  }

  const app = await connectToSpace();

  let result;
  try {
    result = await withTimeout(
      app.predict(endpoint, [handle_file(inputPathOrUrl)]),
      PREDICT_TIMEOUT_MS,
      `upscaling via ${endpoint}`
    );
  } catch (err) {
    throw new Error(`Upscale provider: prediction failed — ${err.message}`);
  }

  const [outputImage, label] = result.data || [];

  if (!outputImage || !outputImage.url) {
    throw new Error('Upscale provider: Space returned no output image');
  }

  const filePath = await downloadToTemp(outputImage.url);

  return { filePath, label: label || '' };

}

/* -------------------------------------------------------------------- */
/*  One-off verification helper — NOT for use in the bot itself          */
/* -------------------------------------------------------------------- */

/**
 * Calls BOTH endpoints against the same test image and prints their
 * labels side by side, so you can see which one is actually x2 and
 * which is x4 before trusting ENDPOINT_BY_SCALE above. Run this once
 * manually (e.g. `node -e "require('./providers/upscale').testUpscaleEndpoints()"`),
 * read the console output, fix ENDPOINT_BY_SCALE if needed, then this
 * function can be deleted or ignored.
 *
 * @param {string} [testImageUrl]
 * @returns {Promise<void>}
 */
async function testUpscaleEndpoints(testImageUrl = 'https://raw.githubusercontent.com/gradio-app/gradio/main/test/test_files/bus.png') {

  const app = await connectToSpace();

  for (const endpoint of ['/process_and_get_output', '/process_and_get_output_1']) {

    try {
      const result = await app.predict(endpoint, [handle_file(testImageUrl)]);
      const [outputImage, label] = result.data || [];
      console.log(`\n[${endpoint}]`);
      console.log('  label:', label);
      console.log('  output url:', outputImage && outputImage.url);
    } catch (err) {
      console.log(`\n[${endpoint}] FAILED:`, err.message);
    }

  }

}

module.exports = { upscaleImage, testUpscaleEndpoints };
