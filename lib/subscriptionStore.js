"use strict";

const fs = require("fs");
const path = require("path");
const dataPath = require("./dataPath");
const { normalizeAliases } = require("./characterRegistry");

const STORE_PATH = dataPath("subscriptions.json");
const PLANS = new Set(["free", "standard", "pro", "ultra"]);

function readStore() {
    if (!fs.existsSync(STORE_PATH)) return { users: {} };

    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Subscription store has an invalid shape.");
    }
    if (!parsed.users || typeof parsed.users !== "object") {
        parsed.users = {};
    }
    return parsed;
}

function writeStore(store) {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });

    const temp = STORE_PATH + "." + process.pid + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(store, null, 2) + "\n", {
        mode: 0o600
    });
    fs.renameSync(temp, STORE_PATH);
    fs.chmodSync(STORE_PATH, 0o600);
}

function getSubscription(aliases, now = Date.now()) {
    const store = readStore();

    for (const id of normalizeAliases(aliases)) {
        const record = store.users[id];
        if (!record || record.status !== "active") continue;

        const plan = String(record.plan || "").toLowerCase();
        const expiry = record.expiresAt == null
            ? null
            : Number(new Date(record.expiresAt).getTime());

        if (!PLANS.has(plan) || plan === "free") continue;
        if (expiry !== null && (!Number.isFinite(expiry) || expiry <= now)) continue;

        return {
            plan,
            active: true,
            startedAt: record.startedAt || null,
            expiresAt: record.expiresAt || null,
            orderId: record.orderId || null
        };
    }

    return {
        plan: "free",
        active: false,
        startedAt: null,
        expiresAt: null,
        orderId: null
    };
}

function getWorldMemberLimit(aliases, now = Date.now()) {
    const subscription = getSubscription(aliases, now);
    return subscription.plan === "free" ? 2 : 5;
}

function setSubscription(aliases, subscription) {
    const ids = normalizeAliases(aliases);
    const plan = String(subscription?.plan || "").toLowerCase();

    if (!ids.length) throw new Error("No user identity was supplied.");
    if (!PLANS.has(plan) || plan === "free") {
        throw new Error("Only standard, pro, or ultra can be activated as paid plans.");
    }

    if (!subscription.expiresAt) {
        throw new Error("Paid subscriptions must have an explicit expiry date.");
    }

    const expiryDate = new Date(subscription.expiresAt);
    if (!Number.isFinite(expiryDate.getTime()) || expiryDate.getTime() <= Date.now()) {
        throw new Error("Paid subscription expiry must be a valid future date.");
    }
    const expiry = expiryDate.toISOString();

    const startedDate = subscription.startedAt
        ? new Date(subscription.startedAt)
        : new Date();
    if (!Number.isFinite(startedDate.getTime())) {
        throw new Error("Paid subscription start date is invalid.");
    }
    const startedAt = startedDate.toISOString();

    const store = readStore();

    for (const id of ids) {
        store.users[id] = {
            plan,
            status: "active",
            startedAt,
            expiresAt: expiry,
            orderId: subscription.orderId || null
        };
    }

    writeStore(store);
    return getSubscription(ids);
}

function revokeSubscription(aliases) {
    const store = readStore();
    for (const id of normalizeAliases(aliases)) {
        if (store.users[id]) {
            store.users[id].status = "revoked";
            store.users[id].revokedAt = new Date().toISOString();
        }
    }
    writeStore(store);
}

module.exports = {
    getSubscription,
    getWorldMemberLimit,
    setSubscription,
    revokeSubscription
};
