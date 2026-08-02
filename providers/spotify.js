/**
 * providers/spotify.js
 *
 * Spotify Provider Layer
 * -----------------------
 * Thin, self-contained integration with the official Spotify Web API.
 *
 * Architectural rules (mirrors the football providers):
 *   - This module knows how to talk to Spotify and nothing else.
 *   - It never leaks Spotify's raw response shapes to callers — every
 *     public method returns a normalized, provider-agnostic object.
 *   - No command parsing, no WhatsApp/bot logic, no file downloading.
 *   - OAuth (client credentials grant) is handled internally and the
 *     access token is cached in memory until it expires.
 *   - Network calls are wrapped with timeout + retry + descriptive
 *     error handling so callers only ever see clean Error objects.
 *
 * Required environment variables:
 *   SPOTIFY_CLIENT_ID
 *   SPOTIFY_CLIENT_SECRET
 *
 * Usage:
 *   const spotify = require('./providers/spotify');
 *   const tracks = await spotify.searchTracks('Bohemian Rhapsody');
 */

'use strict';

const SPOTIFY_ACCOUNTS_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 2; // number of retries AFTER the initial attempt
const DEFAULT_RETRY_DELAY_MS = 400;

/**
 * In-memory cache for the client-credentials access token.
 * @type {{ token: string|null, expiresAt: number }}
 */
const tokenCache = {
  token: null,
  expiresAt: 0, // epoch ms
};

/**
 * In-flight token request, used to de-duplicate concurrent refreshes.
 * @type {Promise<string>|null}
 */
let pendingTokenRequest = null;

/* -------------------------------------------------------------------- */
/*  Low-level utilities                                                  */
/* -------------------------------------------------------------------- */

/**
 * Sleep helper for retry backoff.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps `fetch` with a timeout using AbortController.
 *
 * @param {string} url
 * @param {import('node-fetch').RequestInit} options
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 * @throws {Error} on network failure or timeout
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Spotify provider: request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new Error(`Spotify provider: network error calling ${url} — ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Performs an HTTP request with retry logic for transient failures
 * (network errors, timeouts, 429, and 5xx responses).
 *
 * @param {string} url
 * @param {import('node-fetch').RequestInit} options
 * @param {{ retries?: number, timeoutMs?: number, retryDelayMs?: number }} [config]
 * @returns {Promise<Response>}
 */
async function requestWithRetry(url, options = {}, config = {}) {
  const {
    retries = DEFAULT_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = config;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);

      // Retry on rate limiting or server errors.
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(
          `Spotify provider: received status ${response.status} from ${url}`
        );

        if (attempt < retries) {
          const retryAfterHeader = response.headers.get('retry-after');
          const backoff = retryAfterHeader
            ? Number(retryAfterHeader) * 1000
            : retryDelayMs * (attempt + 1);
          await sleep(backoff);
          continue;
        }
      }

      return response;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError;
}

/* -------------------------------------------------------------------- */
/*  OAuth: Client Credentials flow                                       */
/* -------------------------------------------------------------------- */

/**
 * Fetches a fresh access token from Spotify using the client credentials
 * grant. Not exported — internal use only.
 *
 * @returns {Promise<string>} access token
 * @throws {Error} if credentials are missing or the request fails
 */
