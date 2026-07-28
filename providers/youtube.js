/**
 * providers/youtube.js
 *
 * YouTube Provider Layer (Zorex Bot)
 * -----------------------------------
 * Thin, self-contained integration with YouTube, following the same
 * engineering standards as apiFootball.js and spotify.js.
 *
 * Architectural rules:
 *   - This module knows how to talk to YouTube and nothing else.
 *   - It never leaks library-specific response shapes (yt-search
 *     results, ytdl-core formats/videoInfo) to callers — every public
 *     method returns a normalized, provider-agnostic object.
 *   - No command parsing, no WhatsApp/Baileys logic, no bot replies.
 *   - Validation, networking, normalization, and downloading are kept
 *     in separate, single-purpose helper functions with no duplicated
 *     logic between them.
 *   - Network/stream operations are wrapped with timeout + retry +
 *     descriptive error handling so callers only ever see clean
 *     Error objects prefixed with "YouTube provider:".
 *
 * Dependencies (install before use):
 *   npm install yt-search @distube/ytdl-core
 *
 * Usage:
 *   const youtube = require('./providers/youtube');
 *   const results = await youtube.searchVideos('lofi hip hop');
 *   const video = await youtube.getVideo(results[0].id);
 *   const audio = await youtube.downloadAudio(video.id);
 *   const clip = await youtube.downloadVideo(video.id);
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ytSearch = require('yt-search');
const ytdl = require('@distube/ytdl-core');

/* -------------------------------------------------------------------- */
/*  Constants                                                            */
/* -------------------------------------------------------------------- */

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;

const DEFAULT_TIMEOUT_MS = 15000; // metadata / search operations
const DOWNLOAD_TIMEOUT_MS = 120000; // audio/video downloads

const DEFAULT_RETRIES = 2; // retries AFTER the initial attempt
const DEFAULT_RETRY_DELAY_MS = 500;

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

