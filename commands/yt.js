/**
 * commands/yt.js
 *
 * .yt <query>
 * .yt <youtube-url>
 * ------------------
 * Orchestration layer only. All provider-specific logic (searching,
 * resolving metadata, downloading) lives in providers/youtube.js —
 * this file just decides text-vs-URL, sequences the calls, and talks
 * to WhatsApp.
 *
 * Flow:
 *   1. If the argument is a YouTube URL, skip searching and use it
 *      directly.
 *   2. Otherwise, search YouTube and take the first result.
 *   3. Download the highest practical MP4 (audio + video together).
 *   4. Send the video, then delete the temp file — success or
 *      failure.
 *
 * NOTE ON INTEGRATION: this file assumes the common Baileys-style
 * command-module shape used elsewhere in Zorex Bot — a `name` plus an
 * `execute(sock, msg, args)` handler. Adjust the export shape /
 * handler signature here if your command loader expects something
 * different — none of the provider logic below depends on it.
 */

'use strict';

const fs = require('fs');

const youtube = require('../providers/youtube');

const YOUTUBE_URL_PATTERN = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be)\/.+/i;

/**
 * Determines whether the given raw input already looks like a
 * YouTube URL, as opposed to a free-text search query.
 *
 * @param {string} input
 * @returns {boolean}
 */
function isYoutubeUrl(input) {
  return YOUTUBE_URL_PATTERN.test(input.trim());
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
 * Executes the .yt command.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @param {string[]} args - words after the command, e.g. ['funny', 'cats'] or ['https://youtube.com/...']
 * @returns {Promise<void>}
 */
async function execute(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const input = args.join(' ').trim();

  if (!input) {
    await sock.sendMessage(
      jid,
      { text: 'Usage: .yt <search terms> or .yt <youtube url>' },
      { quoted: msg }
    );
    return;
  }

  let downloadResult;

  try {
    let targetId = input;

    // Step 1: text vs URL branch.
    if (!isYoutubeUrl(input)) {
      const results = await youtube.searchVideos(input, { limit: 1 });

      if (results.length === 0) {
        await sock.sendMessage(
          jid,
          { text: `No results found for "${input}".` },
          { quoted: msg }
        );
        return;
      }

      targetId = results[0].id;
    }

    // Step 2: download the highest practical combined MP4.
    downloadResult = await youtube.downloadVideo(targetId);

    // Step 3: send the video with metadata as a caption.
    await sock.sendMessage(
      jid,
      {
        video: { url: downloadResult.filePath },
        mimetype: downloadResult.mimeType || 'video/mp4',
        caption: `🎬 ${downloadResult.title}\n⏱ ${downloadResult.duration} • ${downloadResult.quality}`,
      },
      { quoted: msg }
    );
  } catch (err) {
    console.error('[.yt] Failed:', err);
    await sock.sendMessage(
      jid,
      { text: `Couldn't fetch that video: ${err.message}` },
      { quoted: msg }
    );
  } finally {
    // Step 4: always clean up the temp file.
    cleanupTempFile(downloadResult && downloadResult.filePath);
  }
}

module.exports = {
  name: 'yt',
  description: 'Search YouTube or fetch a direct link and send the video.',
  usage: '.yt <search terms | youtube url>',
  execute,
};
