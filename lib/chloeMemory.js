// chloeMemory.js
// Per-chat persistence: whether .chaton is active for a chat (chat-wide),
// and — per sender within that chat — a rolling window of recent messages
// so Chloe's replies stay context-aware to THAT PERSON specifically.
//
// In a group chat, different members talking to Chloe are separate
// conversations from her point of view; one member's messages should never
// bleed into what she "remembers" saying to someone else in the same chat.
// Swap this for a real DB later without changing the calling code's shape.

const fs = require('fs');
const dataPath = require('./dataPath');

const STORE_PATH = dataPath('chloeStore.json');
const MAX_HISTORY_PER_THREAD = 20; // messages kept per sender per chat, oldest trimmed first

function ensureStore() {
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({ chats: {} }, null, 2));
  }
}

function loadStore() {
  ensureStore();
  const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));

  // Migrate any old flat-history chats (pre per-sender format) into an
  // empty threads map so old data doesn't crash new code. The old shared
  // history is dropped rather than guessed-assigned to one sender.
  for (const chatId of Object.keys(store.chats || {})) {
    const chat = store.chats[chatId];
    if (!chat.threads) {
      chat.threads = {};
      delete chat.history;
    }
  }

  return store;
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function getChat(store, chatId) {
  if (!store.chats[chatId]) {
    store.chats[chatId] = { active: false, threads: {} };
  }
  return store.chats[chatId];
}

function getThread(store, chatId, senderId) {
  const chat = getChat(store, chatId);
  if (!chat.threads[senderId]) {
    chat.threads[senderId] = { history: [] };
  }
  return chat.threads[senderId];
}

function setActive(chatId, active) {
  const store = loadStore();
  getChat(store, chatId).active = active;
  saveStore(store);
}

function isActive(chatId) {
  const store = loadStore();
  return getChat(store, chatId).active === true;
}

/**
 * @param {string} chatId - the chat (group or DM)
 * @param {string} senderId - the specific person this message thread belongs to
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {string|null} senderName
 */
function appendMessage(chatId, senderId, role, content, senderName) {
  const store = loadStore();
  const thread = getThread(store, chatId, senderId);

  thread.history.push({
    role,               // 'user' | 'assistant'
    content,
    senderName: senderName || null,
    ts: Date.now(),
  });

  if (thread.history.length > MAX_HISTORY_PER_THREAD) {
    thread.history = thread.history.slice(thread.history.length - MAX_HISTORY_PER_THREAD);
  }

  saveStore(store);
}

function getHistory(chatId, senderId) {
  const store = loadStore();
  return getThread(store, chatId, senderId).history;
}

module.exports = {
  setActive,
  isActive,
  appendMessage,
  getHistory,
};