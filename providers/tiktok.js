/**
 * providers/tiktok.js
 *
 * TikTok Provider Layer (Zorex Bot)
 * -----------------------------------
 * Thin, self-contained integration with TikTok, following the same
 * engineering standards as spotify.js and youtube.js.
 *
 * Architectural rules:
 *   - This module knows how to talk to TikTok and nothing else.
 *   - Completely separate from youtube.js — no shared state, no
 *     cross-imports. TikTok logic never leaks into the YouTube provider
 *     and vice versa.
 *   - It never leaks library-specific response shapes to callers —
 *     every public method returns a normalized, provider-agnostic
 *     object.
 *   - No command parsing, no WhatsApp/Baileys logic, no bot replies.
 *   - Validation, networking, normalization, and downloading are kept
 *     in separate, single-purpose helper functions with no duplicated
 *     logic between them.
 *   - Network/stream operations are wrapped with timeout + retry +
 *     descriptive error handling so callers only ever see clean Error
 *     objects prefixed with "TikTok provider:".
 *
 * Dependencies (install before use):
 *   npm install @tobyg74/tiktok-api-dl
 *
 * Usage:
 *   const tiktok = require('./providers/tiktok');
 *   const meta = await tiktok.getMetadata('https://vm.tiktok.com/XXXXXXX/');
 *   const video = await tiktok.downloadVideo('https://vm.tiktok.com/XXXXXXX/');
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const TikTokDL = require('@tobyg74/tiktok-api-dl');

/* -------------------------------------------------------------------- */
/*  Constants                                                            */
/* -------------------------------------------------------------------- */

const DEFAULT_TIMEOUT_MS = 15000; // metadata resolution
const DOWNLOAD_TIMEOUT_MS = 90000; // video download

const DEFAULT_RETRIES = 2; // retries AFTER the initial attempt
const DEFAULT_RETRY_DELAY_MS = 500;

const TIKTOK_URL_PATTERN = /^(https?:\/\/)?(www\.|vm\.|vt\.|m\.)?tiktok\.com\/.+/i;

const TEMP_DIR = path.join(os.tmpdir(), 'zorex-tiktok-provider');

/* -------------------------------------------------------------------- */
/*  Generic utilities (timeout / retry / sleep)                          */
/* -------------------------------------------------------------------- */

/**
 * Sleeps for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Races a promise against a timeout, rejecting with a descriptive
 * error if the timeout wins.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} operationLabel - human-readable label for the error message
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs, operationLabel) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`TikTok provider: ${operationLabel} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs an async function with retry-on-failure semantics and backoff.
 * The last error is re-thrown, wrapped with a descriptive prefix, if
 * all attempts fail.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ retries?: number, delayMs?: number, operationLabel?: string }} [config]
 * @returns {Promise<T>}
 */
async function withRetry(fn, config = {}) {
  const {
    retries = DEFAULT_RETRIES,
    delayMs = DEFAULT_RETRY_DELAY_MS,
    operationLabel = 'operation',
  } = config;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(delayMs * (attempt + 1));
        continue;
      }
    }
  }

  throw new Error(
    `TikTok provider: ${operationLabel} failed after ${retries + 1} attempt(s) — ${lastError.message}`
  );
}

/* -------------------------------------------------------------------- */
/*  Validation helpers                                                   */
/* -------------------------------------------------------------------- */

/**
 * Validates that the given input is a well-formed TikTok URL.
 *
 * @param {string} url
 * @param {string} methodName
 * @returns {string} the trimmed, validated URL
 */
function assertValidTikTokUrl(url, methodName) {
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new Error(`TikTok provider: ${methodName}() requires a non-empty TikTok URL`);
  }

  const trimmed = url.trim();

  if (!TIKTOK_URL_PATTERN.test(trimmed)) {
    throw new Error(`TikTok provider: ${methodName}() received an invalid TikTok URL: "${url}"`);
  }

  return trimmed;
}

/* -------------------------------------------------------------------- */
/*  Networking — metadata resolution                                     */
/* -------------------------------------------------------------------- */

/**
 * Resolves raw TikTok data for a URL via the underlying downloader
 * library, with timeout + retry. Isolated so the underlying library
 * could be swapped without touching normalization or public API code.
 *
 * @param {string} url - validated TikTok URL
 * @returns {Promise<any>} raw library response
 */
