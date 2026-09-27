'use strict';

const fs = require('fs');
const dataPath = require('../lib/dataPath');

const AFK_FILE = dataPath('afk.json');

function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  const [left, server] = jid.toLowerCase().split('@');
  if (!server) return jid.toLowerCase();
  return `${left.split(':')[0]}@${server}`;
}

function loadAfk() {
  try {
    if (!fs.existsSync(AFK_FILE)) {
      fs.writeFileSync(AFK_FILE, '{}');
      return {};
    }

    const parsed = JSON.parse(fs.readFileSync(AFK_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.error('[AFK] Failed to load state:', err);
    return {};
  }
}

function saveAfk(data) {
  fs.writeFileSync(AFK_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));

  if (total < 60) return `${total}s`;

  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

async function afkCommand(sock, msg, text) {
  const chatId = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;
  const senderKey = normalizeJid(sender);

  const reason = text.replace(/^\.afk(?:\s+)?/i, '').trim() || 'AFK';

  const afk = loadAfk();
  afk[senderKey] = {
    jid: sender,
    reason,
    since: Date.now(),
  };
  saveAfk(afk);

  return sock.sendMessage(
    chatId,
    {
      text: `💤 @${sender.split('@')[0]} is now AFK.\n📝 Reason: ${reason}`,
      mentions: [sender],
    },
    { quoted: msg }
  );
}

async function handleAfkMessage(sock, msg, text) {
  if (!text) return;

  const chatId = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;
  const senderKey = normalizeJid(sender);
  const isAfkCommand = text === '.afk' || text.startsWith('.afk ');

  const afk = loadAfk();
  let changed = false;

  if (!isAfkCommand && afk[senderKey]) {
    const previous = afk[senderKey];
    delete afk[senderKey];
    changed = true;

    await sock.sendMessage(
      chatId,
      {
        text:
          `👋 @${sender.split('@')[0]} is no longer AFK.\n` +
          `⏱ Away for: ${formatDuration(Date.now() - Number(previous.since || Date.now()))}`,
        mentions: [sender],
      },
      { quoted: msg }
    );
  }

  const context =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    msg.message?.documentMessage?.contextInfo ||
    {};

  const targets = new Map();

  for (const jid of context.mentionedJid || []) {
    targets.set(normalizeJid(jid), jid);
  }

  if (context.participant) {
    targets.set(normalizeJid(context.participant), context.participant);
  }

  targets.delete(senderKey);

  const notices = [];
  const mentions = [];

  for (const [key, targetJid] of targets.entries()) {
    const state = afk[key];
    if (!state) continue;

    const jid = state.jid || targetJid;
    mentions.push(jid);
    notices.push(
      `💤 @${jid.split('@')[0]} is AFK\n` +
      `📝 ${state.reason || 'AFK'}\n` +
      `⏱ ${formatDuration(Date.now() - Number(state.since || Date.now()))}`
    );
  }

  if (changed) saveAfk(afk);

  if (notices.length) {
    await sock.sendMessage(
      chatId,
      {
        text: notices.join('\n\n'),
        mentions,
      },
      { quoted: msg }
    );
  }
}

module.exports = {
  afkCommand,
  handleAfkMessage,
};