const TEMP_DIR = path.join(os.tmpdir(), 'zorex-youtube-provider');

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
      reject(new Error(`YouTube provider: ${operationLabel} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs an async function with retry-on-failure semantics and exponential-ish
 * backoff. The last error is re-thrown, wrapped with a descriptive prefix,
 * if all attempts fail.
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
    `YouTube provider: ${operationLabel} failed after ${retries + 1} attempt(s) — ${lastError.message}`
  );
}

/* -------------------------------------------------------------------- */
/*  Validation helpers                                                   */
/* -------------------------------------------------------------------- */

/**
 * Validates a search query string.
 * @param {string} query
 * @param {string} methodName
 */
function assertValidQuery(query, methodName) {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error(`YouTube provider: ${methodName}() requires a non-empty string query`);
  }
}

/**
 * Extracts and validates a plain 11-character YouTube video ID from
 * either a raw ID or a full YouTube URL. Throws a descriptive error
 * if no valid ID can be resolved.
 *
 * @param {string} input - video ID or YouTube URL
 * @param {string} methodName
 * @returns {string} normalized 11-character video ID
 */
function assertValidVideoId(input, methodName) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`YouTube provider: ${methodName}() requires a non-empty video ID or URL`);
  }

  const trimmed = input.trim();

  if (VIDEO_ID_PATTERN.test(trimmed)) {
    return trimmed;
  }

  let extracted = null;
  try {
    if (ytdl.validateURL(trimmed)) {
      extracted = ytdl.getVideoID(trimmed);
    }
  } catch {
    extracted = null;
  }

  if (!extracted || !VIDEO_ID_PATTERN.test(extracted)) {
    throw new Error(
      `YouTube provider: ${methodName}() received an invalid video ID or URL: "${input}"`
    );
  }

  return extracted;
}

/**
 * Clamps and validates an optional search `limit`, defaulting to
 * DEFAULT_SEARCH_LIMIT.
 * @param {number|undefined} limit
 * @returns {number}
 */
function normalizeLimit(limit) {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.floor(n), MAX_SEARCH_LIMIT);
}

/* -------------------------------------------------------------------- */
/*  Networking — search & metadata                                       */
/* -------------------------------------------------------------------- */

/**
 * Runs a yt-search query with timeout + retry, isolated from the rest
 * of the module so the underlying search library could be swapped
 * without touching normalization or public API code.
 *
 * @param {string} query
 * @returns {Promise<any>} raw yt-search result object
 */
async function runSearch(query) {
  return withRetry(
    () => withTimeout(ytSearch(query), DEFAULT_TIMEOUT_MS, `search for "${query}"`),
    { operationLabel: `search for "${query}"` }
  );
}

/**
 * Fetches full video info from YouTube via ytdl-core, with timeout +
 * retry. Isolated so the downloader library could be swapped without
 * touching normalization or public API code.
 *
 * @param {string} videoId - validated 11-character video ID
 * @returns {Promise<import('@distube/ytdl-core').videoInfo>}
 */
async function fetchVideoInfo(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  return withRetry(
    () => withTimeout(ytdl.getInfo(url), DEFAULT_TIMEOUT_MS, `fetching video info for ${videoId}`),
    { operationLabel: `fetching video info for ${videoId}` }
  );
}

/* -------------------------------------------------------------------- */
/*  Normalization — the ONLY place raw library shapes are touched        */
/* -------------------------------------------------------------------- */

/**
 * @typedef {Object} NormalizedSearchResult
 * @property {string} id
 * @property {string} title
 * @property {string} channel
 * @property {string} duration - formatted, e.g. "3:45"
 * @property {number} durationSeconds
 * @property {number} views
 * @property {string} uploadedAt
 * @property {string|null} thumbnail
 * @property {string} url
 */

/**
 * @typedef {Object} NormalizedVideo
 * @property {string} id
 * @property {string} title
 * @property {string} channel
 * @property {string} description
 * @property {string} duration - formatted, e.g. "3:45"
 * @property {number} durationSeconds
 * @property {number} views
 * @property {string|null} uploadedAt
 * @property {boolean} isLive
 * @property {string|null} thumbnail
 * @property {string} url
 */

/**
 * Formats a seconds count as "H:MM:SS" (or "M:SS" under an hour).
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');

  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Picks the highest-resolution thumbnail from a yt-search or ytdl-core
 * thumbnail list/field.
 * @param {any} thumbnails - array of {url} objects, or a plain string URL
 * @returns {string|null}
 */
function pickBestThumbnail(thumbnails) {
  if (!thumbnails) return null;
  if (typeof thumbnails === 'string') return thumbnails;
  if (Array.isArray(thumbnails) && thumbnails.length > 0) {
    // ytdl-core returns thumbnails sorted ascending by size.
    return thumbnails[thumbnails.length - 1].url || null;
  }
  return null;
}

/**
 * Normalizes a single raw yt-search video result.
 * @param {any} item - raw yt-search video object
 * @returns {NormalizedSearchResult}
 */
function normalizeSearchResult(item) {
  const durationSeconds = item.seconds || (item.duration && item.duration.seconds) || 0;

  return {
    id: item.videoId,
    title: item.title || 'Unknown title',
    channel: (item.author && item.author.name) || 'Unknown channel',
    duration: item.timestamp || formatDuration(durationSeconds),
    durationSeconds,
    views: typeof item.views === 'number' ? item.views : 0,
    uploadedAt: item.ago || 'Unknown',
    thumbnail: item.thumbnail || item.image || null,
    url: item.url || `https://www.youtube.com/watch?v=${item.videoId}`,
  };
}

/**
 * Normalizes a raw ytdl-core videoInfo object into complete metadata.
 * @param {import('@distube/ytdl-core').videoInfo} info
 * @returns {NormalizedVideo}
 */
