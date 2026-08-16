const fs = require("fs");
const dataPath = require("../lib/dataPath");
const { MAIN_OWNER } = require("../config");
const { saveInventory } = require("./inventory");

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
// RESET EVERYTHING
// --------------------------------------------------

function performEconomyReset() {

    const users = loadUsers();

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
│ 🎒 Inventories → WIPED
│
│ 🃏 Collections → UNTOUCHED
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