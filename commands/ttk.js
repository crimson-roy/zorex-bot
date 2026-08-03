/**
 * commands/ttk.js
 *
 * .ttk <tiktok-url>
 * -------------------
 * Orchestration layer only. All provider-specific logic (validation,
 * metadata resolution, watermark-free download) lives in
 * providers/tiktok.js — this file just sequences the call and talks
 * to WhatsApp. Completely separate from the YouTube command/provider.
 *
 * Flow:
 *   1. React ⌛ and post a status message (lib/progressIndicator.js) so
 *      the user sees the bot working instead of going quiet until the
 *      video arrives.
 *   2. Take the raw URL argument as-is (providers/tiktok.js owns URL
 *      validation — this file does not duplicate that logic).
 *   3. Download the video without watermark whenever possible.
 *   4. Send the video, then swap the reaction to ✅ and edit the status
 *      message to "Task Completed" (or ❌ / "Task Failed" on any error
 *      along the way).
 *   5. Always delete the temp file — success or failure.
 *
 * NOTE ON INTEGRATION: this file assumes the common Baileys-style
 * command-module shape used elsewhere in Zorex Bot — a `name` plus an
 * `execute(sock, msg, args)` handler. Adjust the export shape /
 * handler signature here if your command loader expects something
 * different — none of the provider logic below depends on it.
 */

'use strict';

const fs = require('fs');

const tiktok = require('../providers/tiktok');
const { startProgress } = require('../lib/progressIndicator');

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
 * Executes the .ttk command.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @param {string[]} args - words after the command, e.g. ['https://vm.tiktok.com/XXXXXXX/']
 * @returns {Promise<void>}
 */
async function execute(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const url = args.join(' ').trim();

  if (!url) {
    await sock.sendMessage(jid, { text: 'Usage: .ttk <tiktok url>' }, { quoted: msg });
    return;
  }

  const progress = await startProgress(sock, msg, '⬇️ Downloading TikTok video...');

  let downloadResult;

  try {
    // Step 1 & 2: the provider validates the URL and downloads the
    // clean (no-watermark, best effort) video.
    downloadResult = await tiktok.downloadVideo(url);

    // Step 3: send the video with metadata as a caption.
    await sock.sendMessage(
      jid,
      {
        video: { url: downloadResult.filePath },
        mimetype: downloadResult.mimeType || 'video/mp4',
        caption: `🎬 ${downloadResult.title}\n👤 ${downloadResult.author}`,
      },
      { quoted: msg }
    );

    await progress.succeed();
  } catch (err) {
    console.error('[.ttk] Failed:', err);
    await progress.fail();
  } finally {
    // Step 4: always clean up the temp file.
    cleanupTempFile(downloadResult && downloadResult.filePath);
  }
}

module.exports = {
  name: 'ttk',
  description: 'Download a TikTok video without watermark and send it.',
  usage: '.ttk <tiktok url>',
  execute,
};