function normalizeVideoInfo(info) {
  const details = info.videoDetails;
  const durationSeconds = Number(details.lengthSeconds) || 0;

  return {
    id: details.videoId,
    title: details.title || 'Unknown title',
    channel: (details.author && details.author.name) || 'Unknown channel',
    description: details.description || '',
    duration: formatDuration(durationSeconds),
    durationSeconds,
    views: Number(details.viewCount) || 0,
    uploadedAt: details.uploadDate || details.publishDate || null,
    isLive: Boolean(details.isLiveContent),
    thumbnail: pickBestThumbnail(details.thumbnails),
    url: details.video_url || `https://www.youtube.com/watch?v=${details.videoId}`,
  };
}

/* -------------------------------------------------------------------- */
/*  Format selection (audio / video)                                     */
/* -------------------------------------------------------------------- */

/**
 * Chooses the best audio-only format for WhatsApp voice/audio delivery:
 * highest available audio bitrate, preferring formats with a known
 * container/codec ytdl-core can stream cleanly.
 *
 * @param {import('@distube/ytdl-core').videoInfo} info
 * @returns {import('@distube/ytdl-core').videoFormat}
 * @throws {Error} if no audio-only format is available
 */
function chooseAudioFormat(info) {
  const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');

  if (!audioFormats || audioFormats.length === 0) {
    throw new Error('YouTube provider: no audio-only format is available for this video');
  }

  return audioFormats.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
}

/**
 * Chooses the best combined audio+video MP4-compatible format for
 * WhatsApp video delivery: highest practical quality that still
 * includes both audio and video in a single stream (WhatsApp does not
 * accept video-only + audio-only pairs without muxing).
 *
 * @param {import('@distube/ytdl-core').videoInfo} info
 * @returns {import('@distube/ytdl-core').videoFormat}
 * @throws {Error} if no combined audio+video format is available
 */
