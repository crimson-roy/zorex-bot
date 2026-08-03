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
 *     results, yt-dlp's JSON output) to callers — every public method
 *     returns a normalized, provider-agnostic object.
 *   - No command parsing, no WhatsApp/Baileys logic, no bot replies.
 *   - Validation, networking, normalization, and downloading are kept
 *     in separate, single-purpose helper functions with no duplicated
 *     logic between them.
 *   - Network/process operations are wrapped with timeout + retry +
 *     descriptive error handling so callers only ever see clean
 *     Error objects prefixed with "YouTube provider:".
 *
 * ---------------------------------------------------------------------
 * WHY yt-dlp INSTEAD OF ytdl-core / @distube/ytdl-core
 * ---------------------------------------------------------------------
 * Pure-JS scrapers like ytdl-core reverse-engineer YouTube's player
 * script to decrypt stream signatures, and that script changes often
 * enough (plus YouTube's newer anti-bot "PoToken" requirements) that
 * these libraries break on a regular, sometimes lengthy, basis. yt-dlp
 * is a separately maintained, actively-patched downloader tool (not a
 * JS library) used as the backend for most production bots specifically
 * because it reacts to YouTube's changes far faster and more reliably.
 * This provider shells out to it via the `yt-dlp-exec` npm package,
 * which downloads the right yt-dlp binary for the host OS automatically.
 *
 * Dependencies (install before use):
 *   npm install yt-search yt-dlp-exec
 * Also requires ffmpeg on PATH (for audio extraction / video muxing) —
 * already installed in this deployment.
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
const ytDlp = require('yt-dlp-exec');

/* -------------------------------------------------------------------- */
/*  Constants                                                            */
/* -------------------------------------------------------------------- */

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;

const DEFAULT_TIMEOUT_MS = 20000; // metadata / search operations
const DOWNLOAD_TIMEOUT_MS = 180000; // audio/video downloads (yt-dlp can be slower than raw streaming)

const DEFAULT_RETRIES = 2; // retries AFTER the initial attempt
const DEFAULT_RETRY_DELAY_MS = 800;

// Caps merged video downloads at 720p — matches WhatsApp's practical media
// size ceiling and keeps files sendable without excessive wait times.
// Bump this if you want higher-quality video and don't mind bigger files.
const MAX_VIDEO_HEIGHT = 720;

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;
const VIDEO_ID_FROM_URL_PATTERN = /(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/;

const TEMP_DIR = path.join(os.tmpdir(), 'zorex-youtube-provider');

const AUDIO_MIME_TYPES = {
  m4a: 'audio/mp4',
  webm: 'audio/webm',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
};

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
    `YouTube provider: ${operationLabel} failed after ${retries + 1} attempt(s) — ${describeError(lastError)}`
  );
}

/**
 * yt-dlp-exec (execa-based) failures carry the real diagnostic info in
 * .stderr, not .message — pulls out a short, useful snippet instead of
 * the generic "Command failed with exit code 1" that .message gives.
 *
 * @param {Error & { stderr?: string }} err
 * @returns {string}
 */
