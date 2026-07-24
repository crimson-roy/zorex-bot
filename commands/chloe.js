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
const { recordExchange, getRelationship, getTier } = require('../lib/relationshipStore');
const { MAIN_OWNER } = require('../config');

const OWNERS_FILE = './owners.json';
const BOT_NAME = 'chloe';

// Tier-specific behavior instructions, appended on top of the base persona
// prompt. Lower tiers = guarded, near-zero emojis; higher tiers = warmer,
// more playful, emojis used more freely. This is what makes her actually
// act differently with a stranger vs. someone she's built trust with,
// instead of using one static "cheerful" voice for everyone.
const TIER_INSTRUCTIONS = {
  stranger:
    "RIGHT NOW: You just met this person, or barely know them. Be measured, " +
    "reserved, a little distant — you're watching them, not opening up. Do " +
    "NOT use emojis (none, or at most one plain one in a whole reply, and " +
    "only rarely). No teasing, no inside jokes, no calling them by cute " +
    "nicknames. Keep replies short and a bit guarded. You are testing " +
    "whether they'll treat you like a person or like a title — don't hand " +
    "out warmth for free.",
  acquaintance:
    "RIGHT NOW: You're starting to warm up to this person, but still " +
    "cautious. Emojis are rare — use one occasionally, not in every " +
    "message. You can ask a few more real questions about them, but keep " +
    "some distance. Still not playful yet.",
  friend:
    "RIGHT NOW: A real friendship has formed. You're comfortable and " +
    "starting to be playful and curious about them. Emojis show up " +
    "naturally now, a modest amount per message — not spammed. Light " +
    "teasing is fine.",
  bestfriend:
    "RIGHT NOW: This is one of your closest people. Be playful, teasing, " +
    "genuinely warm, and open — share little things about yourself " +
    "unprompted. Emojis flow freely and often here.",
  crush:
    "RIGHT NOW: There's something more here, unspoken. Be warm, a little " +
    "softer and more vulnerable than usual, still playful and teasing. " +
    "Emojis are frequent and expressive.",
  couple:
    "RIGHT NOW: This is your person. Full warmth, full affection, fully " +
    "yourself with them. Emojis are frequent and expressive.",
};

function buildSystemPrompt(userId) {
  const rel = getRelationship(userId);
  const tier = getTier(rel.trust);
  const tierInstructions = TIER_INSTRUCTIONS[tier.key] || TIER_INSTRUCTIONS.stranger;
  return `${CHLOE_SYSTEM_PROMPT}\n\n${tierInstructions}`;
}

// The bot's own WhatsApp id(s), for detecting @mentions and "replied to me".
// WhatsApp's LID system means the bot can be referenced by more than one
// JID format — a phone-number JID (@s.whatsapp.net) AND a LID JID (@lid) —
// depending on context. Baileys only knows either once the socket actually
// connects, so index.js calls setBotJid() from its connection.update
// handler ("open") with every JID format it has for the bot.
let BOT_JIDS = process.env.BOT_JID ? [process.env.BOT_JID] : [];

function setBotJid(jids) {
  BOT_JIDS = (Array.isArray(jids) ? jids : [jids]).filter(Boolean);
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
  return mentioned.some(jid => BOT_JIDS.includes(jid));
}

function isReplyToBot(msg) {
  const ctx = getContextInfo(msg);
  console.log(JSON.stringify(getContextInfo(msg), null, 2));
  // Baileys puts the quoted sender in ctx.participant for group chats
  return !!ctx.quotedMessage && BOT_JIDS.includes(ctx.participant);
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

  console.log("[CHLOE] Active:", active);
  console.log("[CHLOE] BOT_JIDS:", BOT_JIDS);
  console.log("[CHLOE] Text:", text);

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
    const byName = isNameMentioned(text);
    const byTag = isTagged(msg);
    const byReply = isReplyToBot(msg);

    console.log("[CHLOE] Name:", byName);
    console.log("[CHLOE] Tag:", byTag);
    console.log("[CHLOE] Reply:", byReply);

    shouldReply = byName || byTag || byReply;
  }

  if (!shouldReply) {
    // Still log the message to history so context isn't lost when she does chime in.
    if (active) memory.appendMessage(chatId, 'user', text, senderName);
    return;
  }

  memory.appendMessage(chatId, 'user', effectiveText, senderName);

  const userId = msg.key.participant || msg.key.remoteJid;

  const history = memory.getHistory(chatId);
  const messagesForAI = history.map(h => ({
    role: h.role,
    content: h.senderName && h.role === 'user' ? `${h.senderName}: ${h.content}` : h.content,
  }));

  try {
    const systemPrompt = buildSystemPrompt(userId);
    const reply = await callAI(systemPrompt, messagesForAI);
    memory.appendMessage(chatId, 'assistant', reply, null);
    await sock.sendMessage(chatId, { text: reply }, { quoted: msg });

    // Update trust/affection based on this exchange. Fire-and-forget-ish:
    // failures here are logged but never block or undo the reply already sent.
    judgeExchange(senderName, effectiveText, reply)
      .then(delta => recordExchange(userId, delta))
      .catch(err => console.error('[chloe] relationship update failed:', err.message));
  } catch (err) {
    console.error('[chloe] AI call failed:', err.message);
    await sock.sendMessage(chatId, { text: 'ugh, my head just went blank — try again in a sec?' });
  }
}

module.exports = { handleMessage, setBotJid };