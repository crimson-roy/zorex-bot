// commands/chloe.js
//
// Wire this into your Baileys message handler. It expects to be called
// once per incoming message, and figures out on its own whether Chloe
// should reply.
//
// Assumed Baileys-ish message shape (adjust the field names to match
// whatever your socket actually hands you):
//   msg.key.remoteJid       -> chat id
//   msg.key.fromMe          -> bool
//   msg.message.conversation / extendedTextMessage.text -> text body
//   msg.message.extendedTextMessage.contextInfo.mentionedJid -> [ids] (tags)
//   msg.message.extendedTextMessage.contextInfo.quotedMessage -> replied-to msg
//   msg.pushName            -> sender's display name

const fs = require('fs');
const { CHLOE_SYSTEM_PROMPT } = require('../lib/chloePersona');
const memory = require('../lib/chloeMemory');
const { callAI } = require('../lib/aiClient');
const { judgeExchange } = require('../lib/relationshipEngine');
const { recordExchange } = require('../lib/relationshipStore');
const { MAIN_OWNER } = require('../config');

const OWNERS_FILE = './owners.json';
const BOT_NAME = 'chloe';

// The bot's own WhatsApp id, for detecting @mentions and "replied to me".
// There is no reliable env var for this — Baileys only knows it once the
// socket actually connects. index.js calls setBotJid() from its
// connection.update handler ("open") with the real, normalized JID.
let BOT_JID = process.env.BOT_JID || null;

function setBotJid(jid) {
  BOT_JID = jid;
}

// Same owner check used elsewhere in the codebase (owner.js) — MAIN_OWNER
// from config, plus anyone added via .addowner into owners.json. Group
// admin status is NOT enough on its own — admins are not automatically
// owners.
function isOwner(userId) {
  if (userId === MAIN_OWNER) return true;
  try {
    const owners = JSON.parse(fs.readFileSync(OWNERS_FILE, 'utf8'));
    return owners.includes(userId);
  } catch (err) {
    return false; // owners.json missing/unreadable — fail closed, not open
  }
}

function extractText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    ''
  );
}

function getContextInfo(msg) {
  const m = msg.message || {};
  return (m.extendedTextMessage && m.extendedTextMessage.contextInfo) || {};
}

function isNameMentioned(text) {
  return new RegExp(`\\b${BOT_NAME}\\b`, 'i').test(text);
}

function isTagged(msg) {
  const ctx = getContextInfo(msg);
  const mentioned = ctx.mentionedJid || [];
  return BOT_JID ? mentioned.includes(BOT_JID) : false;
}

function isReplyToBot(msg) {
  const ctx = getContextInfo(msg);
  // Baileys puts the quoted sender in ctx.participant for group chats
  return !!ctx.quotedMessage && BOT_JID && ctx.participant === BOT_JID;
}

function isSummonCommand(text) {
  return /^\.chaton\b|^\.chatoff\b/i.test(text.trim());
}

/**
 * Call this for every incoming message.
 * @param {object} sock - your Baileys socket, for sending replies
 * @param {object} msg - the incoming message object
 */
async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const chatId = msg.key.remoteJid;
  const text = extractText(msg).trim();
  const senderName = msg.pushName || 'Someone';

  if (!text) return;

  // --- Toggle commands: owners only, regardless of current state ---
  if (/^\.chaton\b/i.test(text)) {
    const userId = msg.key.participant || msg.key.remoteJid;
    if (!isOwner(userId)) {
      await sock.sendMessage(chatId, { text: '❌ Only my owners can do that.' }, { quoted: msg });
      return;
    }
    memory.setActive(chatId, true);
    await sock.sendMessage(chatId, { text: "hey, I'm here 🙂" });
    return;
  }
  if (/^\.chatoff\b/i.test(text)) {
    const userId = msg.key.participant || msg.key.remoteJid;
    if (!isOwner(userId)) {
      await sock.sendMessage(chatId, { text: '❌ Only my owners can do that.' }, { quoted: msg });
      return;
    }
    memory.setActive(chatId, false);
    await sock.sendMessage(chatId, { text: 'okay, going quiet. ping me anytime.' });
    return;
  }

  const active = memory.isActive(chatId);

  // Explicit summon (e.g. ".chloe <message>") always works, active or not.
  const summonMatch = text.match(/^\.chloe\s+([\s\S]+)/i);
  const isExplicitSummon = !!summonMatch;

  let shouldReply = false;
  let effectiveText = text;

  if (isExplicitSummon) {
    shouldReply = true;
    effectiveText = summonMatch[1].trim();
  } else if (active) {
    // While .chaton is active: reply on name mention, @tag, or reply-to-her-message.
    shouldReply = isNameMentioned(text) || isTagged(msg) || isReplyToBot(msg);
  }

  if (!shouldReply) {
    // Still log the message to history so context isn't lost when she does chime in.
    if (active) memory.appendMessage(chatId, 'user', text, senderName);
    return;
  }

  memory.appendMessage(chatId, 'user', effectiveText, senderName);

  const history = memory.getHistory(chatId);
  const messagesForAI = history.map(h => ({
    role: h.role,
    content: h.senderName && h.role === 'user' ? `${h.senderName}: ${h.content}` : h.content,
  }));

  try {
    const reply = await callAI(CHLOE_SYSTEM_PROMPT, messagesForAI);
    memory.appendMessage(chatId, 'assistant', reply, null);
    await sock.sendMessage(chatId, { text: reply }, { quoted: msg });

    // Update trust/affection based on this exchange. Fire-and-forget-ish:
    // failures here are logged but never block or undo the reply already sent.
    const userId = msg.key.participant || msg.key.remoteJid;
    judgeExchange(senderName, effectiveText, reply)
      .then(delta => recordExchange(userId, delta))
      .catch(err => console.error('[chloe] relationship update failed:', err.message));
  } catch (err) {
    console.error('[chloe] AI call failed:', err.message);
    await sock.sendMessage(chatId, { text: 'ugh, my head just went blank — try again in a sec?' });
  }
}

module.exports = { handleMessage, setBotJid };