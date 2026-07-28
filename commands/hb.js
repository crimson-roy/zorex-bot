/**
 * commands/hb.js
 *
 * .hb @user
 * -----------
 * Sends a public happy-birthday announcement for a mentioned user,
 * using their WhatsApp profile picture when one is available.
 *
 * Restricted to Lord Crimson (MAIN_OWNER) only — same owner system
 * already used across the bot (config.js -> MAIN_OWNER), not a
 * separately invented check.
 *
 * Flow:
 *   1. Confirm the sender is MAIN_OWNER. Deny cleanly otherwise.
 *   2. Read the mentioned user out of the message's contextInfo.
 *      Exactly one mention is required.
 *   3. React 🎂 on the triggering message for immediate feedback that
 *      the command is being processed.
 *   4. Best-effort resolve a display name for the mentioned user and
 *      the current group's name (if applicable), for a more personal
 *      caption. Falls back to the phone number / a generic "Everyone
 *      here" line when either can't be resolved.
 *   5. Attempt to fetch the mentioned user's profile picture via
 *      sock.profilePictureUrl(target, "image"). If that fails for any
 *      reason (privacy settings, no picture set, network error), fall
 *      back to the bundled media/happybirthday.jpg without crashing.
 *   6. Send a single image message with the birthday caption. The
 *      mentioned user is tagged via `mentions: [target]` and via a
 *      matching "@<number>" token in the caption text — WhatsApp only
 *      renders a mention when both are present together. No one else
 *      in the group is tagged.
 *
 * NOTE ON INTEGRATION: this file assumes the common Baileys-style
 * command-module shape used elsewhere in Zorex Bot — a `name` plus an
 * `execute(sock, msg, args)` handler. Adjust the export shape /
 * handler signature here if your command loader expects something
 * different — none of the logic below depends on it.
 */

'use strict';

const path = require('path');

const { MAIN_OWNER } = require('../config');

// Bundled fallback image used whenever the mentioned user has no
// fetchable profile picture. Kept as an absolute path so the command
// behaves the same regardless of the process's working directory.
//
// This is sent the same way ttk.js/yt.js already send local files —
// `{ image: { url: <local path> } }` — rather than reading it into a
// Buffer with fs.readFileSync(). That's an intentional match to this
// codebase's existing precedent (see `video: { url: downloadResult.filePath }`
// in both of those commands), not an oversight.
const FALLBACK_IMAGE_PATH = path.join(process.cwd(), 'media', 'happybirthday.jpg');

/**
 * Extracts the single mentioned user's JID from an incoming message,
 * mirroring the same contextInfo.mentionedJid access pattern already
 * used throughout the owner-commands module.
 *
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @returns {string|null} the mentioned user's JID, or null if none
 */
function extractMentionedUser(msg) {
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;

  if (!mentioned || mentioned.length === 0) {
    return null;
  }

  // Exactly one mentioned user is required by this command — if more
  // than one was tagged, only the first is used as the birthday
  // target, and no one else is included in `mentions`.
  return mentioned[0];
}

/**
 * Turns a WhatsApp JID into the bare digits WhatsApp expects in an
 * "@<number>" mention token (no "+", no domain suffix).
 *
 * @param {string} jid
 * @returns {string}
 */
function jidToPhoneNumber(jid) {
  return jid.split('@')[0];
}

/**
 * Best-effort resolution of a mentioned user's WhatsApp display name.
 * Depends on whatever contact/store data the running socket instance
 * happens to have cached (e.g. via a Baileys in-memory store) — that
 * data is not always present, so every lookup is optional-chained and
 * any failure is swallowed rather than thrown. Falls back to the
 * user's phone number when no name can be resolved.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} jid
 * @returns {string}
 */
function resolveDisplayName(sock, jid) {
  try {
    const contact = sock.contacts?.[jid] || sock.store?.contacts?.[jid];
    const resolved = contact?.notify || contact?.name || contact?.verifiedName;

    if (resolved) {
      return resolved;
    }
  } catch (err) {
    // Contact/store lookups are best-effort only — any failure here
    // just means we fall through to the phone number below.
  }

  return jidToPhoneNumber(jid);
}

/**
 * Attempts to fetch the mentioned user's WhatsApp profile picture
 * URL. Never throws — any failure (no picture set, privacy settings,
 * network error) resolves to null so the caller can fall back to the
 * bundled birthday image instead of crashing the command.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} jid
 * @returns {Promise<string|null>}
 */
