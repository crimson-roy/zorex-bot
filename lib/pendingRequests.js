// lib/pendingRequests.js
//
// Short-lived in-memory store for .ai's "generate_file" confirmation step.
// When the routing call decides a prompt wants a generated file, nothing
// gets built until the user replies ".ai yes". Kept as a plain Map (not a
// DB) since these only need to survive a couple of minutes, not a restart.

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

const pending = new Map();

function keyFor(chatId, senderId) {
    return `${chatId}::${senderId}`;
}

function setPending(chatId, senderId, data) {
    const key = keyFor(chatId, senderId);
    const existing = pending.get(key);
    if (existing && existing.timeout) clearTimeout(existing.timeout);
    const timeout = setTimeout(() => pending.delete(key), PENDING_TTL_MS);
    pending.set(key, { ...data, expiresAt: Date.now() + PENDING_TTL_MS, timeout });
}

function getPending(chatId, senderId) {
    const key = keyFor(chatId, senderId);
    const entry = pending.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        pending.delete(key);
        return null;
    }
    return entry;
}

function clearPending(chatId, senderId) {
    const key = keyFor(chatId, senderId);
    const entry = pending.get(key);
    if (entry && entry.timeout) clearTimeout(entry.timeout);
    pending.delete(key);
}

module.exports = { setPending, getPending, clearPending };