const fs = require("fs");
const dataPath = require("../lib/dataPath");

// PERSISTENCE FIX: routed through dataPath() so daily play counts survive
// a redeploy. See lib/dataPath.js.
const LIMIT_FILE = dataPath("dailylimit.json");

const DEFAULT_LIMIT = 10;
const SLOTS_LIMIT = 15;
const DICE_LIMIT = 15;
const BLACKJACK_LIMIT = 10;

function loadLimits() {

    if (!fs.existsSync(LIMIT_FILE)) {
        fs.writeFileSync(LIMIT_FILE, "{}");
    }

    return JSON.parse(
        fs.readFileSync(LIMIT_FILE, "utf8")
    );

}

function saveLimits(data) {

    fs.writeFileSync(
        LIMIT_FILE,
        JSON.stringify(data, null, 4)
    );

}

// Slots gets a higher limit, everything else uses the default
function getLimit(command) {

    if (command === "slots") {
        return SLOTS_LIMIT;
    }

    if (command === "dice") {
        return DICE_LIMIT;
    }

    if (command === "bj") {
        return BLACKJACK_LIMIT;
    }

    return DEFAULT_LIMIT;

}

// Calendar-day key, e.g. "2026-07-19" (resets at midnight server time)
function todayKey() {

    return new Date()
        .toISOString()
        .split("T")[0];

}

// Returns null if the user is still allowed to play today.
// Returns { used, limit } if they've hit the cap.
function checkDailyLimit(userId, command) {

    const limits = loadLimits();
    const key = `${command}:${userId}`;
    const entry = limits[key];
    const today = todayKey();

    if (!entry || entry.date !== today) {

        return null; // fresh day, no plays recorded yet

    }

    const limit = getLimit(command);

    if (entry.count >= limit) {

        return {
            used: entry.count,
            limit
        };

    }

    return null;

}

// Call this ONLY after a bet is accepted (mirrors setCooldown timing)
function incrementDailyPlay(userId, command) {

    const limits = loadLimits();
    const key = `${command}:${userId}`;
    const today = todayKey();

    if (!limits[key] || limits[key].date !== today) {

        limits[key] = {
            count: 0,
            date: today
        };

    }

    limits[key].count++;

    saveLimits(limits);

    return limits[key].count;

}

// Reset every daily-limit entry belonging to one user, across all commands
function resetUserDailyLimit(userId) {

    const limits = loadLimits();

    let cleared = 0;

    for (const key of Object.keys(limits)) {

        if (key.endsWith(`:${userId}`)) {

            delete limits[key];
            cleared++;

        }

    }

    saveLimits(limits);

    return cleared;

}

// Wipe every daily-limit entry for every user/command
function resetAllDailyLimits() {

    const limits = loadLimits();

    const cleared = Object.keys(limits).length;

    saveLimits({});

    return cleared;

}

// Always returns current status, capped or not — used by .mydls
function getDailyStatus(userId, command) {

    const limits = loadLimits();
    const key = `${command}:${userId}`;
    const entry = limits[key];
    const today = todayKey();
    const limit = getLimit(command);

    let used = 0;

    if (entry && entry.date === today) {
        used = entry.count;
    }

    return { used, limit };

}

module.exports = {
    checkDailyLimit,
    incrementDailyPlay,
    getLimit,
    resetUserDailyLimit,
    resetAllDailyLimits,
    getDailyStatus
};