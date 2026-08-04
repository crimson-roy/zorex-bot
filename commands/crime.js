const fs = require("fs");
const { checkCooldown, setCooldown } = require("./cooldown");
const { formatValue } = require("./misc");

// PERSISTENCE FIX: routed through dataPath() — a redeploy wiping this
// would silently break everyone's wallet. See lib/dataPath.js.
const dataPath = require("../lib/dataPath");

const USERS_FILE = dataPath("users.json");
const COOLDOWN_MS = 120000; // 2 minutes

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 4));
}

function randomAmount(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

const WIN_LINES = [
    "🚗 You hotwired a car and sold its parts.",
    "🏚️ You robbed a house successfully.",
    "💻 You ran a quick scam online and won big.",
    "🥷 You pulled off a disguise heist.",
    "👛 You snatched a lady's purse successfully.",
    "🏦 JACKPOT! You hacked into Zorex World Bank, withdrew the cash, and logged out clean.",
    "🏛️ You successfully robbed the senator's house.",
    "🔓 You broke into Lord Crimson's safe house and got out before the alarm started blaring."
];

const LOSS_LINES = [
    "👛 You snatched a lady's purse but slipped on a banana. Fined on the spot.",
    "🐕 You got bitten by a dog during the robbery. Arrested.",
    "🚨 Lord Crimson's safehouse auto defense system kicked in. Arrested.",
    "📡 Your IP address was tracked. Arrested.",
    "👮 The senator ordered more security. Arrested.",
    "🏦 Zorex World Bank hacked into your wallet and removed funds for invasion of privacy."
];

// ---------- .crime — 50/50 risk command, 2 min cooldown ----------
async function crimeCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have a Zorex profile. Use .register`
        }, { quoted: msg });
    }

    const remaining = checkCooldown(sender, "crime", COOLDOWN_MS);

    if (remaining) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⏳ You're laying low. Try again in ${Math.ceil(remaining / 1000)}s.`
        }, { quoted: msg });
    }

    const user = users[sender];
    if (user.wallet === undefined) user.wallet = 0;

    const success = Math.random() < 0.5;

    let text;

    if (success) {

        const amount = randomAmount(20000, 300000);
        const line = WIN_LINES[Math.floor(Math.random() * WIN_LINES.length)];

        user.wallet += amount;

        text =
`🔫 *CRIME* — SUCCESS
${line}
💰 Earned: ${formatValue(amount)} 🌙`;

    } else {

        const lost = Math.floor(user.wallet * 0.5);
        const line = LOSS_LINES[Math.floor(Math.random() * LOSS_LINES.length)];

        user.wallet -= lost;

        text =
`🚔 *CRIME* — CAUGHT
${line}
💸 Lost: ${formatValue(lost)} 🌙`;

    }

    saveUsers(users);
    setCooldown(sender, "crime");

    return await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });

}

module.exports = { crimeCommand };const fs = require("fs");
const { checkCooldown, setCooldown } = require("./cooldown");
const { formatValue } = require("./misc");

// PERSISTENCE FIX: routed through dataPath() — a redeploy wiping this
// would silently break everyone's wallet. See lib/dataPath.js.
const dataPath = require("../lib/dataPath");

const USERS_FILE = dataPath("users.json");
const COOLDOWN_MS = 120000; // 2 minutes

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 4));
}

function randomAmount(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

const WIN_LINES = [
    "🚗 You hotwired a car and sold its parts.",
    "🏚️ You robbed a house successfully.",
    "💻 You ran a quick scam online and won big.",
    "🥷 You pulled off a disguise heist.",
    "👛 You snatched a lady's purse successfully.",
    "🏦 JACKPOT! You hacked into Zorex World Bank, withdrew the cash, and logged out clean.",
    "🏛️ You successfully robbed the senator's house.",
    "🔓 You broke into Lord Crimson's safe house and got out before the alarm started blaring."
];

const LOSS_LINES = [
    "👛 You snatched a lady's purse but slipped on a banana. Fined on the spot.",
    "🐕 You got bitten by a dog during the robbery. Arrested.",
    "🚨 Lord Crimson's safehouse auto defense system kicked in. Arrested.",
    "📡 Your IP address was tracked. Arrested.",
    "👮 The senator ordered more security. Arrested.",
    "🏦 Zorex World Bank hacked into your wallet and removed funds for invasion of privacy."
];

// ---------- .crime — 50/50 risk command, 2 min cooldown ----------
async function crimeCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have a Zorex profile. Use .register`
        }, { quoted: msg });
    }

    const remaining = checkCooldown(sender, "crime", COOLDOWN_MS);

    if (remaining) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⏳ You're laying low. Try again in ${Math.ceil(remaining / 1000)}s.`
        }, { quoted: msg });
    }

    const user = users[sender];
    if (user.wallet === undefined) user.wallet = 0;

    const success = Math.random() < 0.5;

    let text;

    if (success) {

        const amount = randomAmount(20000, 300000);
        const line = WIN_LINES[Math.floor(Math.random() * WIN_LINES.length)];

        user.wallet += amount;

        text =
`🔫 *CRIME* — SUCCESS
${line}
💰 Earned: ${formatValue(amount)} 🌙`;

    } else {

        const lost = Math.floor(user.wallet * 0.5);
        const line = LOSS_LINES[Math.floor(Math.random() * LOSS_LINES.length)];

        user.wallet -= lost;

        text =
`🚔 *CRIME* — CAUGHT
${line}
💸 Lost: ${formatValue(lost)} 🌙`;

    }

    saveUsers(users);
    setCooldown(sender, "crime");

    return await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });

}

module.exports = { crimeCommand };