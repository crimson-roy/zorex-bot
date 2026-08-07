const fs = require("fs");
const dataPath = require("../lib/dataPath");
const { MAIN_OWNER } = require("../config");

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
    // Therefore they are completely removed.

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

    const args =
        text
            .trim()
            .split(/\s+/)
            .filter(Boolean);

    const confirmation =
        args[1]
            ? args[1].toLowerCase()
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
│ Using this command will reset
│ ALL USERS' ECONOMY DATA.
│
│ This includes:
│
│ 💰 Wallet balances
│ 🏦 Bank balances
│ 📊 Levels & ranks
│ 🎮 Games / wins / losses
│ 🔥 Daily streaks
│ 🏢 Companies
│ 📈 Company upgrades
│ 🎒 Inventories
│
│ Every company will be deleted,
│ regardless of its current level.
│
│ 🃏 COLLECTIONS WILL NOT BE TOUCHED.
│
│ ⚠️ THIS ACTION CANNOT BE UNDONE.
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

    if (confirmation === ".no" || confirmation === "no") {

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

    if (confirmation === ".yes" || confirmation === "yes") {

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
│ 💰 New wallet: 500,000 🌙
│ 🏢 Companies: Deleted
│ 🎒 Inventories: Wiped
│
│ 🃏 Collections were NOT touched.
│
│ The economy is now back to
│ its initial state.
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