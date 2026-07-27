/*
    tradeTimeouts.js

    Timeout Sweeper for the Zorex Bot trading system.

    Per design §9: uses a single periodic setInterval sweep rather
    than one setTimeout per entry, so pending timeouts survive a bot
    restart for free (expiresAt is an absolute persisted timestamp,
    not an in-memory timer — §8.5).

    startTradeSweeper(sock) must be called exactly once, after the
    Baileys socket is connected, from the bot's main entry file:

        const { startTradeSweeper } = require("./lib/tradeTimeouts");
        startTradeSweeper(sock);

    Calling it more than once would create duplicate intervals and
    duplicate expiry notifications — guarded against below.
*/

const tradeState = require("./tradeState");
const escrow = require("./tradeEscrow");
const messages = require("./tradeMessages");

const SWEEP_INTERVAL_MS = 10000; // §9.3

let sweepHandle = null;

async function sweepRequests(sock) {

    const requests = tradeState.loadTradeRequests();

    const now = Date.now();

    const expired = requests.filter(r => r.expiresAt <= now);

    for (const request of expired) {

        // Re-read-then-remove by id rather than trusting the array
        // snapshot above, in case another tick/command already
        // removed it (e.g. a decline that landed the same instant).
        const removed = tradeState.removeRequestById(request.requestId);

        if (!removed) continue;

        const notice = messages.requestExpiredNotice(request.initiator, request.recipient);

        try {

            await sock.sendMessage(
                request.chatJid,
                { text: notice.text, mentions: notice.mentions }
            );

        } catch (err) {

            console.error("[TRADE] Failed to send request-expired notice:", err);

        }

    }

}

async function sweepSessions(sock) {

    const trades = tradeState.loadActiveTrades();

    const now = Date.now();

    const expired = trades.filter(t => t.expiresAt <= now);

    for (const session of expired) {

        // Re-fetch fresh immediately before acting, per §8.2 — a
        // deposit could have landed (and completed the trade,
        // deleting it) in between the snapshot above and now.
        const fresh = tradeState.findSessionById(session.tradeId);

        if (!fresh) continue;

        if (fresh.expiresAt > Date.now()) {

            // Activity landed and pushed expiresAt forward since the
            // snapshot was taken — no longer stale, skip it.
            continue;

        }

        const result = escrow.releaseEscrowAndDeleteSession(tradeState, fresh);

        if (result.kind === "already_completed") {

            // §12.16 defensive path — nothing to notify beyond the
            // log already emitted inside releaseEscrowAndDeleteSession.
            continue;

        }

        const [userA, userB] = fresh.participants;

        const notice = messages.sessionTimedOut(userA, userB);

        try {

            await sock.sendMessage(
                fresh.chatJid,
                { text: notice.text, mentions: notice.mentions }
            );

        } catch (err) {

            console.error("[TRADE] Failed to send session-timeout notice:", err);

        }

    }

}

async function runSweepTick(sock) {

    try {

        await sweepRequests(sock);

    } catch (err) {

        console.error("[TRADE] Error sweeping tradeRequests.json:", err);

    }

    try {

        await sweepSessions(sock);

    } catch (err) {

        console.error("[TRADE] Error sweeping activeTrades.json:", err);

    }

}

function startTradeSweeper(sock) {

    if (sweepHandle) {

        console.warn("[TRADE] startTradeSweeper() called more than once — ignoring duplicate start.");

        return sweepHandle;

    }

    // Run one tick immediately on startup so that requests/sessions
    // which expired while the bot was offline are caught right away
    // (§8.5 point 2), rather than waiting up to SWEEP_INTERVAL_MS.
    runSweepTick(sock);

    sweepHandle = setInterval(() => runSweepTick(sock), SWEEP_INTERVAL_MS);

    return sweepHandle;

}

function stopTradeSweeper() {

    if (sweepHandle) {

        clearInterval(sweepHandle);

        sweepHandle = null;

    }

}

module.exports = {
    startTradeSweeper,
    stopTradeSweeper
};
