const fs = require("fs");

const USERS_FILE = "./users.json";

const BASE_REWARD = 20000;
const STREAK_BONUS_PER_DAY = 5000;
const MAX_STREAK_FOR_BONUS = 20; // bonus stops growing after this many days

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = 48 * 60 * 60 * 1000; // miss beyond this and the streak breaks

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 4));
}


// ---------- .daily ----------
async function dailyCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have a Zorex profile.\n\nUse:\n.register YOUR_NAME`
        }, { quoted: msg });
    }

    const user = users[sender];
    const now = Date.now();

    const lastClaim = user.lastDaily || 0;
    const sinceLastClaim = now - lastClaim;

    // Still on cooldown
    if (sinceLastClaim < ONE_DAY_MS) {

        const remaining = ONE_DAY_MS - sinceLastClaim;
        const hours = Math.floor(remaining / (60 * 60 * 1000));
        const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⏳ You've already claimed today.\n\nCome back in ${hours}h ${minutes}m.`
        }, { quoted: msg });

    }

    // Determine streak: continue if claimed within the grace window, else reset
    let streak = user.dailyStreak || 0;

    if (lastClaim === 0 || sinceLastClaim > GRACE_MS) {
        streak = 1; // fresh start (first claim ever, or missed the grace window)
    } else {
        streak += 1; // claimed within the valid window — streak continues
    }

    const bonusDays = Math.min(streak, MAX_STREAK_FOR_BONUS);
    const bonus = bonusDays * STREAK_BONUS_PER_DAY;
    const reward = BASE_REWARD + bonus;

    user.wallet += reward;
    user.lastDaily = now;
    user.dailyStreak = streak;

    saveUsers(users);

    return await sock.sendMessage(msg.key.remoteJid, {
        text:
`🌙 *DAILY REWARD CLAIMED!*

💰 Base:
${BASE_REWARD.toLocaleString()} 🌙

🔥 Streak Bonus (Day ${streak}):
+${bonus.toLocaleString()} 🌙

🎁 Total:
${reward.toLocaleString()} 🌙

💳 Wallet:
${user.wallet.toLocaleString()} 🌙

⏳ Come back in 24 hours to keep your streak alive!`
    }, { quoted: msg });

}


module.exports = {
    dailyCommand
};