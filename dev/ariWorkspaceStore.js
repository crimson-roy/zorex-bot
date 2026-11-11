"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STORE_VERSION = 1;
const MAX_CHATS = 200;
const MAX_PROJECTS = 100;
const MAX_MESSAGES_PER_CHAT = 200;
const MAX_MESSAGE_CHARS = 50000;
const MAX_TOTAL_CHARS = 1_500_000;
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function accountKey(subject) {
    return crypto.createHash("sha256").update(String(subject)).digest("hex");
}

function boundedText(value, maximum, field, required = false) {
    if (typeof value !== "string") {
        if (required) throw Object.assign(new Error(field + " must be text."), { statusCode: 400 });
        return "";
    }
    const text = value.trim();
    if (required && !text) throw Object.assign(new Error(field + " cannot be empty."), { statusCode: 400 });
    if (text.length > maximum) throw Object.assign(new Error(field + " is too long."), { statusCode: 400 });
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
        const projectId = entry.projectId == null ? null : boundedText(entry.projectId, 36, "Project ID", true);
        if (projectId && !PROJECT_ID_PATTERN.test(projectId)) {
            throw Object.assign(new Error("Conversation project ID is invalid."), { statusCode: 400 });
        }

        if (!Array.isArray(entry.messages) || entry.messages.length > MAX_MESSAGES_PER_CHAT) {
            throw Object.assign(new Error("Each conversation must contain no more than " + MAX_MESSAGES_PER_CHAT + " messages."), { statusCode: 400 });
        }

        const messages = entry.messages.map(message => {
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
            pinned: entry.pinned === true,
            projectId
        };
    });

    return chats.sort((a, b) => b.updatedAt - a.updatedAt);
}