async function fetchTikTokData(url) {
  const result = await withRetry(
    () =>
      withTimeout(
        TikTokDL.Downloader(url, { version: 'v1' }),
        DEFAULT_TIMEOUT_MS,
        `resolving TikTok data for ${url}`
      ),
    { operationLabel: `resolving TikTok data for ${url}` }
  );

  if (!result || result.status !== 'success' || !result.result) {
    const reason = (result && result.message) || 'unknown error';
    throw new Error(`TikTok provider: failed to resolve video data — ${reason}`);
  }

  return result.result;
}

/* -------------------------------------------------------------------- */
/*  Normalization — the ONLY place raw library shapes are touched        */
/* -------------------------------------------------------------------- */

/**
 * @typedef {Object} NormalizedTikTokMetadata
 * @property {string} title
 * @property {string} author
 * @property {number} duration - seconds
 * @property {string|null} thumbnail
 * @property {string} videoUrl - direct, watermark-free video URL (best effort)
 * @property {string} mimeType
 */

/**
 * Some fields in the underlying library's response come back as either a
 * plain string OR an array of strings, depending on which API version
 * ('v1'/'v2'/'v3') answered the request. Indexing a string with [0] doesn't
 * throw — it silently returns just its first character — so every place
 * that used to do `field[0]` unconditionally is a latent bug if that field
 * is ever a string instead of an array. This normalizes both shapes down
 * to "the first usable string, or undefined".
 *
 * @param {string|string[]|undefined|null} value
 * @returns {string|undefined}
 */
