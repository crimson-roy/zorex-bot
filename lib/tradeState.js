/*
    tradeState.js

    State Manager for the Zorex Bot trading system.

    Responsibilities (per design spec §1.2, §7):
      - Load/save tradeRequests.json and activeTrades.json
      - Generate unique requestId / tradeId values
      - Provide lookup helpers keyed by userId
      - Enforce "one active trade per user" at the read layer
      - Provide low-level CRUD primitives that tradeEscrow.js and
        trade.js build atomic operations on top of (§8.2)

    This module performs NO business logic (no validation, no
    messaging, no escrow mutation). It only knows how to read and
    write the two JSON files safely and how to find entries in them.
*/

const fs = require("fs");

const REQUESTS_FILE = "./tradeRequests.json";
const ACTIVE_TRADES_FILE = "./activeTrades.json";

// ---------- Low-level file I/O ----------

/*
    Generic safe loader for a JSON file that should contain an array.
    Mirrors the defensive pattern used elsewhere in the codebase
    (loadUsers/loadOwners/loadInventory) but adds try/catch around
    JSON.parse per design spec §8.7 (malformed / corrupted JSON must
    never crash the bot).
*/
function safeLoadArray(filePath, corruptionTag) {

    if (!fs.existsSync(filePath)) {

        fs.writeFileSync(
            filePath,
            JSON.stringify([], null, 4)
        );

    }

    let raw;

    try {

        raw = fs.readFileSync(filePath, "utf8");

    } catch (err) {

        console.error(
            `[TRADE-CORRUPTION] Failed to read ${filePath}:`,
            err
        );

        return [];

    }

    try {

        const parsed = JSON.parse(raw);

        if (!Array.isArray(parsed)) {

            console.error(
                `[TRADE-CORRUPTION] ${filePath} did not contain a JSON array. Treating as empty.`
            );

            return [];

        }

        return parsed;

    } catch (err) {

        console.error(
            `[TRADE-CORRUPTION] ${corruptionTag} — ${filePath} contains invalid JSON:`,
            err
        );

        // Per §8.7: do not overwrite the corrupted file on a mere read.
        // Treat as empty for this call only.
        return [];

    }

}

function safeSaveArray(filePath, data) {

    fs.writeFileSync(
        filePath,
        JSON.stringify(
            data,
            null,
            4
        )
    );

}

function loadTradeRequests() {

    return safeLoadArray(REQUESTS_FILE, "tradeRequests.json corruption");

}

function saveTradeRequests(requests) {

    safeSaveArray(REQUESTS_FILE, requests);

}

function loadActiveTrades() {

    return safeLoadArray(ACTIVE_TRADES_FILE, "activeTrades.json corruption");

}

function saveActiveTrades(trades) {

    safeSaveArray(ACTIVE_TRADES_FILE, trades);

}

// ---------- ID generation ----------

function randomToken(length) {

    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";

    let out = "";

    for (let i = 0; i < length; i++) {

        out += chars.charAt(
            Math.floor(Math.random() * chars.length)
        );

    }

    return out;

}

function generateRequestId() {

    return `req_${Date.now()}_${randomToken(6)}`;

}

function generateTradeId() {

    return `trd_${Date.now()}_${randomToken(6)}`;

}

// ---------- Lookup helpers (tradeRequests.json) ----------

/*
    Finds a pending request where the given user is either the
    initiator or the recipient. Returns the request object or null.
    Per design §12.13, callers that use this to gate an action
    (e.g. .tradeaccept) must additionally re-check request.expiresAt
    against Date.now() themselves — this function does not filter
    out expired-but-not-yet-swept entries.
*/
function findRequestByUser(userId) {

    const requests = loadTradeRequests();

    const found = requests.find(
        r => r.initiator === userId || r.recipient === userId
    );

    return found || null;

}

function findRequestById(requestId) {

    const requests = loadTradeRequests();

    const found = requests.find(
        r => r.requestId === requestId
    );

    return found || null;

}

