// chloeMemory.js
// Simple per-chat persistence: whether .chaton is active for a chat, and a
// rolling window of recent messages so Chloe's replies stay context-aware.
// Swap this for a real DB later without changing the calling code's shape.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'chloeStore.json');
const MAX_HISTORY_PER_CHAT = 20; // messages kept per chat, oldest trimmed first

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({ chats: {} }, null, 2));
  }
}

function loadStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function getChat(chatId) {
  const store = loadStore();
  if (!store.chats[chatId]) {
    store.chats[chatId] = { active: false, history: [] };
    saveStore(store);
  }
  return store.chats[chatId];
}

function setActive(chatId, active) {
  const store = loadStore();
  if (!store.chats[chatId]) store.chats[chatId] = { active: false, history: [] };
  store.chats[chatId].active = active;
  saveStore(store);
}

function isActive(chatId) {
  return getChat(chatId).active === true;
}

function appendMessage(chatId, role, content, senderName) {
  const store = loadStore();
  if (!store.chats[chatId]) store.chats[chatId] = { active: false, history: [] };
  store.chats[chatId].history.push({
    role,               // 'user' | 'assistant'
    content,
    senderName: senderName || null,
    ts: Date.now(),
  });
  const hist = store.chats[chatId].history;
  if (hist.length > MAX_HISTORY_PER_CHAT) {
    store.chats[chatId].history = hist.slice(hist.length - MAX_HISTORY_PER_CHAT);
  }
  saveStore(store);
}

function getHistory(chatId) {
  return getChat(chatId).history;
}

module.exports = {
  setActive,
  isActive,
  appendMessage,
  getHistory,
};
