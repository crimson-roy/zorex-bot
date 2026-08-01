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
const { pickSticker } = require('../lib/chloeStickers');
const { MAIN_OWNER } = require('../config');

// PERSISTENCE FIX: owners.json is written by owner.js (.addowner/
// .removeowner). isOwner() below only reads it, but it must resolve to the
// same path owner.js writes to, or a newly added owner would never show up
// here after a redeploy. See lib/dataPath.js.
const dataPath = require('../lib/dataPath');
const OWNERS_FILE = dataPath('owners.json');
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

// Instructs the AI to silently tag its own emotional tone at the end of
// each reply, so we can pick a matching sticker without a second API call.
// The tag is stripped before the person ever sees it.
const MOOD_TAG_INSTRUCTION =
  "At the very end of your reply, on its own new line, add exactly: " +
  "[mood: X] where X is ONE of these exact words and no others: neutral, " +
  "happy, laughing, loving, pouty, angry, sad, shy, teasing, special — " +
  "whichever best matches your actual emotional tone in THIS reply. This " +
  "tag is stripped before the person sees your message, so it's just for " +
  "internal bookkeeping — always include it, every single reply, no " +
  "exceptions, and never use a mood word outside this list.";

const MOOD_TAG_REGEX = /\n?\[mood:\s*(\w+)\]\s*$/i;
const VALID_MOODS = new Set([
  'neutral', 'happy', 'laughing', 'loving', 'pouty', 'angry', 'sad', 'shy', 'teasing', 'special',
]);

function buildSystemPrompt(userId) {
  const rel = getRelationship(userId);
  const tier = getTier(rel.trust);
  const tierInstructions = TIER_INSTRUCTIONS[tier.key] || TIER_INSTRUCTIONS.stranger;
  return `${CHLOE_SYSTEM_PROMPT}\n\n${tierInstructions}\n\n${MOOD_TAG_INSTRUCTION}`;
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
  const userId = msg.key.participant || msg.key.remoteJid;

  if (!text) return;

  // Any dot-command that isn't one of Chloe's own (.chaton/.chatoff/.chloe)
  // belongs to another command file (economy, .relation, .mem, etc.) and
  // must never trigger an AI reply or sticker here — even if it happens to
  // be sent as a reply to one of Chloe's messages or mentions her name.
  if (/^\./.test(text) && !/^\.(chaton|chatoff|chloe)\b/i.test(text)) return;

  // --- Toggle commands: owners only, regardless of current state ---
  if (/^\.chaton\b/i.test(text)) {
    if (!isOwner(userId)) {
      await sock.sendMessage(chatId, { text: '❌ Only my owners can do that.' }, { quoted: msg });
      return;
    }
    memory.setActive(chatId, true);
    await sock.sendMessage(chatId, { text: "hey, I'm here 🙂" });
    return;
  }
  if (/^\.chatoff\b/i.test(text)) {
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
    if (active) memory.appendMessage(chatId, userId, 'user', text, senderName);
    return;
  }

  memory.appendMessage(chatId, userId, 'user', effectiveText, senderName);

  const history = memory.getHistory(chatId, userId);
  const messagesForAI = history.map(h => ({
    role: h.role,
    content: h.senderName && h.role === 'user' ? `${h.senderName}: ${h.content}` : h.content,
  }));

  try {
    const systemPrompt = buildSystemPrompt(userId);
    const rawReply = await callAI(systemPrompt, messagesForAI);

    const moodMatch = rawReply.match(MOOD_TAG_REGEX);
    const rawMood = moodMatch ? moodMatch[1].toLowerCase() : 'neutral';
    const mood = VALID_MOODS.has(rawMood) ? rawMood : 'neutral';
    const reply = rawReply.replace(MOOD_TAG_REGEX, '').trim();

    memory.appendMessage(chatId, userId, 'assistant', reply, null);
    await sock.sendMessage(chatId, { text: reply }, { quoted: msg });

    // Follow up every reply with a sticker matching her mood + how close
    // she is to this person, so it feels more interactive. Never blocks/
    // undoes the text reply above if it fails or no sticker is available yet.
    try {
      const rel = getRelationship(userId);
      const tier = getTier(rel.trust);
      const stickerPath = pickSticker(tier.key, mood);
      if (stickerPath) {
        await sock.sendMessage(chatId, { sticker: fs.readFileSync(stickerPath) });
      }
    } catch (err) {
      console.error('[chloe] sticker send failed:', err.message);
    }

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