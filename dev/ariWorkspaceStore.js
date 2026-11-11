"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_CHATS_PER_ACCOUNT = 200;
const MAX_MESSAGES_PER_CHAT = 300;
const MAX_MESSAGE_CHARACTERS = 12_000;
const MAX_CHAT_CHARACTERS = 600_000;
const MAX_ACCOUNT_STORE_BYTES = 8 * 1024 * 1024;

function createAriWorkspaceStore(options = {}) {
    const fsImpl = options.fs || fs;
    const now = options.now || (() => Date.now());
    const storageDir = path.resolve(options.dataDir || path.join(__dirname, "..", "data"), "ariWorkspace");
    let queue = Promise.resolve();

    function accountKey(subject) {
        if (typeof subject !== "string" || !subject.trim() || subject.length > 512) {
            throw new Error("A valid Ari account is required.");
        }
        return crypto.createHash("sha256").update(subject).digest("hex");
    }

    function filePathFor(subject) {
        return path.join(storageDir, accountKey(subject) + ".json");
    }

    function readStore(filePath) {
        try {
            const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
            if (parsed && parsed.version === 1 && Array.isArray(parsed.chats)) return parsed;
            throw new Error("Unsupported store format.");
        } catch (error) {
            if (error.code === "ENOENT") return { version: 1, chats: [] };
            throw new Error("Ari workspace data could not be read safely.");
        }
    }

    function writeStore(filePath, store) {
        const serialized = JSON.stringify(store);
        if (Buffer.byteLength(serialized, "utf8") > MAX_ACCOUNT_STORE_BYTES) {
            throw Object.assign(new Error("This account's saved conversations have reached the current storage limit."), { statusCode: 413 });
        }
        fsImpl.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
        const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(8).toString("hex");
        try {
            fsImpl.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
            fsImpl.renameSync(temporary, filePath);
            try { fsImpl.chmodSync(filePath, 0o600); } catch { /* Windows ACLs replace POSIX mode bits. */ }
        } catch (error) {
            try { fsImpl.rmSync(temporary, { force: true }); } catch { /* Ignore cleanup errors. */ }
            throw new Error("Ari workspace data could not be saved safely.");
        }
    }

    function normalizeMessage(message) {
        if (!message || typeof message !== "object" || Array.isArray(message) ||
            !["user", "ari"].includes(message.role) ||
            typeof message.text !== "string" ||
            !message.text.trim() ||
            message.text.length > MAX_MESSAGE_CHARACTERS) {
            throw Object.assign(new Error("A chat contains an invalid message."), { statusCode: 400 });
        }
        const normalized = {
            role: message.role,
            text: message.text,
            createdAt: Number.isSafeInteger(message.createdAt) && message.createdAt > 0 ? message.createdAt : now()
        };
        if (typeof message.imageName === "string" && message.imageName.trim()) {
            normalized.imageName = message.imageName.trim().slice(0, 255);
        }
        if (["mini", "medium", "max", "ultra"].includes(message.tier)) normalized.tier = message.tier;
        return normalized;
    }

    function normalizeChat(chat) {
        if (!chat || typeof chat !== "object" || Array.isArray(chat) ||
            typeof chat.id !== "string" ||
            !/^[A-Za-z0-9_-]{8,100}$/.test(chat.id) ||
            !Array.isArray(chat.messages) ||
            chat.messages.length > MAX_MESSAGES_PER_CHAT) {
            throw Object.assign(new Error("A conversation has an invalid format."), { statusCode: 400 });
        }

        const messages = chat.messages.map(normalizeMessage);
        const characterCount = messages.reduce((total, message) => total + message.text.length, 0);
        if (characterCount > MAX_CHAT_CHARACTERS) {
            throw Object.assign(new Error("A conversation is too large to save."), { statusCode: 413 });
        }
        const title = typeof chat.title === "string" && chat.title.trim()
            ? chat.title.trim().slice(0, 120)
            : "New chat";
        const createdAt = Number.isSafeInteger(chat.createdAt) && chat.createdAt > 0 ? chat.createdAt : now();
        const updatedAt = Number.isSafeInteger(chat.updatedAt) && chat.updatedAt > 0 ? chat.updatedAt : createdAt;

        return {
            id: chat.id,
            title,
            pinned: chat.pinned === true,
            createdAt,
            updatedAt,
            messages
        };
    }

    function enqueue(operation) {
        const result = queue.then(operation);
        queue = result.catch(() => undefined);
        return result;
    }

    function sortChats(chats) {
        return chats.slice().sort((a, b) =>
            Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
            (b.updatedAt || 0) - (a.updatedAt || 0)
        );
    }

    function listChats(subject) {
        const filePath = filePathFor(subject);
        return enqueue(() => JSON.parse(JSON.stringify(sortChats(readStore(filePath).chats))));
    }

    function replaceChats(subject, suppliedChats) {
        const filePath = filePathFor(subject);
        return enqueue(() => {
            if (!Array.isArray(suppliedChats) || suppliedChats.length > MAX_CHATS_PER_ACCOUNT) {
                throw Object.assign(new Error("The chat list is invalid or exceeds the current account limit."), { statusCode: 400 });
            }
            const chats = suppliedChats.map(normalizeChat);
            const identifiers = new Set();
            for (const chat of chats) {
                if (identifiers.has(chat.id)) {
                    throw Object.assign(new Error("The chat list contains duplicate conversation IDs."), { statusCode: 400 });
                }
                identifiers.add(chat.id);
            }
            if (!chats.length) {
                try { fsImpl.rmSync(filePath, { force: true }); } catch {
                    throw new Error("Ari workspace data could not be cleared safely.");
                }
                return [];
            }
            writeStore(filePath, { version: 1, chats });
            return JSON.parse(JSON.stringify(sortChats(chats)));
        });
    }

    return {
        listChats,
        replaceChats,
        filePathFor,
        limits: {
            maxChatsPerAccount: MAX_CHATS_PER_ACCOUNT,
            maxMessagesPerChat: MAX_MESSAGES_PER_CHAT,
            maxMessageCharacters: MAX_MESSAGE_CHARACTERS,
            maxAccountStoreBytes: MAX_ACCOUNT_STORE_BYTES
        }
    };
}

module.exports = { createAriWorkspaceStore };