function firstOf(value) {
  if (Array.isArray(value)) {
    return value.find((v) => typeof v === 'string' && v.length > 0);
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return undefined;
}

/**
 * Picks the best available "no watermark" video URL from the raw
 * library result, falling back to a watermarked URL only if no clean
 * version is exposed.
 *
 * @param {any} raw - raw result from fetchTikTokData
 * @returns {string}
 */
function pickBestVideoUrl(raw) {
  const candidates = [
    firstOf(raw.video && raw.video.playAddr),
    firstOf(raw.video && raw.video.downloadAddr),
    firstOf(raw.videoHD),
    firstOf(raw.videoWatermark),
    firstOf(raw.videoSD),
    firstOf(raw.video_url),
  ].filter(Boolean);

  if (candidates.length === 0) {
    throw new Error('TikTok provider: no downloadable video URL found in response');
  }

  return candidates[0];
}

/**
 * Normalizes a raw TikTok result object into clean metadata.
 * Does NOT download anything — pure data transformation.
 *
 * @param {any} raw - raw result from fetchTikTokData
 * @returns {NormalizedTikTokMetadata}
 */
function normalizeTikTokData(raw) {
  const author =
    (raw.author && (raw.author.nickname || raw.author.username)) ||
    raw.authorMeta?.nickName ||
    raw.author_username ||
    'Unknown author';

  const title = raw.desc || raw.title || raw.description || 'TikTok video';

  const durationRaw =
    (raw.video && raw.video.duration) || raw.duration || raw.videoMeta?.duration || 0;
  const duration = Number(durationRaw) || 0;

  const thumbnail =
    firstOf(raw.video && raw.video.cover) ||
    firstOf(raw.cover) ||
    firstOf(raw.thumbnail) ||
    firstOf(raw.originCover) ||
    null;

  return {
    title,
    author,
    duration,
    thumbnail,
    videoUrl: pickBestVideoUrl(raw),
    mimeType: 'video/mp4',
  };
}

/* -------------------------------------------------------------------- */
/*  Downloading — streaming to a temp file with timeout + retry          */
/* -------------------------------------------------------------------- */

/**
 * Ensures the module's temp download directory exists.
 * @returns {void}
 */
function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

/**
 * Builds a unique temp file path for a download.
 * @param {string} extension - without leading dot
 * @returns {string}
 */
function buildTempFilePath(extension) {
  ensureTempDir();
  const uniqueId = crypto.randomBytes(8).toString('hex');
  return path.join(TEMP_DIR, `tiktok-${uniqueId}.${extension}`);
}

/**
 * Streams a remote video URL to a local file. Rejects (and cleans up
 * the partial file) on network error, bad status, or timeout.
 *
 * @param {string} videoUrl
 * @param {string} destPath
 * @returns {Promise<void>}
 */
async function streamUrlToFile(videoUrl, destPath) {
  const response = await fetch(videoUrl, {
    headers: {
      // Many TikTok CDN URLs reject requests with no user agent / referer.
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Referer: 'https://www.tiktok.com/',
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`TikTok provider: CDN responded with status ${response.status}`);
  }

  await new Promise((resolve, reject) => {
    const nodeStream = Readable.fromWeb(response.body);
    const writeStream = fs.createWriteStream(destPath);

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      nodeStream.destroy();
      writeStream.destroy();
      fs.unlink(destPath, () => reject(err));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    nodeStream.on('error', (err) => fail(new Error(`download stream error — ${err.message}`)));
    writeStream.on('error', (err) => fail(new Error(`file write error — ${err.message}`)));
    writeStream.on('finish', succeed);

    nodeStream.pipe(writeStream);
  });
}

/**
 * Downloads a video URL to a temp file with an overall timeout and
 * retry-on-failure wrapper. Each retry attempt gets a fresh temp file
 * path; failed attempts clean up after themselves.
 *
 * @param {string} videoUrl
 * @param {string} extension
 * @returns {Promise<string>} absolute path to the downloaded file
 */
async function downloadUrlToTempFile(videoUrl, extension) {
  return withRetry(
    async () => {
      const destPath = buildTempFilePath(extension);
      await withTimeout(
        streamUrlToFile(videoUrl, destPath),
        DOWNLOAD_TIMEOUT_MS,
        'downloading TikTok video'
      );
      return destPath;
    },
    { operationLabel: 'downloading TikTok video' }
  );
}

/* -------------------------------------------------------------------- */
/*  Public provider API                                                  */
/* -------------------------------------------------------------------- */

/**
 * Resolves normalized metadata for a TikTok URL WITHOUT downloading
 * the video file. Useful for previews or captions.
 *
 * @param {string} url - TikTok video URL
 * @returns {Promise<NormalizedTikTokMetadata>}
 * @throws {Error} on invalid input or upstream failure
 */
async function getMetadata(url) {
  const validUrl = assertValidTikTokUrl(url, 'getMetadata');
  const raw = await fetchTikTokData(validUrl);
  return normalizeTikTokData(raw);
}

/**
 * Returns just the author/creator info for a TikTok video.
 *
 * @param {string} url - TikTok video URL
 * @returns {Promise<{ author: string }>}
 * @throws {Error} on invalid input or upstream failure
 */
async function getAuthor(url) {
  const validUrl = assertValidTikTokUrl(url, 'getAuthor');
  const raw = await fetchTikTokData(validUrl);
  const { author } = normalizeTikTokData(raw);
  return { author };
}

/**
 * Alias for full metadata resolution — kept as a distinct entry point
 * so callers that only need to "get the video" (metadata + playable
 * URL, no file on disk) don't have to go through downloadVideo().
 *
 * @param {string} url - TikTok video URL
 * @returns {Promise<NormalizedTikTokMetadata>}
 * @throws {Error} on invalid input or upstream failure
 */
async function getVideo(url) {
  return getMetadata(url);
}

/**
 * Downloads a TikTok video to a local temp file, without watermark
 * whenever the source data exposes a clean version, and returns
 * normalized metadata alongside the local file path.
 *
 * @param {string} url - TikTok video URL
 * @returns {Promise<{ title: string, author: string, duration: number, thumbnail: string|null, filePath: string, mimeType: string }>}
 * @throws {Error} on invalid input, missing video, or download failure
 */
async function downloadVideo(url) {
  const validUrl = assertValidTikTokUrl(url, 'downloadVideo');
  const raw = await fetchTikTokData(validUrl);
  const normalized = normalizeTikTokData(raw);

  const filePath = await downloadUrlToTempFile(normalized.videoUrl, 'mp4');

  return {
    title: normalized.title,
    author: normalized.author,
    duration: normalized.duration,
    thumbnail: normalized.thumbnail,
    filePath,
    mimeType: normalized.mimeType,
  };
}

module.exports = {
  downloadVideo,
  getVideo,
  getAuthor,
  getMetadata,
};