async function fetchProfilePictureUrl(sock, jid) {
  try {
    return await sock.profilePictureUrl(jid, 'image');
  } catch (err) {
    return null;
  }
}

/**
 * Best-effort resolution of the current chat's group name, used to
 * personalize the closing line of the birthday caption. Returns null
 * for non-group chats or if the lookup fails for any reason — this
 * must never block or crash the command.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} jid - the chat jid the command was invoked in
 * @returns {Promise<string|null>}
 */
async function resolveGroupName(sock, jid) {
  if (!jid.endsWith('@g.us')) {
    return null;
  }

  try {
    const metadata = await sock.groupMetadata(jid);
    return metadata?.subject || null;
  } catch (err) {
    return null;
  }
}

/**
 * Builds the professional birthday caption for the mentioned user,
 * embedding the "@<number>" mention token WhatsApp needs to render
 * the tag, alongside the resolved display name for readability.
 *
 * @param {string} displayName
 * @param {string} phoneNumber
 * @param {string|null} groupName - resolved group subject, if any
 * @returns {string}
 */
function buildBirthdayCaption(displayName, phoneNumber, groupName) {
  const familyName = groupName ? `The ${groupName} Family` : 'Everyone here';

  return (
    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🎉 HAPPY BIRTHDAY 🎉\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🥳 Happy Birthday @${phoneNumber} ❤️\n\n` +
    `${displayName}, may this new year bring you:\n` +
    `🎂 Happiness\n` +
    `🎁 Success\n` +
    `💰 Prosperity\n` +
    `❤️ Good Health\n` +
    `✨ Endless Blessings\n\n` +
    `🎉 ${familyName} wishes @${phoneNumber} a wonderful birthday! 🎊\n\n` +
    `— Lord Crimson & Chloe`
  );
}

/**
 * Executes the .hb command.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @param {string[]} args - words after the command (unused directly —
 *   the target comes from the message's mentions, not free text)
 * @returns {Promise<void>}
 */
async function execute(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;

  // Step 1: owner restriction — same MAIN_OWNER check used elsewhere
  // in the bot, not a separately invented owner system.
  if (sender !== MAIN_OWNER) {
    await sock.sendMessage(
      jid,
      { text: '❌ Only Lord Crimson can use this command.' },
      { quoted: msg }
    );
    return;
  }

  // Step 2: exactly one mentioned user is required.
  const target = extractMentionedUser(msg);

  if (!target) {
    await sock.sendMessage(jid, { text: 'Usage: .hb @user' }, { quoted: msg });
    return;
  }

  // Step 3: react immediately so the owner sees the command is being
  // processed — profile-picture fetch + send can take a moment.
  try {
    await sock.sendMessage(jid, {
      react: {
        text: '🎂',
        key: msg.key,
      },
    });
  } catch (err) {
    // A failed reaction should never stop the birthday message itself.
  }

  // Step 4: resolve a display name (best effort), the mention token
  // WhatsApp needs to actually render the tag, and the current
  // group's name (if this is a group chat) for a more personal
  // closing line.
  const displayName = resolveDisplayName(sock, target);
  const phoneNumber = jidToPhoneNumber(target);
  const groupName = await resolveGroupName(sock, jid);

  // Step 5: profile picture, with a guaranteed non-crashing fallback.
  const profilePictureUrl = await fetchProfilePictureUrl(sock, target);
  const imageSource = profilePictureUrl || FALLBACK_IMAGE_PATH;

  const caption = buildBirthdayCaption(displayName, phoneNumber, groupName);

  try {
    // Step 6: send the birthday image, tagging only the mentioned
    // user — never the whole group.
    await sock.sendMessage(
      jid,
      {
        image: { url: imageSource },
        caption,
        mentions: [target],
      },
      { quoted: msg }
    );
  } catch (err) {
    console.error('[.hb] Failed:', err);
    await sock.sendMessage(
      jid,
      { text: `Couldn't send the birthday message: ${err.message}` },
      { quoted: msg }
    );
  }
}

module.exports = {
  name: 'hb',
  description: "Send a public happy-birthday announcement for a mentioned user.",
  usage: '.hb @user',
  execute,
};
