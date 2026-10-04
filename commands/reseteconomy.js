const fs = require("fs");
const dataPath = require("../lib/dataPath");
const { MAIN_OWNER } = require("../config");
const { saveInventory } = require("./inventory");
const {
    loadPortfolioHistory,
    savePortfolioHistory
} = require("../lib/portfolioHistory");
const { tierForLevel } = require("../lib/tierStar");
const {
    loadMajorsState,
    saveMajorsState
} = require("../lib/majorsState");
const { getMajor } = require("../lib/majors");

const USERS_FILE = dataPath("users.json");

// Pending confirmations.
// Only the MAIN_OWNER can create/confirm/cancel this reset.
let resetPending = false;
let resetRequestedBy = null;

// --------------------------------------------------
// LOAD USERS
// --------------------------------------------------

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        return {};
    }

    try {
        return JSON.parse(
            fs.readFileSync(USERS_FILE, "utf8")
        );
    } catch (err) {
        throw new Error(
            `Could not read users.json: ${err.message}`
        );
    }
}

// --------------------------------------------------
// SAVE USERS
// --------------------------------------------------

function saveUsers(users) {
    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify(users, null, 4),
        "utf8"
    );
}

// --------------------------------------------------
// RESET ONE USER
// --------------------------------------------------

function resetUser(user) {

    // Preserve registration/profile information.
    //
    // Everything below is economy/progression data
    // and is returned to its initial state.

    const resetUser = {
        name: user.name,
        age: user.age,
        bio: user.bio,
        role: user.role,
        guild: "None",

        level: 1,
        rank: "Beginner",

        wallet: 500000,
        bank: 0,

        // Keep the existing bankLimit because we don't
        // currently know your original registration value.
        bankLimit: user.bankLimit,

        games: 0,
        wins: 0,
        losses: 0,

        lastDaily: 0,
        dailyStreak: 0
    };

    // IMPORTANT:
    //
    // We deliberately DO NOT copy:
    //
    // company
    // inventory
    //
    // Therefore they are completely removed. (`company` lives inline on
    // the user object and is dropped just by not copying it forward —
    // that also takes its `offers`/`employees`/`wallet` with it. Assets
    // live in the SEPARATE inventory.json file — see performEconomyReset()
    // below for where that actually gets wiped.)

    return resetUser;
}

