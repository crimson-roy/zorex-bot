'use strict';

const fs = require('fs');
const dataPath = require('../lib/dataPath');
const { MAIN_OWNER } = require('../config');

const SETTINGS_FILE = dataPath('groupGreetings.json');
const OWNERS_FILE = dataPath('owners.json');

function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  const [left, server] = jid.toLowerCase().split('@');
  if (!server) return jid.toLowerCase();
  return `${left.split(':')[0]}@${server}`;
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      return fallback;
    }

    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed ?? fallback;
  } catch (err) {
    console.error(`[greetings] Failed reading ${file}:`, err);
    return fallback;
  }
}

function loadSettings() {
  const data = loadJson(SETTINGS_FILE, {});
  return data && typeof data === 'object' ? data : {};
}

function saveSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function isOwner(userId) {
  const target = normalizeJid(userId);

  if (MAIN_OWNER && normalizeJid(MAIN_OWNER) === target) {
    return true;
  }

  const owners = loadJson(OWNERS_FILE, []);
  return Array.isArray(owners) && owners.some(owner => normalizeJid(owner) === target);
}

async function isAdmin(sock, groupId, userId) {
  try {
    const metadata = await sock.groupMetadata(groupId);
    const target = normalizeJid(userId);

    const participant = metadata.participants.find(p => {
      const ids = [p.id, p.lid, p.phoneNumber].filter(Boolean).map(normalizeJid);
      return ids.includes(target);
    });

    return !!participant && (
      participant.admin === 'admin' ||
      participant.admin === 'superadmin'
    );
  } catch {
    return false;
  }
}

async function canConfigure(sock, msg) {
  const groupId = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;

  return isOwner(sender) || await isAdmin(sock, groupId, sender);
}

function renderTemplate(template, participant, groupName, count) {
  const tag = `@${String(participant).split('@')[0]}`;

  return String(template)
    .replace(/@user/gi, tag)
    .replace(/\{group\}/gi, groupName || 'this group')
    .replace(/\{count\}/gi, String(count ?? ''));
}

async function configureGreeting(sock, msg, text, type) {
  const groupId = msg.key.remoteJid;
  const command = type === 'welcome' ? '.setwelcome' : '.setleave';
  const label = type === 'welcome' ? 'welcome' : 'leave';

  if (!groupId?.endsWith('@g.us')) {
    return sock.sendMessage(
      groupId,
      { text: '❌ This command only works in groups.' },
      { quoted: msg }
    );
  }

  if (!(await canConfigure(sock, msg))) {
    return sock.sendMessage(
      groupId,
      { text: '❌ Only the owner or group admins can use this command.' },
      { quoted: msg }
    );
  }

  const settings = loadSettings();
  settings[groupId] ||= {};

  const raw = text.slice(command.length).trim();

  if (!raw) {
    const current = settings[groupId]?.[type];

    const currentText = current?.template
      ? `\n\nCurrent: ${current.enabled === false ? 'OFF' : 'ON'}\nTemplate: ${current.template}`
      : '';

    return sock.sendMessage(
      groupId,
      {
        text:
          `⚙️ *${label.toUpperCase()} MESSAGE*\n\n` +
          `Set: ${command} <message>\n` +
          `Disable: ${command} off\n` +
          `Enable again: ${command} on\n\n` +
          'Placeholders: @user  {group}  {count}' +
          currentText,
      },
      { quoted: msg }
    );
  }

  if (raw.toLowerCase() === 'off') {
    settings[groupId][type] ||= { template: '' };
    settings[groupId][type].enabled = false;
    saveSettings(settings);

    return sock.sendMessage(
      groupId,
      { text: `✅ ${label[0].toUpperCase() + label.slice(1)} messages disabled.` },
      { quoted: msg }
    );
  }

  if (raw.toLowerCase() === 'on') {
    if (!settings[groupId]?.[type]?.template) {
      return sock.sendMessage(
        groupId,
        { text: `❌ Set a template first with *${command} <message>*.` },
        { quoted: msg }
      );
    }

    settings[groupId][type].enabled = true;
    saveSettings(settings);

    return sock.sendMessage(
      groupId,
      { text: `✅ ${label[0].toUpperCase() + label.slice(1)} messages enabled.` },
      { quoted: msg }
    );
  }

  settings[groupId][type] = {
    enabled: true,
    template: raw,
  };
  saveSettings(settings);

  return sock.sendMessage(
    groupId,
    {
      text:
        `✅ ${label[0].toUpperCase() + label.slice(1)} message saved.\n\n` +
        `Preview template:\n${raw}`,
    },
    { quoted: msg }
  );
}

async function setWelcomeCommand(sock, msg, text) {
  return configureGreeting(sock, msg, text, 'welcome');
}

async function setLeaveCommand(sock, msg, text) {
  return configureGreeting(sock, msg, text, 'leave');
}

async function handleGroupParticipantsUpdate(sock, update) {
  const groupId = update?.id;
  const participants = Array.isArray(update?.participants) ? update.participants : [];

  if (!groupId || !participants.length) return;
  if (update.action !== 'add' && update.action !== 'remove') return;

  const settings = loadSettings();
  const type = update.action === 'add' ? 'welcome' : 'leave';
  const config = settings[groupId]?.[type];

  if (!config?.enabled || !config.template) return;

  let metadata;
  try {
    metadata = await sock.groupMetadata(groupId);
  } catch (err) {
    console.error('[greetings] Failed to load group metadata:', err.message);
    return;
  }

  const groupName = metadata.subject || 'this group';
  const count = metadata.participants?.length ?? '';

  for (const participant of participants) {
    const jid = typeof participant === 'string'
      ? participant
      : participant?.id || participant?.jid;

    if (!jid) continue;

    const rendered = renderTemplate(config.template, jid, groupName, count);

    try {
      await sock.sendMessage(groupId, {
        text: rendered,
        mentions: [jid],
      });
    } catch (err) {
      console.error(`[greetings] Failed sending ${type} message:`, err.message);
    }
  }
}

module.exports = {
  setWelcomeCommand,
  setLeaveCommand,
  handleGroupParticipantsUpdate,
};
