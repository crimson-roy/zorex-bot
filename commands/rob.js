const fs = require("fs");
const { checkCooldown, setCooldown } = require("./cooldown");
const { formatValue } = require("./misc");

const USERS_FILE = "./users.json";
const COOLDOWN_MS = 7200000; // 2 hours
const MIN_TARGET_WALLET = 10000;

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
    "🥷 You crept up behind them and swiped their cash.",
    "🎭 You pickpocketed them without them noticing a thing.",
    "💰 You caught them slipping and cleaned them out.",
    "🚪 You broke into their stash while they weren't looking.",
    "🔪 You held them up and walked away with a full pocket."
];

const LOSS_LINES = [
    "👮 They caught you mid-robbery and called the cops. Arrested.",
    "🥊 They fought back and you had to run, dropping cash in the process.",
    "📸 Security cameras caught your face. Fined for the attempt.",
    "🚨 An alarm went off before you could grab anything. Arrested.",
    "🏃 You tripped fleeing the scene and got caught."
];

// ---------- .rob @user — PvP robbery, 2 min cooldown ----------
async function robCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have a Zorex profile. Use .register`
        }, { quoted: msg });
    }

    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const target = mentioned[0];

    if (!target) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You need to tag someone to rob.\n\nExample:\n.rob @user`
        }, { quoted: msg });
    }

    if (target === sender) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `😂 You can't rob yourself.`
        }, { quoted: msg });
    }

    if (!users[target]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ That user doesn't have a Zorex profile.`
        }, { quoted: msg });
    }

    const remaining = checkCooldown(sender, "rob", COOLDOWN_MS);

    if (remaining) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⏳ You're laying low. Try again in ${Math.ceil(remaining / 1000)}s.`
        }, { quoted: msg });
    }

    const robber = users[sender];
    const victim = users[target];

    if (robber.wallet === undefined) robber.wallet = 0;
    if (victim.wallet === undefined) victim.wallet = 0;

    if (victim.wallet < MIN_TARGET_WALLET) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `😅 @${target.split("@")[0]} is too broke to rob (under ${formatValue(MIN_TARGET_WALLET)} 🌙).`,
            mentions: [target]
        }, { quoted: msg });
    }

    const success = Math.random() < 0.35;

    let text;

    if (success) {

        const percent = randomAmount(10, 30) / 100;
        const stolen = Math.floor(victim.wallet * percent);
        const line = WIN_LINES[Math.floor(Math.random() * WIN_LINES.length)];

        victim.wallet -= stolen;
        robber.wallet += stolen;

        text =
`🔫 *ROB* — SUCCESS
${line}
🎯 Target: @${target.split("@")[0]}
💰 Stolen: ${formatValue(stolen)} 🌙`;

    } else {

        const lost = Math.floor(robber.wallet * 0.2);
        const line = LOSS_LINES[Math.floor(Math.random() * LOSS_LINES.length)];

        robber.wallet -= lost;

        text =
`🚔 *ROB* — CAUGHT
${line}
🎯 Target: @${target.split("@")[0]}
💸 Lost: ${formatValue(lost)} 🌙`;

    }

    saveUsers(users);
    setCooldown(sender, "rob");

    return await sock.sendMessage(msg.key.remoteJid, {
        text,
        mentions: [sender, target]
    }, { quoted: msg });

}

module.exports = { robCommand };