// --------------------------------------------------
// PRESERVE / FINALIZE PORTFOLIO HISTORY
// --------------------------------------------------
//
// Economy reset deletes player-owned companies and now also resets Major
// employment. Portfolio history is career history, not spendable economy
// state, so it must survive. Before deleting live employment state we:
//
// 1. recover any pre-portfolio current employees from player + Major rosters
//    using their original hiredAt timestamps;
// 2. close every active employment record at the reset timestamp.
//
function finalizePlayerPortfolioForReset(
    users,
    endedAt
) {

    const history =
        loadPortfolioHistory();

    // Close any already-recorded active player-company job.
    for (const userId of Object.keys(history)) {

        const jobs =
            history[userId]?.jobs;

        if (!Array.isArray(jobs)) {
            continue;
        }

        for (const job of jobs) {

            if (!job.endedAt) {
                job.endedAt =
                    endedAt;
            }

        }

    }

    // Backfill live player-company employees that predate the portfolio
    // feature, preserving their actual roster hiredAt timestamp.
    for (
        const ownerId
        of Object.keys(users)
    ) {

        const company =
            users[ownerId]?.company;

        if (
            !company ||
            !company.employees
        ) {
            continue;
        }

        for (
            const employee
            of Object.values(
                company.employees
            )
        ) {

            const userId =
                employee?.userId;

            const position =
                employee?.position;

            const hiredAt =
                Number(
                    employee?.hiredAt
                ) || null;

            if (
                !userId ||
                !position ||
                !hiredAt
            ) {
                continue;
            }

            if (!history[userId]) {
                history[userId] = {
                    jobs: []
                };
            }

            if (
                !Array.isArray(
                    history[userId].jobs
                )
            ) {
                history[userId].jobs = [];
            }

            const jobs =
                history[userId].jobs;

            const matching =
                jobs
                    .filter(job =>
                        job.companyName ===
                            company.name &&
                        job.position ===
                            position
                    )
                    .sort(
                        (a, b) =>
                            Number(b.hiredAt || 0) -
                            Number(a.hiredAt || 0)
                    )[0];

            if (matching) {

                if (
                    !Number.isFinite(
                        matching.hiredAt
                    ) ||
                    hiredAt <
                    matching.hiredAt
                ) {
                    matching.hiredAt =
                        hiredAt;
                }

                matching.endedAt =
                    endedAt;

                matching.companyType =
                    matching.companyType ||
                    "player";

                if (
                    matching.tier == null &&
                    company.level !== undefined
                ) {
                    matching.tier =
                        tierForLevel(
                            company.level
                        );
                }

                continue;
            }

            jobs.push({
                companyName:
                    company.name,
                position,
                tier:
                    company.level !== undefined
                        ? tierForLevel(
                            company.level
                        )
                        : null,
                companyType:
                    "player",
                hiredAt,
                endedAt
            });

        }

    }

    // Backfill current Major employees too. Major employment is reset
    // alongside player-company employment, but the career record survives.
    const majorsState =
        loadMajorsState();

    for (const majorKey of Object.keys(majorsState)) {

        const bucket =
            majorsState[majorKey];

        if (!bucket?.employees) {
            continue;
        }

        const major =
            getMajor(majorKey);

        const companyName =
            major?.name || majorKey;

        for (const employee of Object.values(bucket.employees)) {

            const userId =
                employee?.userId;

            const position =
                employee?.position;

            const hiredAt =
                Number(employee?.hiredAt) ||
                null;

            if (!userId || !position || !hiredAt) {
                continue;
            }

            if (!history[userId]) {
                history[userId] = {
                    jobs: []
                };
            }

            if (!Array.isArray(history[userId].jobs)) {
                history[userId].jobs = [];
            }

            const jobs =
                history[userId].jobs;

            const matching =
                jobs
                    .filter(job =>
                        job.companyName === companyName &&
                        job.position === position
                    )
                    .sort((a, b) =>
                        Number(b.hiredAt || 0) -
                        Number(a.hiredAt || 0)
                    )[0];

            if (matching) {

                if (
                    !Number.isFinite(matching.hiredAt) ||
                    hiredAt < matching.hiredAt
                ) {
                    matching.hiredAt =
                        hiredAt;
                }

                matching.endedAt =
                    endedAt;

                matching.companyType =
                    "major";

                continue;
            }

            jobs.push({
                companyName,
                position,
                tier: null,
                companyType: "major",
                hiredAt,
                endedAt
            });

        }

    }

    savePortfolioHistory(
        history
    );

}


// --------------------------------------------------
// RESET EVERYTHING
// --------------------------------------------------

function performEconomyReset() {

    const users = loadUsers();

    const resetAt =
        Date.now();

    // Preserve career history before player-company state disappears.
    finalizePlayerPortfolioForReset(
        users,
        resetAt
    );

    let totalUsers = 0;

    const resetUsers = {};

    for (const [userId, user] of Object.entries(users)) {

        resetUsers[userId] = resetUser(user);
        totalUsers++;

    }

    saveUsers(resetUsers);

    // FIX: the confirmation message below has always promised
    // "🎒 Inventories → WIPED", but nothing in this function actually
    // touched inventory.json before now — everyone's .shop collectibles,
    // mystery-box wins, AND .invest asset holdings (gold/stark/land/oil/
    // tech/bonds/art — see commands/invest.js's ASSETS) all survived a
    // reset silently. Wiped here to match what owners are already told
    // is happening.
    //
    // Collections (collection.json, i.e. cards) are intentionally left
    // alone — matches "🃏 Collections → UNTOUCHED" below and keeps
    // .cardlb meaningful across a reset.
    //
    // NOT touched: market.json (global asset prices — that's shared
    // market state, not any individual user's data, so a reset shouldn't
    // reroll it) and lib/jobOffers.js's offerCounter.json (harmless to
    // leave running — since every company's `offers` object was just
    // deleted along with `company` above, there's nothing left for an
    // old offer ID to collide with; the counter just starts new offers
    // at a higher number than before, which doesn't break anything).
    saveInventory({});

    // Major employment/applications are economy-cycle state too.
    // Static Major definitions live in lib/majors.js and are untouched.
    // Empty state is re-initialized from those definitions on next access.
    saveMajorsState({});

    return totalUsers;
}

// --------------------------------------------------
// MAIN OWNER CHECK
// --------------------------------------------------

function isMainOwner(sender) {
    return String(sender) === String(MAIN_OWNER);
}

// --------------------------------------------------
// .reseteconomy
// --------------------------------------------------

