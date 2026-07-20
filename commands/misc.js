const fs = require("fs");
const { checkCooldown } = require("./cooldown");
const { getDailyStatus } = require("./dailylimit");

const USERS_FILE = "./users.json";
const OWNERS_FILE = "./owners.json";

const COOLDOWN_MS = 30000;
const GAMES = ["cf", "casino", "roulette", "slots"]; // games with cooldown/daily tracking

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

    const ranked = Object.entries(users)
        .map(([id, u]) => ({
            id,
            total: (u.wallet || 0) + (u.bank || 0),
            name: u.name || id.split("@")[0]
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);

    if (ranked.length === 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `📊 No registered users yet.`
        }, { quoted: msg });
    }

    const medals = ["🥇", "🥈", "🥉"];

    const list = ranked
        .map((u, i) => `${medals[i] || `${i + 1}.`} ${u.name} — ${u.total.toLocaleString()} 🌙`)
        .join("\n");

    return await sock.sendMessage(msg.key.remoteJid, {
        text: `🏆 *ZOREX RICH LIST*\n\n${list}\n\nPowered by Zorex AI 🤖`
    }, { quoted: msg });

}


// ---------- .open — unmute the group (everyone can send messages) ----------
async function openGroup(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const groupId = msg.key.remoteJid;

    if (!groupId.endsWith("@g.us")) {
        return await sock.sendMessage(groupId, {
            text: `❌ This command only works in groups.`
        }, { quoted: msg });
    }

    const allowed = isOwner(sender) || await isGroupAdmin(sock, groupId, sender);

    if (!allowed) {
        return await sock.sendMessage(groupId, {
            text: `❌ Only group admins can use this command.`
        }, { quoted: msg });
    }

    try {

        await sock.groupSettingUpdate(groupId, "not_announcement");

        return await sock.sendMessage(groupId, {
            text: `🔓 Group is now open — all members can send messages.`
        }, { quoted: msg });

    } catch (err) {

        return await sock.sendMessage(groupId, {
            text: `❌ Failed to open group. Make sure the bot is an admin.`
        }, { quoted: msg });

    }

}


// ---------- .close — mute the group (only admins can send messages) ----------
async function closeGroup(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const groupId = msg.key.remoteJid;

    if (!groupId.endsWith("@g.us")) {
        return await sock.sendMessage(groupId, {
            text: `❌ This command only works in groups.`
        }, { quoted: msg });
    }

    const allowed = isOwner(sender) || await isGroupAdmin(sock, groupId, sender);

    if (!allowed) {
        return await sock.sendMessage(groupId, {
            text: `❌ Only group admins can use this command.`
        }, { quoted: msg });
    }

    try {

        await sock.groupSettingUpdate(groupId, "announcement");

        return await sock.sendMessage(groupId, {
            text: `🔒 Group is now closed — only admins can send messages.`
        }, { quoted: msg });

    } catch (err) {

        return await sock.sendMessage(groupId, {
            text: `❌ Failed to close group. Make sure the bot is an admin.`
        }, { quoted: msg });

    }

}


// ---------- .invite — fetch and send the current group invite link ----------
async function inviteCommand(sock, msg) {

    const groupId = msg.key.remoteJid;

    if (!groupId.endsWith("@g.us")) {
        return await sock.sendMessage(groupId, {
            text: `❌ This command only works in groups.`
        }, { quoted: msg });
    }

    try {

        const code = await sock.groupInviteCode(groupId);

        return await sock.sendMessage(groupId, {
            text: `🔗 *Group Invite Link*\n\nhttps://chat.whatsapp.com/${code}`
        }, { quoted: msg });

    } catch (err) {

        return await sock.sendMessage(groupId, {
            text: `❌ Failed to fetch invite link. Make sure the bot is an admin.`
        }, { quoted: msg });

    }

}


// ---------- .mycds — your cooldowns across all games ----------
async function myCooldownsCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;

    const lines = GAMES.map(game => {

        const remaining = checkCooldown(sender, game, COOLDOWN_MS);

        if (remaining) {
            return `⏳ ${game} — ${Math.ceil(remaining / 1000)}s left`;
        }

        return `✅ ${game} — ready`;

    });

    return await sock.sendMessage(msg.key.remoteJid, {
        text: `🕐 *YOUR COOLDOWNS*\n\n${lines.join("\n")}`
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
        text: `📅 *YOUR DAILY LIMITS*\n\n${lines.join("\n")}`
    }, { quoted: msg });

}


module.exports = {
    richCommand,
    openGroup,
    closeGroup,
    inviteCommand,
    myCooldownsCommand,
    myDailyLimitsCommand
};