function describeError(err) {
  if (!err) return 'unknown error';

  const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';

  if (stderr) {
    const firstLine = stderr.split('\n').find((line) => line.trim().length > 0) || stderr;
    return firstLine.slice(0, 300);
  }

  return err.message || String(err);
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
 * either a raw ID or a full YouTube URL (watch/shorts/youtu.be/embed).
 * Throws a descriptive error if no valid ID can be resolved.
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

  const match = trimmed.match(VIDEO_ID_FROM_URL_PATTERN);

  if (!match) {
    throw new Error(
      `YouTube provider: ${methodName}() received an invalid video ID or URL: "${input}"`
    );
  }

  return match[1];
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
 * without touching normalization or public API code. Unaffected by the
 * yt-dlp migration — yt-search scrapes YouTube's search page directly
 * and doesn't touch stream/signature decryption at all.
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
 * Fetches full video metadata via `yt-dlp --dump-single-json`, with
 * timeout + retry. Isolated so the downloader tool could be swapped
 * without touching normalization or public API code.
 *
 * @param {string} videoId - validated 11-character video ID
 * @returns {Promise<any>} raw yt-dlp metadata object
 */
async function fetchVideoInfo(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  return withRetry(
    () =>
      withTimeout(
        ytDlp(url, {
          dumpSingleJson: true,
          noWarnings: true,
          noCheckCertificates: true,
          noPlaylist: true,
          preferFreeFormats: true,
        }),
        DEFAULT_TIMEOUT_MS,
        `fetching video info for ${videoId}`
      ),
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
 * Picks the highest-resolution thumbnail from yt-search's single
 * thumbnail field, or yt-dlp's thumbnails array.
 * @param {any} thumbnails - array of {url} objects, or a plain string URL
 * @returns {string|null}
 */
function pickBestThumbnail(thumbnails) {
  if (!thumbnails) return null;
  if (typeof thumbnails === 'string') return thumbnails;
  if (Array.isArray(thumbnails) && thumbnails.length > 0) {
    // yt-dlp lists thumbnails roughly ascending by size.
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
 * Normalizes a raw yt-dlp metadata object into complete video info.
 * @param {any} info - raw yt-dlp --dump-single-json output
 * @returns {NormalizedVideo}
 */
function normalizeVideoInfo(info) {
  const durationSeconds = Number(info.duration) || 0;

  return {
    id: info.id,
    title: info.title || 'Unknown title',
    channel: info.uploader || info.channel || 'Unknown channel',
    description: info.description || '',
    duration: formatDuration(durationSeconds),
    durationSeconds,
    views: Number(info.view_count) || 0,
    uploadedAt: info.upload_date || null,
    isLive: Boolean(info.is_live),
    thumbnail: info.thumbnail || pickBestThumbnail(info.thumbnails),
    url: info.webpage_url || `https://www.youtube.com/watch?v=${info.id}`,
  };
}

/**
 * Picks the best video quality label (e.g. "720p") available at or
 * under MAX_VIDEO_HEIGHT, from yt-dlp's per-format list embedded in the
 * metadata JSON. Falls back to "unknown" if no video-height info is
 * present (shouldn't normally happen for a real video).
 *
 * @param {any} info - raw yt-dlp --dump-single-json output
 * @returns {string}
 */
function pickVideoQualityLabel(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];

  const heights = formats
    .filter((f) => f.vcodec && f.vcodec !== 'none' && typeof f.height === 'number')
    .map((f) => f.height);

  if (heights.length === 0) return 'unknown';

  const underCap = heights.filter((h) => h <= MAX_VIDEO_HEIGHT);
  const best = underCap.length > 0 ? Math.max(...underCap) : Math.min(...heights);

  return `${best}p`;
}

/* -------------------------------------------------------------------- */
/*  Downloading — via yt-dlp, with timeout + retry                       */
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
 * Builds a unique base filename (no extension) for a download. yt-dlp
 * decides the actual extension based on the source format, so the
 * caller locates the real resulting file afterward via
 * findDownloadedFile().
 *
 * @param {string} videoId
 * @returns {string} absolute base path, e.g. "/tmp/.../abc123-f00d.mp4"
 */
function buildTempBasePath(videoId) {
  ensureTempDir();
  const uniqueSuffix = crypto.randomBytes(6).toString('hex');
  return path.join(TEMP_DIR, `${videoId}-${uniqueSuffix}`);
}

/**
 * Finds the file yt-dlp actually wrote for a given base path (the
 * output template's %(ext)s means the final extension isn't known
 * ahead of time).
 *
 * @param {string} basePath - value passed as buildTempBasePath()'s return
 * @returns {string} absolute path to the downloaded file
 * @throws {Error} if no matching file is found
 */
function findDownloadedFile(basePath) {
  const dir = path.dirname(basePath);
  const baseName = path.basename(basePath);

  const match = fs
    .readdirSync(dir)
    .find((f) => f.startsWith(baseName));

  if (!match) {
    throw new Error('YouTube provider: download reported success but the output file was not found');
  }

  return path.join(dir, match);
}

/**
 * Runs a yt-dlp download with the given format selector, with an
 * overall timeout and retry-on-failure wrapper. Each retry attempt
 * gets a fresh temp base path; failed attempts clean up after
 * themselves.
 *
 * @param {string} videoUrl
 * @param {string} videoId
 * @param {Record<string, any>} extraFlags - yt-dlp-exec flags beyond format/output
 * @param {string} formatSelector - yt-dlp -f format selector string
 * @returns {Promise<string>} absolute path to the downloaded file
 */
async function downloadWithYtDlp(videoUrl, videoId, extraFlags, formatSelector) {
  return withRetry(
    async () => {
      const basePath = buildTempBasePath(videoId);
      const outputTemplate = `${basePath}.%(ext)s`;

      try {
        await withTimeout(
          ytDlp(videoUrl, {
            format: formatSelector,
            output: outputTemplate,
            noPlaylist: true,
            noWarnings: true,
            noCheckCertificates: true,
            ...extraFlags,
          }),
          DOWNLOAD_TIMEOUT_MS,
          `downloading ${videoId}`
        );
      } catch (err) {
        // Clean up any partial file(s) from this attempt before retrying.
        try {
          const dir = path.dirname(basePath);
          const baseName = path.basename(basePath);
          for (const f of fs.readdirSync(dir)) {
            if (f.startsWith(baseName)) fs.unlinkSync(path.join(dir, f));
          }
        } catch {
          /* best-effort cleanup only */
        }

        throw new Error(`YouTube provider: download failed — ${describeError(err)}`);
      }

      return findDownloadedFile(basePath);
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
    throw new Error(`YouTube provider: could not retrieve video ${validId} — ${describeError(err)}`);
  }

  return normalizeVideoInfo(info);
}

/**
 * Downloads the highest-quality available audio for a video, suitable
 * for sending as WhatsApp audio. Always normalized to m4a (AAC) via
 * yt-dlp's audio-extraction postprocessor — remuxed losslessly when the
 * source is already AAC-compatible, transcoded only when it isn't —
 * so the output is guaranteed to be a WhatsApp-safe container/codec.
 *
 * @param {string} videoId - video ID or full YouTube URL
 * @returns {Promise<{ title: string, duration: string, thumbnail: string|null, mimeType: string, filePath: string }>}
 * @throws {Error} on invalid input, missing video, or download failure
 */
async function downloadAudio(videoId) {
  const validId = assertValidVideoId(videoId, 'downloadAudio');

  const info = await fetchVideoInfo(validId);
  const normalized = normalizeVideoInfo(info);

  const filePath = await downloadWithYtDlp(
    normalized.url,
    validId,
    { extractAudio: true, audioFormat: 'm4a' },
    'bestaudio/best'
  );

  const extension = path.extname(filePath).slice(1).toLowerCase();
  const mimeType = AUDIO_MIME_TYPES[extension] || `audio/${extension || 'mp4'}`;

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
 * quality that remains compatible with WhatsApp, capped at
 * MAX_VIDEO_HEIGHT to keep file sizes reasonable. Separate best
 * video-only and audio-only streams are automatically merged into a
 * single MP4 by yt-dlp/ffmpeg.
 *
 * @param {string} videoId - video ID or full YouTube URL
 * @returns {Promise<{ title: string, duration: string, thumbnail: string|null, mimeType: string, quality: string, filePath: string }>}
 * @throws {Error} on invalid input, missing video, or download failure
 */
async function downloadVideo(videoId) {
  const validId = assertValidVideoId(videoId, 'downloadVideo');

  const info = await fetchVideoInfo(validId);
  const normalized = normalizeVideoInfo(info);
  const quality = pickVideoQualityLabel(info);

  const formatSelector =
    `bestvideo[height<=${MAX_VIDEO_HEIGHT}][ext=mp4]+bestaudio[ext=m4a]/` +
    `best[height<=${MAX_VIDEO_HEIGHT}][ext=mp4]/` +
    `best[height<=${MAX_VIDEO_HEIGHT}]`;

  const filePath = await downloadWithYtDlp(
    normalized.url,
    validId,
    { mergeOutputFormat: 'mp4' },
    formatSelector
  );

  const extension = path.extname(filePath).slice(1).toLowerCase();
  const mimeType = extension === 'mp4' ? 'video/mp4' : `video/${extension || 'mp4'}`;

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