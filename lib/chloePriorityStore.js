"use strict";

const fs = require("fs");
const path = require("path");
const dataPath = require("./dataPath");
const { normalizeAliases, primaryIdentity } = require("./characterRegistry");

const STORE_PATH = dataPath("chloePriorities.json");
const VERSION = 1;
const MAX_UPSERTS_PER_TURN = 8;
const MAX_KEYS_PER_OPERATION = 12;
const MAX_CONTEXT_ITEMS = 36;
const RECENT_COMPLETION_MS = 3 * 24 * 60 * 60 * 1000;

const CATEGORIES = new Set([
    "relationship", "family", "home", "routine", "commitment",
    "preference", "work", "health", "other"
]);
const PRIORITY_LEVELS = new Set(["high", "normal", "low"]);
const STATUSES = new Set(["active", "in_progress", "completed", "superseded"]);

function emptyStore() {
    return { version: VERSION, profiles: {} };
}

function loadStore() {
    if (!fs.existsSync(STORE_PATH)) return emptyStore();

    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Chloe priority-memory store has an invalid shape.");
    }

    parsed.version = VERSION;
    if (!parsed.profiles || typeof parsed.profiles !== "object" ||
        Array.isArray(parsed.profiles)) {
        parsed.profiles = {};
    }
    return parsed;
}

function saveStore(store) {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const temp = STORE_PATH + "." + process.pid + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(store, null, 2) + "\n", {
        mode: 0o600
    });
    fs.renameSync(temp, STORE_PATH);
    fs.chmodSync(STORE_PATH, 0o600);
}

function cleanText(value, max = 600) {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeKey(value) {
    return cleanText(String(value || ""), 100)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[.-]+|[.-]+$/g, "");
}

function itemOrder(left, right) {
    const statusRank = item => item.status === "active" || item.status === "in_progress" ? 0 : 1;
    const priorityRank = item => item.priority === "high" ? 0 : item.priority === "normal" ? 1 : 2;
    return statusRank(left) - statusRank(right) ||
        priorityRank(left) - priorityRank(right) ||
        Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
}

function mergeProfiles(store, aliases, create = false) {
    const ids = normalizeAliases(aliases);
    if (!ids.length) {
        if (create) throw new Error("No WhatsApp identity available for Chloe priority memory.");
        return null;
    }

    const profiles = store.profiles;
    const requested = new Set(ids);
    const matchingKeys = Object.keys(profiles).filter(key => {
        const profileAliases = normalizeAliases(profiles[key]?.aliases || [key]);
        return profileAliases.some(alias => requested.has(alias));
    });

    if (!matchingKeys.length) {
        if (!create) return null;
        const key = primaryIdentity(ids) || ids[0];
        profiles[key] = { aliases: ids, items: {} };
        return { key, profile: profiles[key], created: true, changed: true };
    }

    const key = matchingKeys[0];
    const profile = profiles[key] && typeof profiles[key] === "object"
        ? profiles[key]
        : { aliases: [], items: {} };
    let changed = matchingKeys.length > 1;
    const previousAliases = JSON.stringify(normalizeAliases(
        Array.isArray(profile.aliases) ? profile.aliases : [key]
    ));

    profile.aliases = normalizeAliases([
        ...(Array.isArray(profile.aliases) ? profile.aliases : []),
        ...ids
    ]);
    if (JSON.stringify(profile.aliases) !== previousAliases) changed = true;
    profile.items = profile.items && typeof profile.items === "object" &&
        !Array.isArray(profile.items) ? profile.items : {};

    for (const otherKey of matchingKeys.slice(1)) {
        const other = profiles[otherKey];
        profile.aliases = normalizeAliases([
            ...profile.aliases,
            ...(Array.isArray(other?.aliases) ? other.aliases : [otherKey])
        ]);
        for (const [itemKey, candidate] of Object.entries(other?.items || {})) {
            const existing = profile.items[itemKey];
            if (!existing || Number(candidate?.updatedAt || 0) > Number(existing?.updatedAt || 0)) {
                profile.items[itemKey] = candidate;
            }
        }
        delete profiles[otherKey];
        changed = true;
    }

    profiles[key] = profile;
    return { key, profile, created: false, changed };
}

function getPriorities(aliases, options = {}) {
    const store = loadStore();
    const resolved = mergeProfiles(store, aliases, false);
    if (!resolved) return [];
    if (resolved.changed) saveStore(store);

    const includeCompleted = options.includeCompleted !== false;
    return Object.values(resolved.profile.items)
        .filter(item => item && (includeCompleted ||
            (item.status !== "completed" && item.status !== "superseded")))
        .map(item => ({ ...item }))
        .sort(itemOrder);
}

