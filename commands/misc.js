const fs = require("fs");
const { checkCooldown } = require("./cooldown");
const { getDailyStatus } = require("./dailylimit");

// PERSISTENCE FIX: these used to be bare relative paths ("./users.json",
// "./owners.json"), which live on the container's ephemeral disk and get
// wiped on every redeploy. Routed through dataPath() so they persist on
// the attached Railway Volume instead. See lib/dataPath.js.
const dataPath = require("../lib/dataPath");

const USERS_FILE = dataPath("users.json");
const OWNERS_FILE = dataPath("owners.json");

const COOLDOWN_MS = 30000;
const GAMES = ["cf", "casino", "roulette", "slots"]; // games with cooldown/daily tracking

const MEDALS = ["🥇", "🥈", "🥉"];

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function loadOwners() {
    if (!fs.existsSync(OWNERS_FILE)) fs.writeFileSync(OWNERS_FILE, JSON.stringify([], null, 4));
    return JSON.parse(fs.readFileSync(OWNERS_FILE, "utf8"));
}

function isOwner(userId) {
    return loadOwners().includes(userId);
}

// Compact number formatter — Thousand/Million/Billion/Trillion/Quadrillion/Quintillion
function formatValue(n) {
    const units = [
        { value: 1e18, symbol: "Quintillion" },
        { value: 1e15, symbol: "Quadrillion" },
        { value: 1e12, symbol: "Trillion" },
        { value: 1e9,  symbol: "Billion" },
        { value: 1e6,  symbol: "Million" },
        { value: 1e3,  symbol: "Thousand" }
    ];

    for (const u of units) {
        if (n >= u.value) {
            return (n / u.value).toFixed(2).replace(/\.00$/, "") + " " + u.symbol;
        }
    }

    return n.toLocaleString();
}

// Checks the sender's REAL WhatsApp admin/superadmin status in this group
async function isGroupAdmin(sock, groupId, userId) {
    try {
        const metadata = await sock.groupMetadata(groupId);
        const participant = metadata.participants.find(p => p.id === userId);

        return !!participant && (
            participant.admin === "admin" ||
            participant.admin === "superadmin"
        );
    } catch (err) {
        return false;
    }
}


// ---------- .rich — leaderboard of richest users (wallet + bank) ----------
async function richCommand(sock, msg) {

    const users = loadUsers();
    const sender = msg.key.participant || msg.key.remoteJid;

    const ranked = Object.entries(users)
        .map(([id, u]) => ({
            id,
            name: u.name || id.split("@")[0],
            role: u.role || "user",
            wallet: u.wallet || 0,
            bank: u.bank || 0,
            total: (u.wallet || 0) + (u.bank || 0)
        }))
        .sort((a, b) => b.total - a.total);

    if (ranked.length === 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `📊 No registered users yet.`
        }, { quoted: msg });
    }

    const top10 = ranked.slice(0, 10);

    const lines = top10.map((u, i) => {
        const tag = i < 3 ? MEDALS[i] : `🔹 #${i + 1}`;
        const walletText = u.wallet === 0 ? "0 Crescent" : `${formatValue(u.wallet)} Crescent`;

        return (
`${tag} *${u.name}*
   ⚔️ Role: \`${u.role}\`
   💰 Net Worth: ${formatValue(u.total)}
   💵 Wallet: ${walletText} | 🏦 Bank: ${formatValue(u.bank)} Crescent`
        );
    });

    const senderIndex = ranked.findIndex(u => u.id === sender);
    const senderRank = senderIndex === -1 ? null : senderIndex + 1;
    const senderName = senderIndex === -1 ? null : ranked[senderIndex].name;

    const totalWallet = ranked.reduce((sum, u) => sum + u.wallet, 0);
    const totalBank = ranked.reduce((sum, u) => sum + u.bank, 0);
    const totalMoney = totalWallet + totalBank;

    const rankLine = senderRank
        ? `🎯 *${senderName}*, your rank is *#${senderRank}* out of ${ranked.length} users.`
        : `🎯 You're not registered yet — use a game command to get started.`;

    const text =