function normalizeProjectInput(input, existing = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw Object.assign(new Error("Project details are invalid."), { statusCode: 400 });
    }
    const name = input.name === undefined
        ? boundedText(existing.name, 80, "Project name", true)
        : boundedText(input.name, 80, "Project name", true);
    const description = input.description === undefined
        ? (existing.description || "")
        : boundedText(input.description, 500, "Project description");
    return { name, description };
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
                typeof parsed.accounts === "object" && !Array.isArray(parsed.accounts)) return parsed;
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

    function requireSubject(subject) {
        if (typeof subject !== "string" || !subject.trim()) {
            throw Object.assign(new Error("A signed-in account is required."), { statusCode: 401 });
        }
    }

    function accountFor(store, subject) {
        return store.accounts[accountKey(subject)] || {};
    }

    function getChats(subject) {
        requireSubject(subject);
        const store = readStore();
        const account = accountFor(store, subject);
        return Array.isArray(account.chats) ? account.chats : [];
    }

    function listProjects(subject) {
        requireSubject(subject);
        const store = readStore();
        const account = accountFor(store, subject);
        return Array.isArray(account.projects)
            ? account.projects.slice().sort((a, b) => b.updatedAt - a.updatedAt)
            : [];
    }

    function replaceChats(subject, input) {
        if (typeof subject !== "string" || !subject.trim()) {
            return Promise.reject(Object.assign(new Error("A signed-in account is required."), { statusCode: 401 }));
        }
        const operation = queue.then(() => {
            const chats = normalizeChats(input, now());
            const store = readStore();
            const key = accountKey(subject);
            const account = store.accounts[key] && typeof store.accounts[key] === "object" ? store.accounts[key] : {};
            const projects = Array.isArray(account.projects) ? account.projects : [];
            const allowedProjects = new Set(projects.map(project => project.id));
            for (const chat of chats) {
                if (chat.projectId && !allowedProjects.has(chat.projectId)) {
                    throw Object.assign(new Error("A conversation refers to a project that does not exist."), { statusCode: 400 });
                }
            }
            store.accounts[key] = { ...account, chats, chatsUpdatedAt: now() };
            writeStore(store);
            return chats;
        });
        queue = operation.catch(() => undefined);
        return operation;
    }

    function createProject(subject, input) {
        if (typeof subject !== "string" || !subject.trim()) {
            return Promise.reject(Object.assign(new Error("A signed-in account is required."), { statusCode: 401 }));
        }
        const operation = queue.then(() => {
            const details = normalizeProjectInput(input);
            const store = readStore();
            const key = accountKey(subject);
            const account = store.accounts[key] && typeof store.accounts[key] === "object" ? store.accounts[key] : {};
            const projects = Array.isArray(account.projects) ? account.projects : [];
            if (projects.length >= MAX_PROJECTS) {
                throw Object.assign(new Error("A maximum of " + MAX_PROJECTS + " projects can be created."), { statusCode: 400 });
            }
            const timestamp = now();
            const project = {
                id: crypto.randomUUID(),
                name: details.name,
                description: details.description,
                createdAt: timestamp,
                updatedAt: timestamp
            };
            store.accounts[key] = { ...account, projects: [...projects, project] };
            writeStore(store);
            return project;
        });
        queue = operation.catch(() => undefined);
        return operation;
    }

    function updateProject(subject, id, input) {
        if (typeof subject !== "string" || !subject.trim()) {
            return Promise.reject(Object.assign(new Error("A signed-in account is required."), { statusCode: 401 }));
        }
        const operation = queue.then(() => {
            if (typeof id !== "string" || !PROJECT_ID_PATTERN.test(id)) {
                throw Object.assign(new Error("That project could not be found."), { statusCode: 404 });
            }
            const store = readStore();
            const key = accountKey(subject);
            const account = store.accounts[key] && typeof store.accounts[key] === "object" ? store.accounts[key] : {};
            const projects = Array.isArray(account.projects) ? account.projects : [];
            const index = projects.findIndex(project => project.id === id);
            if (index < 0) throw Object.assign(new Error("That project could not be found."), { statusCode: 404 });
            const details = normalizeProjectInput(input, projects[index]);
            const updated = { ...projects[index], ...details, updatedAt: now() };
            const nextProjects = projects.slice();
            nextProjects[index] = updated;
            store.accounts[key] = { ...account, projects: nextProjects };
            writeStore(store);
            return updated;
        });
        queue = operation.catch(() => undefined);
        return operation;
    }

    function deleteProject(subject, id) {
        if (typeof subject !== "string" || !subject.trim()) {
            return Promise.reject(Object.assign(new Error("A signed-in account is required."), { statusCode: 401 }));
        }
        const operation = queue.then(() => {
            if (typeof id !== "string" || !PROJECT_ID_PATTERN.test(id)) {
                throw Object.assign(new Error("That project could not be found."), { statusCode: 404 });
            }
            const store = readStore();
            const key = accountKey(subject);
            const account = store.accounts[key] && typeof store.accounts[key] === "object" ? store.accounts[key] : {};
            const projects = Array.isArray(account.projects) ? account.projects : [];
            const project = projects.find(item => item.id === id);
            if (!project) throw Object.assign(new Error("That project could not be found."), { statusCode: 404 });
            const chats = Array.isArray(account.chats) ? account.chats : [];
            const projectChats = chats.filter(chat => chat.projectId === id);
            const timestamp = Math.max(now(), ...projectChats.map(chat => Number(chat.updatedAt || 0) + 1));
            let unassignedChats = 0;
            const nextChats = chats.map(chat => {
                if (chat.projectId !== id) return chat;
                unassignedChats++;
                return { ...chat, projectId: null, updatedAt: timestamp };
            });
            store.accounts[key] = {
                ...account,
                projects: projects.filter(item => item.id !== id),
                chats: nextChats,
                chatsUpdatedAt: timestamp
            };
            writeStore(store);
            return { project, unassignedChats };
        });
        queue = operation.catch(() => undefined);
        return operation;
    }

    return {
        getChats,
        replaceChats,
        listProjects,
        createProject,
        updateProject,
        deleteProject,
        filePath,
        directory
    };
}

module.exports = {
    createAriWorkspaceStore,
    normalizeChats,
    MAX_CHATS,
    MAX_PROJECTS,
    MAX_MESSAGES_PER_CHAT,
    MAX_MESSAGE_CHARS,
    MAX_TOTAL_CHARS
};