function sanitizeUpsert(candidate, existing, now) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;

    const key = normalizeKey(candidate.key);
    const category = cleanText(candidate.category, 32).toLowerCase();
    const title = cleanText(candidate.title, 100);
    const details = cleanText(candidate.details, 600);
    if (!key || !CATEGORIES.has(category) || !title || !details) return null;

    const priority = PRIORITY_LEVELS.has(String(candidate.priority || "").toLowerCase())
        ? String(candidate.priority).toLowerCase()
        : (existing?.priority || "normal");
    const status = STATUSES.has(String(candidate.status || "").toLowerCase())
        ? String(candidate.status).toLowerCase()
        : (existing?.status && existing.status !== "completed" ? existing.status : "active");

    const next = {
        key,
        category,
        title,
        details,
        priority,
        status,
        createdAt: Number(existing?.createdAt || now),
        updatedAt: now
    };

    const recurrence = cleanText(candidate.recurrence, 120);
    const dueAt = cleanText(candidate.dueAt, 80);
    if (recurrence) next.recurrence = recurrence;
    else if (existing?.recurrence) next.recurrence = existing.recurrence;
    if (dueAt) next.dueAt = dueAt;
    else if (existing?.dueAt) next.dueAt = existing.dueAt;

    if (status === "completed") next.completedAt = Number(existing?.completedAt || now);
    else if (existing?.completedAt && status !== "active" && status !== "in_progress") {
        next.completedAt = existing.completedAt;
    }

    return next;
}

function applyUpdate(aliases, update, now = Date.now()) {
    if (!update || typeof update !== "object" || Array.isArray(update)) {
        return { changed: false, upserted: 0, completed: 0, removed: 0 };
    }

    const upserts = Array.isArray(update.upserts)
        ? update.upserts.slice(0, MAX_UPSERTS_PER_TURN) : [];
    const completedKeys = Array.isArray(update.complete)
        ? update.complete.slice(0, MAX_KEYS_PER_OPERATION).map(normalizeKey).filter(Boolean) : [];
    const removeKeys = Array.isArray(update.remove)
        ? update.remove.slice(0, MAX_KEYS_PER_OPERATION).map(normalizeKey).filter(Boolean) : [];

    if (!upserts.length && !completedKeys.length && !removeKeys.length) {
        return { changed: false, upserted: 0, completed: 0, removed: 0 };
    }

    const store = loadStore();
    const resolved = mergeProfiles(store, aliases, true);
    const { profile } = resolved;
    const counts = { changed: false, upserted: 0, completed: 0, removed: 0 };

    for (const candidate of upserts) {
        const key = normalizeKey(candidate?.key);
        const existing = profile.items[key];
        const item = sanitizeUpsert(candidate, existing, now);
        if (!item) continue;
        profile.items[key] = item;
        counts.upserted += 1;
    }

    for (const key of completedKeys) {
        const item = profile.items[key];
        if (!item || item.status === "completed") continue;
        item.status = "completed";
        item.updatedAt = now;
        item.completedAt = now;
        counts.completed += 1;
    }

    for (const key of removeKeys) {
        if (!Object.prototype.hasOwnProperty.call(profile.items, key)) continue;
        delete profile.items[key];
        counts.removed += 1;
    }

    counts.changed = Boolean(counts.upserted || counts.completed || counts.removed || resolved.changed);
    if (counts.changed) saveStore(store);
    return counts;
}

function buildPriorityContext(aliases, now = Date.now()) {
    const priorities = getPriorities(aliases, { includeCompleted: true })
        .filter(item => {
            if (item.status === "active" || item.status === "in_progress") return true;
            return item.status === "completed" &&
                now - Number(item.completedAt || item.updatedAt || 0) <= RECENT_COMPLETION_MS;
        })
        .sort((left, right) => {
            const leftActive = left.status === "completed" ? 1 : 0;
            const rightActive = right.status === "completed" ? 1 : 0;
            return leftActive - rightActive || itemOrder(left, right);
        })
        .slice(0, MAX_CONTEXT_ITEMS);

    if (!priorities.length) return "";

    const lines = [
        "SAVED CHLOE PRIORITIES — THIS SENDER'S ESTABLISHED ROLEPLAY CONTINUITY:",
        "These are stored facts and ongoing commitments for the current sender only. Use them when relevant; do not repeat them mechanically."
    ];

    for (const item of priorities) {
        const due = item.dueAt ? " due=" + JSON.stringify(item.dueAt) : "";
        const recurrence = item.recurrence ? " recurrence=" + JSON.stringify(item.recurrence) : "";
        lines.push(
            "- [" + item.status + "; " + item.priority + "; " + item.category +
            "; key=" + item.key + "] " + item.title + ": " +
            JSON.stringify(item.details) + due + recurrence
        );
    }

    return lines.join("\n");
}

function extractPriorityUpdate(rawReply) {
    const source = String(rawReply || "");
    const lines = source.split(/\r?\n/);
    const markerIndex = lines.findIndex(line =>
        /^\s*\[priority_memory:.*\]\s*$/i.test(line)
    );
    if (markerIndex < 0) return { reply: source, update: null };

    const markerLine = lines[markerIndex];
    const marker = markerLine.match(
        /^\s*\[priority_memory:\s*(\{.*\})\s*\]\s*$/i
    );
    // The marker must be on its own line. Remove malformed markers too so
    // internal protocol text can never accidentally be sent to WhatsApp.
    lines.splice(markerIndex, 1);
    const reply = lines.join("\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    if (!marker) return { reply, update: null };

    try {
        // Greedy matching is safe here because the protocol occupies one
        // physical line; it preserves nested JSON objects and arrays.
        const parsed = JSON.parse(marker[1]);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { reply, update: null };
        }
        return { reply, update: parsed };
    } catch {
        return { reply, update: null };
    }
}

module.exports = {
    STORE_PATH,
    getPriorities,
    applyUpdate,
    buildPriorityContext,
    extractPriorityUpdate
};
