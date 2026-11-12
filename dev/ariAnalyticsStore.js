"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function accountKey(subject) {
    return crypto.createHash("sha256").update(String(subject)).digest("hex");
}

function createAriAnalyticsStore(options = {}) {
    const fsImpl = options.fs || fs;
    const now = options.now || (() => Date.now());
    const directory = path.resolve(options.dataDir || path.join(__dirname, "..", "data"));
    const filePath = path.join(directory, "ariAnalytics.json");
    let queue = Promise.resolve();

    function readStore() {
        try {
            const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
            if (parsed && parsed.version === 1 && parsed.accounts && typeof parsed.accounts === "object" &&
                Array.isArray(parsed.feedback)) return parsed;
            throw new Error("Unsupported Ari analytics data format.");
        } catch (error) {
            if (error.code === "ENOENT") return { version: 1, accounts: {}, feedback: [] };
            throw new Error("Ari analytics data could not be read safely.");
        }
    }

    function writeStore(store) {
        fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(8).toString("hex");
        try {
            fsImpl.writeFileSync(temporary, JSON.stringify(store), { encoding: "utf8", mode: 0o600, flag: "wx" });
            fsImpl.renameSync(temporary, filePath);
            try { fsImpl.chmodSync(filePath, 0o600); } catch { /* Windows ACLs replace POSIX mode bits. */ }
        } catch (_) {
            try { fsImpl.rmSync(temporary, { force: true }); } catch { /* Ignore cleanup errors. */ }
            throw new Error("Ari analytics data could not be saved safely.");
        }
    }

    function requireSubject(subject) {
        if (typeof subject !== "string" || !subject.trim()) {
            throw Object.assign(new Error("A signed-in account is required."), { statusCode: 401 });
        }
        return accountKey(subject);
    }

    function recordActivity(subject) {
        const key = requireSubject(subject);
        const operation = queue.then(() => {
            const store = readStore();
            const timestamp = now();
            const existing = store.accounts[key];
            store.accounts[key] = existing
                ? { firstSeenAt: existing.firstSeenAt || timestamp, lastSeenAt: timestamp }
                : { firstSeenAt: timestamp, lastSeenAt: timestamp };
            writeStore(store);
            return { firstSeenAt: store.accounts[key].firstSeenAt, lastSeenAt: timestamp };
        });
        queue = operation.catch(() => undefined);
        return operation;
    }

    function recordFeedback(subject, input) {
        const accountId = requireSubject(subject);
        if (!input || typeof input !== "object" || Array.isArray(input) ||
            !["like", "dislike"].includes(input.rating) ||
            typeof input.messageId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(input.messageId) ||
            typeof input.chatId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(input.chatId)) {
            return Promise.reject(Object.assign(new Error("Ari response feedback is invalid."), { statusCode: 400 }));
        }
        const operation = queue.then(() => {
            const store = readStore();
            const id = crypto.createHash("sha256").update(accountId + ":" + input.messageId).digest("hex");
            const timestamp = now();
            const existing = store.feedback.find(item => item.id === id);
            if (existing) {
                existing.rating = input.rating;
                existing.chatId = input.chatId;
                existing.updatedAt = timestamp;
            } else {
                store.feedback.push({
                    id,
                    accountId,
                    chatId: input.chatId,
                    rating: input.rating,
                    createdAt: timestamp,
                    updatedAt: timestamp
                });
            }
            writeStore(store);
            return { rating: input.rating, updated: Boolean(existing) };
        });
        queue = operation.catch(() => undefined);
        return operation;
    }

    function getDashboard() {
        const store = readStore();
        const timestamp = now();
        const accounts = Object.values(store.accounts);
        const countSince = windowMs => accounts.filter(item =>
            Number.isSafeInteger(item.lastSeenAt) && timestamp - item.lastSeenAt <= windowMs
        ).length;
        const likes = store.feedback.filter(item => item.rating === "like").length;
        const dislikes = store.feedback.filter(item => item.rating === "dislike").length;
        const total = likes + dislikes;
        return {
            accounts: {
                registered: accounts.length,
                activeNow: countSince(5 * 60 * 1000),
                active24h: countSince(24 * 60 * 60 * 1000),
                active7d: countSince(7 * 24 * 60 * 60 * 1000),
                active30d: countSince(30 * 24 * 60 * 60 * 1000)
            },
            responses: {
                totalRatings: total,
                likes,
                dislikes,
                likeRate: total ? Number((likes / total * 100).toFixed(1)) : 0,
                dislikeRate: total ? Number((dislikes / total * 100).toFixed(1)) : 0
            },
            generatedAt: timestamp
        };
    }

    return { recordActivity, recordFeedback, getDashboard, filePath };
}

module.exports = { createAriAnalyticsStore };
