"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STORE_VERSION = 1;
const MAX_CHATS = 200;
const MAX_MESSAGES_PER_CHAT = 200;
const MAX_MESSAGE_CHARS = 50000;
const MAX_TOTAL_CHARS = 1_500_000;

function accountKey(subject) {
    return crypto.createHash("sha256").update(String(subject)).digest("hex");
}

function boundedText(value, maximum, field, required = false) {
    if (typeof value !== "string") {
        if (required) throw Object.assign(new Error(field + " must be text."), { statusCode: 400 });
        return "";
    }
    const text = value.trim();
    if (required && !text) {
        throw Object.assign(new Error(field + " cannot be empty."), { statusCode: 400 });
    }
    if (text.length > maximum) {
        throw Object.assign(new Error(field + " is too long."), { statusCode: 400 });
    }
    return text;
}

function safeTimestamp(value, fallback) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizeChats(input, now = Date.now()) {
    if (!Array.isArray(input)) {
        throw Object.assign(new Error("Chats must be an array."), { statusCode: 400 });
    }
    if (input.length > MAX_CHATS) {
        throw Object.assign(new Error("A maximum of " + MAX_CHATS + " conversations can be saved."), { statusCode: 400 });
    }

    let totalCharacters = 0;
    const seen = new Set();
    const chats = input.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw Object.assign(new Error("Conversation " + (index + 1) + " is invalid."), { statusCode: 400 });
        }
        const id = boundedText(entry.id, 100, "Conversation ID", true);
        if (!/^[A-Za-z0-9._:-]+$/.test(id) || seen.has(id)) {
            throw Object.assign(new Error("Conversation IDs must be unique and use safe characters."), { statusCode: 400 });
        }
        seen.add(id);

        if (!Array.isArray(entry.messages) || entry.messages.length > MAX_MESSAGES_PER_CHAT) {
            throw Object.assign(new Error("Each conversation must contain no more than " + MAX_MESSAGES_PER_CHAT + " messages."), { statusCode: 400 });
        }

        const messages = entry.messages.map((message, messageIndex) => {
            if (!message || typeof message !== "object" || Array.isArray(message) ||
                !["user", "ari"].includes(message.role)) {
                throw Object.assign(new Error("A message in conversation " + id + " is invalid."), { statusCode: 400 });
            }
            const text = boundedText(message.text, MAX_MESSAGE_CHARS, "Message text", true);
            totalCharacters += text.length;
            if (totalCharacters > MAX_TOTAL_CHARS) {
                throw Object.assign(new Error("Conversation history is too large to save in one request."), { statusCode: 413 });
            }
            const normalized = {
                role: message.role,
                text,
                createdAt: safeTimestamp(message.createdAt, now)
            };
            if (typeof message.imageName === "string" && message.imageName.trim()) {
                normalized.imageName = boundedText(message.imageName, 255, "Image name");
            }
            if (message.role === "user" && ["mini", "medium", "max", "ultra"].includes(message.tier)) {
                normalized.tier = message.tier;
            }
            return normalized;
        });

        const createdAt = safeTimestamp(entry.createdAt, now);
        const updatedAt = safeTimestamp(entry.updatedAt, createdAt);
        return {
            id,
            title: boundedText(entry.title || "New chat", 120, "Conversation title") || "New chat",
            messages,
            createdAt,
            updatedAt,
            pinned: entry.pinned === true
        };
    });

    return chats.sort((a, b) => b.updatedAt - a.updatedAt);
}

function createAriWorkspaceStore(options = {}) {
    const fsImpl = options.fs || fs;
    const now = options.now || (() => Date.now());
    const directory = path.resolve(options.dataDir || path.join(__dirname, "..", "data"));
    const filePath = path.join(directory, "ariWorkspace.json");
    let queue = Promise.resolve();

    function readStore() {
        try {
            const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
            if (parsed && parsed.version === STORE_VERSION && parsed.accounts &&
                typeof parsed.accounts === "object" && !Array.isArray(parsed.accounts)) {
                return parsed;
            }
            throw new Error("Unsupported workspace data format.");
        } catch (error) {
            if (error.code === "ENOENT") return { version: STORE_VERSION, accounts: {} };
            throw new Error("Ari workspace data could not be read safely.");
        }
    }

    function writeStore(store) {
        fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporary = path.join(directory, ".ariWorkspace-" + process.pid + "-" +
            crypto.randomBytes(8).toString("hex") + ".tmp");
        try {
            fsImpl.writeFileSync(temporary, JSON.stringify(store), {
                encoding: "utf8", mode: 0o600, flag: "wx"
            });
            fsImpl.renameSync(temporary, filePath);
            try { fsImpl.chmodSync(filePath, 0o600); } catch { /* Windows ACLs replace POSIX mode bits. */ }
        } catch (_) {
            try { fsImpl.rmSync(temporary, { force: true }); } catch { /* Ignore cleanup errors. */ }
            throw new Error("Ari workspace data could not be saved safely.");
        }
    }

    function getChats(subject) {
        if (typeof subject !== "string" || !subject.trim()) {
            throw Object.assign(new Error("A signed-in account is required."), { statusCode: 401 });
        }
        const store = readStore();
        const account = store.accounts[accountKey(subject)];
        return account && Array.isArray(account.chats) ? account.chats : [];
    }

    function replaceChats(subject, input) {
        if (typeof subject !== "string" || !subject.trim()) {
            return Promise.reject(Object.assign(new Error("A signed-in account is required."), { statusCode: 401 }));
        }
        const operation = queue.then(() => {
            const chats = normalizeChats(input, now());
            const store = readStore();
            const key = accountKey(subject);
            const account = store.accounts[key] && typeof store.accounts[key] === "object"
                ? store.accounts[key]
                : {};
            store.accounts[key] = {
                ...account,
                chats,
                chatsUpdatedAt: now()
            };
            writeStore(store);
            return chats;
        });
        queue = operation.catch(() => undefined);
        return operation;
    }

    return { getChats, replaceChats, filePath, directory };
}

module.exports = {
    createAriWorkspaceStore,
    normalizeChats,
    MAX_CHATS,
    MAX_MESSAGES_PER_CHAT,
    MAX_MESSAGE_CHARS,
    MAX_TOTAL_CHARS
};