async function resetEconomyCommand(sock, msg, text) {

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    // ----------------------------------------------
    // MAIN OWNER ONLY
    // ----------------------------------------------

    if (!isMainOwner(sender)) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`╭━━━━━━ 🚫 𝗔𝗖𝗖𝗘𝗦𝗦 𝗗𝗘𝗡𝗜𝗘𝗗 ━━━━━━╮
│
│ Only Lord Crimson can use 
│ this command.
│
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`
            },
            { quoted: msg }
        );

    }

    // ----------------------------------------------
    // CHECK CONFIRMATION
    // ----------------------------------------------
    //
    // The command itself is now what carries the confirmation:
    // ".reseteconomy" starts the flow, and ".yes" / ".no" arrive as their
    // own standalone messages (routed here from index.js), NOT as a second
    // argument to ".reseteconomy". So we read args[0] — the command word —
    // rather than args[1].

    const args =
        text
            .trim()
            .split(/\s+/)
            .filter(Boolean);

    const command = args[0] ? args[0].toLowerCase() : "";

    const confirmation =
        command === ".yes" || command === "yes"
            ? "yes"
            : command === ".no" || command === "no"
            ? "no"
            : null;

    // ----------------------------------------------
    // .reseteconomy
    // ----------------------------------------------

    if (!confirmation) {

        resetPending = true;
        resetRequestedBy = sender;

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`╭━━━━━━ ⚠️ 𝗘𝗖𝗢𝗡𝗢𝗠𝗬 𝗥𝗘𝗦𝗘𝗧 ━━━━━━╮
│
│ This will reset ALL users'
│ economy data.
│
│ Are you absolutely sure?
│
│ Reply with:
│
│ .yes  → Reset everything
│ .no   → Cancel
│
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`
            },
            { quoted: msg }
        );

    }

    // ----------------------------------------------
    // .NO
    // ----------------------------------------------

    if (confirmation === "no") {

        if (
            !resetPending ||
            resetRequestedBy !== sender
        ) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text: "ℹ️ There is no pending economy reset."
                },
                { quoted: msg }
            );

        }

        resetPending = false;
        resetRequestedBy = null;

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`╭━━━━━━ ❎ 𝗥𝗘𝗦𝗘𝗧 𝗖𝗔𝗡𝗖𝗘𝗟𝗟𝗘𝗗 ━━━━━━╮
│
│ No user data was changed.
│ Your economy remains untouched.
│
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`
            },
            { quoted: msg }
        );

    }

    // ----------------------------------------------
    // .YES
    // ----------------------------------------------

    if (confirmation === "yes") {

        if (
            !resetPending ||
            resetRequestedBy !== sender
        ) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
                        "ℹ️ There is no pending economy reset."
                },
                { quoted: msg }
            );

        }

        // Clear confirmation BEFORE performing reset.
        resetPending = false;
        resetRequestedBy = null;

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`╭━━━━━━ 🔄 𝗥𝗘𝗦𝗘𝗧𝗧𝗜𝗡𝗚 ━━━━━━╮
│
│ Resetting all users' data
│ back to the initial state...
│
│ 💰 Wallet → 500,000 🌙
│ 🏦 Bank → 0 🌙
│ 📊 Level → 1
│ 🏅 Rank → Beginner
│ 🎮 Games → 0
│ 🏆 Wins → 0
│ ❌ Losses → 0
│ 🔥 Daily streak → 0
│ 🏢 Companies → DELETED
│ 🏛️ Major employment → RESET
│ 🎒 Inventories → WIPED
│
│ 🃏 Collections → UNTOUCHED
│ 📂 Portfolios → PRESERVED
│
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`
            },
            { quoted: msg }
        );

        try {

            const totalUsers =
                performEconomyReset();

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`╭━━━━━━ ✅ 𝗘𝗖𝗢𝗡𝗢𝗠𝗬 𝗥𝗘𝗦𝗘𝗧 ━━━━━━╮
│
│ All users have been reset.
│
│ 👥 Users reset: ${totalUsers}
│
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`
                },
                { quoted: msg }
            );

        } catch (err) {

            console.error(
                "❌ Economy reset failed:",
                err
            );

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`❌ Economy reset failed.

No further reset operation was attempted.

Error:
${err.message}`
                },
                { quoted: msg }
            );

        }

    }

    // ----------------------------------------------
    // INVALID CONFIRMATION
    // ----------------------------------------------

    return await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`⚠️ Invalid response.

Please use:

.yes → Confirm economy reset
.no  → Cancel economy reset`
        },
        { quoted: msg }
    );
}

module.exports = {
    resetEconomyCommand
};