`🏆 *RICHEST PLAYERS LEADERBOARD* 🏆
${lines.join("\n")}
--------------------------------
${rankLine}
--------------------------------
📊 *GLOBAL SERVER ECONOMY STATE*
   💎 Total Money: ${formatValue(totalMoney)}
   💵 Money in Wallet: ${formatValue(totalWallet)}
   🏦 Money in Bank: ${formatValue(totalBank)}`;

    return await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });

}


// ---------- .open — unmute the group (everyone can send messages) ----------
async function openGroup(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const groupId = msg.key.remoteJid;

    if (!groupId.endsWith("@g.us")) {
        return await sock.sendMessage(groupId, { text: `❌ This command only works in groups.` }, { quoted: msg });
    }

    const allowed = isOwner(sender) || await isGroupAdmin(sock, groupId, sender);

    if (!allowed) {
        return await sock.sendMessage(groupId, { text: `❌ Only group admins can use this command.` }, { quoted: msg });
    }

    try {
        await sock.groupSettingUpdate(groupId, "not_announcement");
        return await sock.sendMessage(groupId, { text: `🔓 Group is now open — all members can send messages.` }, { quoted: msg });
    } catch (err) {
        return await sock.sendMessage(groupId, { text: `❌ Failed to open group. Make sure the bot is an admin.` }, { quoted: msg });
    }

}


// ---------- .close — mute the group (only admins can send messages) ----------
async function closeGroup(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const groupId = msg.key.remoteJid;

    if (!groupId.endsWith("@g.us")) {
        return await sock.sendMessage(groupId, { text: `❌ This command only works in groups.` }, { quoted: msg });
    }

    const allowed = isOwner(sender) || await isGroupAdmin(sock, groupId, sender);

    if (!allowed) {
        return await sock.sendMessage(groupId, { text: `❌ Only group admins can use this command.` }, { quoted: msg });
    }

    try {
        await sock.groupSettingUpdate(groupId, "announcement");
        return await sock.sendMessage(groupId, { text: `🔒 Group is now closed — only admins can send messages.` }, { quoted: msg });
    } catch (err) {
        return await sock.sendMessage(groupId, { text: `❌ Failed to close group. Make sure the bot is an admin.` }, { quoted: msg });
    }

}


// ---------- .invite — fetch and send the current group invite link ----------
async function inviteCommand(sock, msg) {

    const groupId = msg.key.remoteJid;

    if (!groupId.endsWith("@g.us")) {
        return await sock.sendMessage(groupId, { text: `❌ This command only works in groups.` }, { quoted: msg });
    }

    try {
        const code = await sock.groupInviteCode(groupId);
        return await sock.sendMessage(groupId, { text: `🔗 *Group Invite Link*\nhttps://chat.whatsapp.com/${code}` }, { quoted: msg });
    } catch (err) {
        return await sock.sendMessage(groupId, { text: `❌ Failed to fetch invite link. Make sure the bot is an admin.` }, { quoted: msg });
    }

}


// ---------- .mycds — your cooldowns across all games ----------
async function myCooldownsCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;

    const lines = GAMES.map(game => {
        const remaining = checkCooldown(sender, game, COOLDOWN_MS);
        return remaining
            ? `⏳ ${game} — ${Math.ceil(remaining / 1000)}s left`
            : `✅ ${game} — ready`;
    });

    return await sock.sendMessage(msg.key.remoteJid, {
        text: `🕐 *YOUR COOLDOWNS*\n${lines.join("\n")}`
    }, { quoted: msg });

}


// ---------- .mydls — your daily play limits across all games ----------
async function myDailyLimitsCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;

    const lines = GAMES.map(game => {
        const { used, limit } = getDailyStatus(sender, game);
        return `🎮 ${game} — ${used}/${limit}`;
    });

    return await sock.sendMessage(msg.key.remoteJid, {
        text: `📅 *YOUR DAILY LIMITS*\n${lines.join("\n")}`
    }, { quoted: msg });

}


module.exports = {
    formatValue,
    MEDALS,
    richCommand,
    openGroup,
    closeGroup,
    inviteCommand,
    myCooldownsCommand,
    myDailyLimitsCommand,
    isGroupAdmin
};