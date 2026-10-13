"use strict";

const fs = require("fs");
const path = require("path");
const dataPath = require("./dataPath");
const { normalizeAliases, primaryIdentity } = require("./characterRegistry");

const STORE_PATH = dataPath("companionConversations.json");
const MAX_MESSAGES = 20;

function load() {
    if (!fs.existsSync(STORE_PATH)) return { threads: {} };

    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Companion memory store has an invalid shape.");
    }
    if (!parsed.threads || typeof parsed.threads !== "object") {
        parsed.threads = {};
    }
    return parsed;
}

function save(store) {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });

    const temp = STORE_PATH + "." + process.pid + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(store, null, 2) + "\n", {
        mode: 0o600
    });
    fs.renameSync(temp, STORE_PATH);
    fs.chmodSync(STORE_PATH, 0o600);
}

function threadKey(aliases, characterId) {
    const identity = primaryIdentity(normalizeAliases(aliases));
    if (!identity) throw new Error("No companion-memory identity available.");
    return characterId + "::" + identity;
}

function getHistory(aliases, characterId) {
    const store = load();
    const thread = store.threads[threadKey(aliases, characterId)];
    return thread && Array.isArray(thread.history) ? thread.history : [];
}

function append(aliases, characterId, role, content, senderName = null) {
    if (role !== "user" && role !== "assistant") {
        throw new Error("Companion memory role must be user or assistant.");
    }

    const store = load();
    const key = threadKey(aliases, characterId);
    if (!store.threads[key]) store.threads[key] = { history: [] };

    const history = store.threads[key].history;
    history.push({
        role,
        content: String(content || "").slice(0, 2000),
        senderName: senderName || null,
        ts: Date.now()
    });

    if (history.length > MAX_MESSAGES) {
        store.threads[key].history = history.slice(-MAX_MESSAGES);
    }

    save(store);
}

module.exports = { getHistory, append };