async function fetchNewAccessToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Spotify provider: missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET environment variables'
    );
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await requestWithRetry(
    SPOTIFY_ACCOUNTS_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    },
    { retries: DEFAULT_RETRIES, timeoutMs: DEFAULT_TIMEOUT_MS }
  );

  if (!response.ok) {
    const bodyText = await safeReadText(response);
    throw new Error(
      `Spotify provider: failed to obtain access token (status ${response.status}) — ${bodyText}`
    );
  }

  const data = await response.json();

  if (!data.access_token || !data.expires_in) {
    throw new Error('Spotify provider: malformed token response from Spotify');
  }

  return {
    token: data.access_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Returns a valid access token, transparently refreshing (and caching)
 * it when missing or expired. Concurrent callers share a single
 * in-flight refresh request.
 *
 * @returns {Promise<string>}
 */
async function getAccessToken() {
  const now = Date.now();

  // 30s safety margin before actual expiry.
  if (tokenCache.token && now < tokenCache.expiresAt - 30000) {
    return tokenCache.token;
  }

  if (pendingTokenRequest) {
    return pendingTokenRequest;
  }

  pendingTokenRequest = (async () => {
    try {
      const { token, expiresIn } = await fetchNewAccessToken();
      tokenCache.token = token;
      tokenCache.expiresAt = Date.now() + expiresIn * 1000;
      return token;
    } finally {
      pendingTokenRequest = null;
    }
  })();

  return pendingTokenRequest;
}

/**
 * Best-effort read of a response body as text, for error messages.
 * Never throws.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return '<unreadable response body>';
  }
}

/* -------------------------------------------------------------------- */
/*  Authenticated request helper                                         */
/* -------------------------------------------------------------------- */

/**
 * Performs an authenticated GET request against the Spotify Web API.
 * Handles a single automatic retry with a fresh token if the API
 * responds with 401 (expired/invalid token).
 *
 * @param {string} path - path relative to SPOTIFY_API_BASE_URL, e.g. '/search'
 * @param {Record<string, string|number>} [params]
 * @returns {Promise<any>} parsed JSON body
 * @throws {Error} descriptive error on failure
 */
async function spotifyGet(path, params = {}) {
  const url = new URL(SPOTIFY_API_BASE_URL + path);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });

  const doRequest = async (forceRefresh = false) => {
    if (forceRefresh) {
      tokenCache.token = null;
      tokenCache.expiresAt = 0;
    }
    const token = await getAccessToken();

    return requestWithRetry(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  };

  let response = await doRequest();

  if (response.status === 401) {
    // Token might have been invalidated; refresh once and retry.
    response = await doRequest(true);
  }

  if (response.status === 404) {
    throw new Error(`Spotify provider: resource not found at ${path}`);
  }

  if (!response.ok) {
    const bodyText = await safeReadText(response);
    throw new Error(
      `Spotify provider: request to ${path} failed with status ${response.status} — ${bodyText}`
    );
  }

  try {
    return await response.json();
  } catch (err) {
    throw new Error(`Spotify provider: failed to parse JSON response from ${path} — ${err.message}`);
  }
}

/* -------------------------------------------------------------------- */
/*  Validation helpers                                                   */
/* -------------------------------------------------------------------- */

/**
 * Validates that a search query string is present and non-empty.
 * @param {string} query
 * @param {string} methodName
 */
function assertValidQuery(query, methodName) {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error(`Spotify provider: ${methodName}() requires a non-empty string query`);
  }
}

/**
 * Validates that an id string is present and non-empty.
 * @param {string} id
 * @param {string} methodName
 */
function assertValidId(id, methodName) {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error(`Spotify provider: ${methodName}() requires a non-empty string id`);
  }
}

/**
 * Clamps and validates an optional `limit` param, defaulting to 10.
 * @param {number|undefined} limit
 * @returns {number}
 */
function normalizeLimit(limit) {
  if (limit === undefined) return 10;
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(Math.floor(n), 50);
}

/* -------------------------------------------------------------------- */
/*  Normalizers — the ONLY place Spotify's raw shapes are touched        */
/* -------------------------------------------------------------------- */

/**
 * @typedef {Object} NormalizedArtist
 * @property {string} id
 * @property {string} name
 * @property {string[]} genres
 * @property {number|null} popularity
 * @property {string|null} imageUrl
 * @property {string|null} url
 */

/**
 * @typedef {Object} NormalizedAlbum
 * @property {string} id
 * @property {string} name
 * @property {string} albumType
 * @property {string[]} artists
 * @property {string|null} releaseDate
 * @property {number|null} totalTracks
 * @property {string|null} imageUrl
 * @property {string|null} url
 */

/**
 * @typedef {Object} NormalizedTrack
 * @property {string} id
 * @property {string} name
 * @property {string[]} artists
 * @property {string} albumName
 * @property {string|null} albumImageUrl
 * @property {number} durationMs
 * @property {boolean} explicit
 * @property {number|null} popularity
 * @property {string|null} previewUrl
 * @property {string|null} url
 */

/**
 * Normalizes a raw Spotify artist object.
 * @param {any} artist
 * @returns {NormalizedArtist}
 */
