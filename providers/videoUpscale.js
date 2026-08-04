/**
 * providers/videoUpscale.js
 *
 * Runs a local video through Nick088/Real-ESRGAN_Pytorch — a free,
 * no-account-required (Zero GPU) Hugging Face Space that wraps
 * Real-ESRGAN for both images and video. This file only talks to the
 * VIDEO tab (api_name "/predict_1"); the image tab ("/predict") is a
 * separate endpoint on the same Space and is NOT what this file uses.
 *
 * Same caveat as providers/upscale.js's Hockman image Space: this is
 * someone else's free community Space, not an official API — it can
 * go down, get paused for inactivity, or change its schema without
 * warning (we already saw Fabrice-TIERCELIN/RealESRGAN sitting paused
 * when we checked alternatives). If Nick088's Space goes down, swap
 * SPACE_NAME below — nothing else here needs to change.
 *
 * CONFIRMED API SCHEMA (from the Space's own "Use via API" page):
 *
 *   api_name: "/predict_1"
 *   accepts:
 *     video_filepath: Dict(video: filepath, subtitles: filepath|None)  [required]
 *     size_modifier:  '2' | '4' | '8'   (default '2' for video —
 *                     note this differs from the image tab's default
 *                     of '4', so don't assume they share a default)
 *   returns:
 *     Dict(video: filepath, subtitles: filepath|None)
 *
 * @whiskeysockets/baileys-style caveat applies here too:
 * @gradio/client ships ESM, so it's dynamic-imported lazily inside
 * the one async function that needs it — never a top-level require()
 * or a top-level await.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SPACE_NAME = 'Nick088/Real-ESRGAN_Pytorch';
const VIDEO_API_NAME = '/predict_1';

const TEMP_DIR = path.join(os.tmpdir(), 'zorex-video-upscale');

/**
 * Ensures the shared temp directory for downloaded results exists.
 * @returns {void}
 */
function ensureTempDir() {
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
}

/**
 * Downloads a Gradio-hosted result file (a URL on the Space's own
 * domain — @gradio/client does NOT hand you bytes directly, only a
 * FileData object with a .url) to a local temp path.
 *
 * @param {string} url
 * @returns {Promise<string>} absolute local file path
 */
async function downloadResultFile(url) {
    ensureTempDir();

    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to download upscaled video: HTTP ${res.status}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const filePath = path.join(TEMP_DIR, `${crypto.randomBytes(6).toString('hex')}-out.mp4`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

/**
 * Runs a local video file through the Real-ESRGAN video Space and
 * returns the local path to the upscaled result.
 *
 * @param {string} inputPath - local path to the source video
 * @param {'2'|'4'|'8'} [scale='2'] - size_modifier; '2' matches the
 *   video tab's own default in the Space (the image tab defaults to
 *   '4' instead — don't reuse one default for both)
 * @returns {Promise<{ filePath: string }>}
 */
async function upscaleVideo(inputPath, scale = '2') {

    if (!['2', '4', '8'].includes(String(scale))) {
        throw new Error(`upscaleVideo: invalid scale "${scale}" — must be '2', '4', or '8'`);
    }

    // Lazy dynamic import — @gradio/client is ESM. Same reasoning as
    // lib/imageHelpers.js's Baileys import: this must stay inside the
    // async function that needs it, never top-level require() or
    // top-level await.
    const { Client } = await import('@gradio/client');

    const client = await Client.connect(SPACE_NAME);

    const videoBlob = new Blob([fs.readFileSync(inputPath)]);

    const response = await client.predict(VIDEO_API_NAME, {
        video_filepath: { video: videoBlob, subtitles: null },
        size_modifier: String(scale),
    });

    // response.data[0] is the Dict(video, subtitles) FileData object —
    // .video.url points at the hosted result on the Space's own domain.
    const result = response.data && response.data[0];
    const videoUrl = result && result.video && result.video.url;

    if (!videoUrl) {
        throw new Error('Real-ESRGAN video Space returned no video URL — response shape may have changed');
    }

    const filePath = await downloadResultFile(videoUrl);

    return { filePath };

}

module.exports = { upscaleVideo };
