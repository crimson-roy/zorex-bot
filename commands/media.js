'use strict';

const { resolveMedia } = require('../providers/media');
const { startProgress } = require('../lib/progressIndicator');

function guessType(filename = '', url = '') {
  const value = `${filename} ${url}`.toLowerCase();

  if (/\.(jpe?g|png|webp|avif)(\?|$)/.test(value)) return 'photo';
  if (/\.(gif)(\?|$)/.test(value)) return 'gif';
  if (/\.(mp3|m4a|ogg|opus|wav|aac|flac)(\?|$)/.test(value)) return 'audio';

  return 'video';
}

async function sendMedia(sock, jid, msg, type, url, filename) {
  const safeName = filename || 'media';

  if (type === 'photo') {
    return sock.sendMessage(
      jid,
      { image: { url }, caption: `📥 ${safeName}` },
      { quoted: msg }
    );
  }

  if (type === 'audio') {
    return sock.sendMessage(
      jid,
      {
        audio: { url },
        mimetype: 'audio/mpeg',
        fileName: safeName,
      },
      { quoted: msg }
    );
  }

  if (type === 'gif') {
    return sock.sendMessage(
      jid,
      {
        video: { url },
        gifPlayback: true,
        caption: `📥 ${safeName}`,
      },
      { quoted: msg }
    );
  }

  return sock.sendMessage(
    jid,
    {
      video: { url },
      caption: `📥 ${safeName}`,
    },
    { quoted: msg }
  );
}

async function execute(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const url = args.join(' ').trim();

  if (!url) {
    return sock.sendMessage(
      jid,
      {
        text:
          '📥 *MEDIA DOWNLOADER*\n\n' +
          'Usage: *.media <link>*\n\n' +
          'Supports public links from Instagram, X/Twitter, Facebook, Reddit, Pinterest, Snapchat, Vimeo, SoundCloud and other Cobalt-supported sites.',
      },
      { quoted: msg }
    );
  }

  const progress = await startProgress(sock, msg, '⬇️ Resolving media...');

  try {
    const result = await resolveMedia(url);

    if (result.status === 'picker') {
      const items = Array.isArray(result.picker) ? result.picker : [];

      if (!items.length) {
        throw new Error('Cobalt returned an empty media picker.');
      }

      await progress.update(`📦 Found ${items.length} media item(s). Sending...`);

      const maxItems = 20;
      const selected = items.slice(0, maxItems);

      for (let i = 0; i < selected.length; i++) {
        const item = selected[i];
        await sendMedia(
          sock,
          jid,
          msg,
          item.type || guessType('', item.url),
          item.url,
          `media-${i + 1}`
        );
      }

      if (result.audio) {
        await sendMedia(
          sock,
          jid,
          msg,
          'audio',
          result.audio,
          result.audioFilename || 'audio'
        );
      }

      if (items.length > maxItems) {
        await sock.sendMessage(
          jid,
          { text: `⚠️ This post has ${items.length} items. I sent the first ${maxItems} to avoid flooding the chat.` },
          { quoted: msg }
        );
      }

      await progress.succeed();
      return;
    }

    if (result.status === 'tunnel' || result.status === 'redirect') {
      const type = guessType(result.filename, result.url);

      await progress.update('📤 Sending media...');
      await sendMedia(
        sock,
        jid,
        msg,
        type,
        result.url,
        result.filename || 'media'
      );

      await progress.succeed();
      return;
    }

    if (result.status === 'local-processing') {
      throw new Error('This media needs local processing, which is not enabled for .media yet.');
    }

    throw new Error(`Unsupported Cobalt response: ${result.status || 'unknown'}`);
  } catch (err) {
    console.error('[.media] Failed:', err);

    await progress.fail();

    const code = err?.code || err?.message || 'unknown error';
    await sock.sendMessage(
      jid,
      {
        text:
          '❌ I could not download that media.\n' +
          `Reason: ${code}\n\n` +
          'Make sure the post is public and the link is valid.',
      },
      { quoted: msg }
    );
  }
}

module.exports = {
  name: 'media',
  description: 'Download media from public links supported by the local Cobalt instance.',
  usage: '.media <link>',
  execute,
};