// ---------- Lookup helpers (activeTrades.json) ----------

/*
    Finds an active session where the given user is one of the two
    original participants. Returns the session object or null.
*/
function findSessionByUser(userId) {

    const trades = loadActiveTrades();

    const found = trades.find(
        t => Array.isArray(t.participants) && t.participants.includes(userId)
    );

    return found || null;

}

function findSessionById(tradeId) {

    const trades = loadActiveTrades();

    const found = trades.find(
        t => t.tradeId === tradeId
    );

    return found || null;

}

// ---------- Combined "is this user free to start/accept a trade" check ----------

/*
    Per design §4.1 validation steps 6/7 and §10 Active Trade Rules:
    a user with ANY pending request (as initiator or recipient) OR
    ANY active session is considered "busy" and cannot start or
    accept another trade.

    Returns { busy: boolean, reason: "request" | "session" | null }
*/
function getUserTradeStatus(userId) {

    const request = findRequestByUser(userId);

    if (request) {

        return { busy: true, reason: "request", entry: request };

    }

    const session = findSessionByUser(userId);

    if (session) {

        return { busy: true, reason: "session", entry: session };

    }

    return { busy: false, reason: null, entry: null };

}

// ---------- CRUD primitives (tradeRequests.json) ----------

/*
    Appends a new request object to tradeRequests.json.
    Caller is responsible for having already validated that neither
    participant is currently busy (§8.2 step 1-2: read fresh, validate,
    then mutate/write — this function IS the mutate+write step and must
    be called immediately after a fresh validation with no awaited work
    in between).
*/
function addRequest(request) {

    const requests = loadTradeRequests();

    requests.push(request);

    saveTradeRequests(requests);

    return request;

}

/*
    Removes a request by requestId. Safe to call even if the id is
    not present (no-op), which keeps callers idempotent per §8.3.
*/
function removeRequestById(requestId) {

    const requests = loadTradeRequests();

    const next = requests.filter(
        r => r.requestId !== requestId
    );

    saveTradeRequests(next);

    return next.length !== requests.length;

}

// ---------- CRUD primitives (activeTrades.json) ----------

function addSession(session) {

    const trades = loadActiveTrades();

    trades.push(session);

    saveActiveTrades(trades);

    return session;

}

function removeSessionById(tradeId) {

    const trades = loadActiveTrades();

    const next = trades.filter(
        t => t.tradeId !== tradeId
    );

    saveActiveTrades(next);

    return next.length !== trades.length;

}

/*
    Reads activeTrades.json fresh, applies `mutatorFn` to the entry
    matching tradeId (mutatorFn receives the live session object and
    must mutate it in place — return value is ignored), then writes
    the whole array back in one synchronous write.

    This is the primitive tradeEscrow.js uses to implement deposit /
    complete / cancel / timeout-return atomically per §8.2: the read,
    the mutation, and the write all happen within this single
    synchronous function call with no awaited work interleaved.

    Returns the mutated session object, or null if tradeId was not
    found (caller must treat this as "trade no longer exists" —
    e.g. it may have just been completed or timed out by a
    concurrent handler tick).
*/
function mutateSession(tradeId, mutatorFn) {

    const trades = loadActiveTrades();

    const index = trades.findIndex(
        t => t.tradeId === tradeId
    );

    if (index === -1) {

        return null;

    }

    mutatorFn(trades[index]);

    saveActiveTrades(trades);

    return trades[index];

}

module.exports = {
    loadTradeRequests,
    saveTradeRequests,
    loadActiveTrades,
    saveActiveTrades,
    generateRequestId,
    generateTradeId,
    findRequestByUser,
    findRequestById,
    findSessionByUser,
    findSessionById,
    getUserTradeStatus,
    addRequest,
    removeRequestById,
    addSession,
    removeSessionById,
    mutateSession
};