function chooseVideoFormat(info) {
  const combinedFormats = ytdl.filterFormats(info.formats, 'audioandvideo');

  if (!combinedFormats || combinedFormats.length === 0) {
    throw new Error('YouTube provider: no combined audio+video format is available for this video');
  }

  // Prefer mp4 container for maximum WhatsApp compatibility.
  const mp4Formats = combinedFormats.filter((f) => f.container === 'mp4');
  const pool = mp4Formats.length > 0 ? mp4Formats : combinedFormats;

  return pool.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
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
 * @param {string} videoId
 * @param {string} extension - without leading dot
 * @returns {string}
 */
function buildTempFilePath(videoId, extension) {
  ensureTempDir();
  const uniqueSuffix = crypto.randomBytes(6).toString('hex');
  return path.join(TEMP_DIR, `${videoId}-${uniqueSuffix}.${extension}`);
}

/**
 * Streams a single ytdl-core format to disk, resolving once the file
 * is fully written. Rejects (and cleans up the partial file) on
 * stream error or timeout.
 *
 * @param {string} videoUrl
 * @param {import('@distube/ytdl-core').videoFormat} format
 * @param {string} destPath
 * @returns {Promise<void>}
 */
function streamFormatToFile(videoUrl, format, destPath) {
  return new Promise((resolve, reject) => {
    const readStream = ytdl(videoUrl, { format });
    const writeStream = fs.createWriteStream(destPath);

    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      readStream.destroy();
      writeStream.destroy();
      fs.unlink(destPath, () => {
        reject(err);
      });
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    readStream.on('error', (err) =>
      fail(new Error(`YouTube provider: download stream error — ${err.message}`))
    );
    writeStream.on('error', (err) =>
      fail(new Error(`YouTube provider: file write error — ${err.message}`))
    );
    writeStream.on('finish', succeed);

    readStream.pipe(writeStream);
  });
}

/**
 * Downloads a chosen format to a temp file with an overall timeout and
 * retry-on-failure wrapper. Each retry attempt gets a fresh temp file
 * path; failed attempts clean up after themselves.
 *
 * @param {string} videoUrl
 * @param {import('@distube/ytdl-core').videoFormat} format
 * @param {string} videoId
 * @param {string} extension
 * @returns {Promise<string>} absolute path to the downloaded file
 */
async function downloadFormatToTempFile(videoUrl, format, videoId, extension) {
  return withRetry(
    async () => {
      const destPath = buildTempFilePath(videoId, extension);
      await withTimeout(
        streamFormatToFile(videoUrl, format, destPath),
        DOWNLOAD_TIMEOUT_MS,
        `downloading ${videoId}`
      );
      return destPath;
    },
    { operationLabel: `downloading ${videoId}` }
  );
}

/* -------------------------------------------------------------------- */
/*  Public provider API                                                  */
/* -------------------------------------------------------------------- */

/**
 * Searches YouTube for videos matching a query.
 *
 * @param {string} query - free-text search query
 * @param {{ limit?: number }} [options]
 * @returns {Promise<NormalizedSearchResult[]>}
 * @throws {Error} on invalid input or upstream failure
 */
async function searchVideos(query, options = {}) {
  assertValidQuery(query, 'searchVideos');
  const limit = normalizeLimit(options.limit);

  const raw = await runSearch(query);
  const items = raw && Array.isArray(raw.videos) ? raw.videos : [];

  if (items.length === 0) {
    return [];
  }

  return items.slice(0, limit).map(normalizeSearchResult);
}

/**
 * Fetches complete normalized metadata for a single video.
 *
 * @param {string} videoId - video ID or full YouTube URL
 * @returns {Promise<NormalizedVideo>}
 * @throws {Error} on invalid input, missing video, or upstream failure
 */
async function getVideo(videoId) {
  const validId = assertValidVideoId(videoId, 'getVideo');

  let info;
  try {
    info = await fetchVideoInfo(validId);
  } catch (err) {
    throw new Error(`YouTube provider: could not retrieve video ${validId} — ${err.message}`);
  }

  return normalizeVideoInfo(info);
}

/**
 * Downloads the highest-quality available audio for a video, suitable
 * for sending as WhatsApp audio.
 *
 * @param {string} videoId - video ID or full YouTube URL
 * @returns {Promise<{ title: string, duration: string, thumbnail: string|null, mimeType: string, filePath: string }>}
 * @throws {Error} on invalid input, missing video, or download failure
 */
async function downloadAudio(videoId) {
  const validId = assertValidVideoId(videoId, 'downloadAudio');

  const info = await fetchVideoInfo(validId);
  const normalized = normalizeVideoInfo(info);
  const format = chooseAudioFormat(info);

  const extension = format.container || 'm4a';
  const mimeType = format.mimeType ? format.mimeType.split(';')[0] : `audio/${extension}`;

  const filePath = await downloadFormatToTempFile(
    normalized.url,
    format,
    validId,
    extension
  );

  return {
    title: normalized.title,
    duration: normalized.duration,
    thumbnail: normalized.thumbnail,
    mimeType,
    filePath,
  };
}

/**
 * Downloads MP4 video (with audio included) at the highest practical
 * quality that remains compatible with WhatsApp.
 *
 * @param {string} videoId - video ID or full YouTube URL
 * @returns {Promise<{ title: string, duration: string, thumbnail: string|null, mimeType: string, quality: string, filePath: string }>}
 * @throws {Error} on invalid input, missing video, or download failure
 */
async function downloadVideo(videoId) {
  const validId = assertValidVideoId(videoId, 'downloadVideo');

  const info = await fetchVideoInfo(validId);
  const normalized = normalizeVideoInfo(info);
  const format = chooseVideoFormat(info);

  const extension = format.container || 'mp4';
  const mimeType = format.mimeType ? format.mimeType.split(';')[0] : `video/${extension}`;
  const quality = format.qualityLabel || (format.height ? `${format.height}p` : 'unknown');

  const filePath = await downloadFormatToTempFile(
    normalized.url,
    format,
    validId,
    extension
  );

  return {
    title: normalized.title,
    duration: normalized.duration,
    thumbnail: normalized.thumbnail,
    mimeType,
    quality,
    filePath,
  };
}

module.exports = {
  searchVideos,
  getVideo,
  downloadAudio,
  downloadVideo,
};
