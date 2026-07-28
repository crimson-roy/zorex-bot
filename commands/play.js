/**
 * commands/play.js
 *
 * .play <query>
 * ---------------
 * Orchestration layer only. All provider-specific logic (Spotify
 * search, YouTube search/download) lives in providers/spotify.js and
 * providers/youtube.js — this file just sequences those calls and
 * talks to WhatsApp.
 *
 * Flow:
 *   1. Search Spotify for the query to resolve correct song metadata
 *      (title + artist).
 *   2. Build a "<title> <artist>" query and search YouTube with it.
 *   3. If Spotify returned nothing, fall back to searching YouTube
 *      with the user's original query directly.
 *   4. Download the highest-quality audio-only stream from YouTube.
 *   5. Send it as WhatsApp audio.
 *   6. Always clean up the temp file, success or failure.
 *
 * NOTE ON INTEGRATION: this file assumes the common Baileys-style
 * command-module shape used elsewhere in Zorex Bot — a `name` plus an
 * `execute(sock, msg, args)` handler, where `sock` is the active
 * Baileys socket and `msg` is the raw incoming message object. Adjust
 * the export shape / handler signature here if your command loader
 * expects something different — none of the provider logic below
 * depends on it.
 */

'use strict';

const fs = require('fs');

const spotify = require('../providers/spotify');
const youtube = require('../providers/youtube');

/**
 * Builds the effective YouTube search query from resolved Spotify
 * track metadata.
 *
 * @param {{ name: string, artists: string[] }} track
 * @returns {string}
 */
function buildYoutubeQuery(track) {
  const artistNames = Array.isArray(track.artists) ? track.artists.join(' ') : '';
  return `${track.name} ${artistNames}`.trim();
}

/**
 * Removes a temp file if it exists, swallowing any error — cleanup
 * should never mask the real result of the command.
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
 * Executes the .play command.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @param {string[]} args - words after the command, e.g. ['die', 'with', 'a', 'smile']
 * @returns {Promise<void>}
 */
async function execute(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const query = args.join(' ').trim();

  if (!query) {
    await sock.sendMessage(jid, { text: 'Usage: .play <song name>' }, { quoted: msg });
    return;
  }

  let audioResult;

  try {
    let youtubeQuery = query;
    let caption = `🎵 ${query}`;

    // Step 1: resolve correct metadata via Spotify.
    try {
      const spotifyResults = await spotify.searchTracks(query, { limit: 1 });

      if (spotifyResults.length > 0) {
        const track = spotifyResults[0];
        youtubeQuery = buildYoutubeQuery(track);
        caption = `🎵 ${track.name} — ${track.artists.join(', ')}`;
      }
      // If Spotify returns nothing, youtubeQuery/caption keep the
      // original raw query — this is the documented fallback path.
    } catch (spotifyErr) {
      // Spotify failing entirely is also a fallback trigger, not a
      // hard failure of the command.
      console.error('[.play] Spotify lookup failed, falling back to YouTube:', spotifyErr.message);
    }

    // Step 2: search YouTube using the best query we have.
    const youtubeResults = await youtube.searchVideos(youtubeQuery, { limit: 1 });

    if (youtubeResults.length === 0) {
      await sock.sendMessage(
        jid,
        { text: `No results found for "${query}".` },
        { quoted: msg }
      );
      return;
    }

    const video = youtubeResults[0];

    // Step 3: download highest-quality audio only.
    audioResult = await youtube.downloadAudio(video.id);

    // Step 4: send as WhatsApp audio.
    await sock.sendMessage(
      jid,
      {
        audio: { url: audioResult.filePath },
        mimetype: audioResult.mimeType || 'audio/mp4',
        ptt: false,
      },
      { quoted: msg }
    );

    await sock.sendMessage(jid, { text: caption }, { quoted: msg });
  } catch (err) {
    console.error('[.play] Failed:', err);
    await sock.sendMessage(
      jid,
      { text: `Couldn't play that track: ${err.message}` },
      { quoted: msg }
    );
  } finally {
    cleanupTempFile(audioResult && audioResult.filePath);
  }
}

module.exports = {
  name: 'play',
  description: 'Search Spotify for a track and send its audio from YouTube.',
  usage: '.play <song name>',
  execute,
};