function normalizeArtist(artist) {
  return {
    id: artist.id,
    name: artist.name,
    genres: Array.isArray(artist.genres) ? artist.genres : [],
    popularity: typeof artist.popularity === 'number' ? artist.popularity : null,
    imageUrl: artist.images && artist.images.length > 0 ? artist.images[0].url : null,
    url: artist.external_urls ? artist.external_urls.spotify || null : null,
  };
}

/**
 * Normalizes a raw Spotify album object.
 * @param {any} album
 * @returns {NormalizedAlbum}
 */
function normalizeAlbum(album) {
  return {
    id: album.id,
    name: album.name,
    albumType: album.album_type || 'unknown',
    artists: Array.isArray(album.artists) ? album.artists.map((a) => a.name) : [],
    releaseDate: album.release_date || null,
    totalTracks: typeof album.total_tracks === 'number' ? album.total_tracks : null,
    imageUrl: album.images && album.images.length > 0 ? album.images[0].url : null,
    url: album.external_urls ? album.external_urls.spotify || null : null,
  };
}

/**
 * Normalizes a raw Spotify track object.
 * @param {any} track
 * @returns {NormalizedTrack}
 */
function normalizeTrack(track) {
  return {
    id: track.id,
    name: track.name,
    artists: Array.isArray(track.artists) ? track.artists.map((a) => a.name) : [],
    albumName: track.album ? track.album.name : '',
    albumImageUrl:
      track.album && track.album.images && track.album.images.length > 0
        ? track.album.images[0].url
        : null,
    durationMs: typeof track.duration_ms === 'number' ? track.duration_ms : 0,
    explicit: Boolean(track.explicit),
    popularity: typeof track.popularity === 'number' ? track.popularity : null,
    previewUrl: track.preview_url || null,
    url: track.external_urls ? track.external_urls.spotify || null : null,
  };
}

/* -------------------------------------------------------------------- */
/*  Public provider API                                                  */
/* -------------------------------------------------------------------- */

/**
 * Searches Spotify for tracks matching a query.
 *
 * @param {string} query - free-text search query
 * @param {{ limit?: number }} [options]
 * @returns {Promise<NormalizedTrack[]>}
 * @throws {Error} on invalid input or upstream failure
 */
async function searchTracks(query, options = {}) {
  assertValidQuery(query, 'searchTracks');
  const limit = normalizeLimit(options.limit);

  const data = await spotifyGet('/search', {
    q: query,
    type: 'track',
    limit,
  });

  const items = data.tracks && Array.isArray(data.tracks.items) ? data.tracks.items : [];
  return items.map(normalizeTrack);
}

/**
 * Fetches a single track by its Spotify ID.
 *
 * @param {string} id - Spotify track ID
 * @returns {Promise<NormalizedTrack>}
 * @throws {Error} on invalid input or upstream failure
 */
async function getTrack(id) {
  assertValidId(id, 'getTrack');
  const data = await spotifyGet(`/tracks/${encodeURIComponent(id)}`);
  return normalizeTrack(data);
}

/**
 * Searches Spotify for albums matching a query.
 *
 * @param {string} query - free-text search query
 * @param {{ limit?: number }} [options]
 * @returns {Promise<NormalizedAlbum[]>}
 * @throws {Error} on invalid input or upstream failure
 */
async function searchAlbums(query, options = {}) {
  assertValidQuery(query, 'searchAlbums');
  const limit = normalizeLimit(options.limit);

  const data = await spotifyGet('/search', {
    q: query,
    type: 'album',
    limit,
  });

  const items = data.albums && Array.isArray(data.albums.items) ? data.albums.items : [];
  return items.map(normalizeAlbum);
}

/**
 * Searches Spotify for artists matching a query.
 *
 * @param {string} query - free-text search query
 * @param {{ limit?: number }} [options]
 * @returns {Promise<NormalizedArtist[]>}
 * @throws {Error} on invalid input or upstream failure
 */
async function searchArtists(query, options = {}) {
  assertValidQuery(query, 'searchArtists');
  const limit = normalizeLimit(options.limit);

  const data = await spotifyGet('/search', {
    q: query,
    type: 'artist',
    limit,
  });

  const items = data.artists && Array.isArray(data.artists.items) ? data.artists.items : [];
  return items.map(normalizeArtist);
}

module.exports = {
  searchTracks,
  getTrack,
  searchAlbums,
  searchArtists,
};