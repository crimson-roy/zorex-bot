const fs = require("fs");
const { checkCooldown, setCooldown } = require("./cooldown");
const { formatValue } = require("./misc");

const USERS_FILE = "./users.json";
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
    "🙏 A group member gave you crescents.",
    "👴 A kind old man helped you out.",
    "👑 Lord Crimson took pity on you.",
    "💍 The senator's wife took a liking to you.",
    "🎭 You were used for entertainment and given a tip.",
    "🚔 You were mistaken for a thief, beaten, and given compensation."
];

const LOSS_LINES = [
    "🙄 Someone told you to get a job.",
    "👵 You met a wicked old woman who gave you nothing.",
    "🛠️ You were used as a tool and discarded.",
    "😳 You slipped and embarrassed yourself.",
    "🤣 A classmate made fun of you and the whole class laughed."
];

// ---------- .beg — low-risk 50/50, 2 min cooldown ----------
async function begCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have a Zorex profile. Use .register`
        }, { quoted: msg });
    }

    const remaining = checkCooldown(sender, "beg", COOLDOWN_MS);

    if (remaining) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⏳ Give it a moment. Try again in ${Math.ceil(remaining / 1000)}s.`
        }, { quoted: msg });
    }

    const user = users[sender];
    if (user.wallet === undefined) user.wallet = 0;

    const success = Math.random() < 0.5;

    let text;

    if (success) {

        const amount = randomAmount(15000, 80000);
        const line = WIN_LINES[Math.floor(Math.random() * WIN_LINES.length)];

        user.wallet += amount;

        text =
`🤲 *BEG* — SUCCESS
${line}
💰 Received: ${formatValue(amount)} 🌙`;

    } else {

        const line = LOSS_LINES[Math.floor(Math.random() * LOSS_LINES.length)];

        text =
`🤷 *BEG* — NOTHING
${line}`;

    }

    saveUsers(users);
    setCooldown(sender, "beg");

    return await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });

}

module.exports = { begCommand };