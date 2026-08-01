const fs = require("fs");
const dataPath = require("../lib/dataPath");

// PERSISTENCE FIX: real per-user state, written every payout/upgrade —
// routed through dataPath() so it survives a redeploy. See lib/dataPath.js.
const USERS_FILE = dataPath("users.json");

// ---------- Tunable economy constants ----------
// NOTE: BASE_INCOME wasn't specified — 50,000 🌙/6h is my starting guess
// (roughly a 6h payback window on the 300,000 creation cost before any
// upgrades). Change this one number if you want a different pace.
const CREATE_COST = 300000;
const BASE_INCOME = 50000;              // income/6h at level 0 (no upgrades)
const INCOME_MULTIPLIER = 1.4;          // +40% income per upgrade
const BASE_UPGRADE_COST = 500000;       // cost of the 1st upgrade
const UPGRADE_COST_MULTIPLIER = 1.2;    // +20% upgrade cost per upgrade
const PAYOUT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function loadUsers() {

    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");

    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));

}

function saveUsers(users) {

    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify(users, null, 4),
        "utf8"
    );

}

function notRegisteredMessage() {
    return `╭━━━━ ⚠️ 𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗔𝗧𝗜𝗢𝗡 ━━━━╮
👤 Please register your account. ✨
────── 📝 𝗙𝗢𝗥𝗠𝗔𝗧 ──────
⌨️ .register YOUR_NAME
────── 💡 𝗘𝗫𝗔𝗠𝗣𝗟𝗘 ──────
🔥 .register Crimson Roy
╰━━━━━━━━━━━━━━━━━━━━━━━╯`;
}

function errorBox(title, message, examples) {
    const exampleLines = examples.map(e => `  📥 ${e}`).join("\n");
    return `╭━━━━ ⚠️ ${title} ━━━━╮
   ${message}
  ─── 📝 𝖤𝖷𝖠𝖬𝖯𝖫𝖤 ───
${exampleLines}
╰━━━━━━━━━━━━━━━━━━━━━━━╯`;
}

function incomeAtLevel(level) {
    return Math.round(BASE_INCOME * Math.pow(INCOME_MULTIPLIER, level));
}

function upgradeCostAtLevel(level) {
    return Math.round(BASE_UPGRADE_COST * Math.pow(UPGRADE_COST_MULTIPLIER, level));
}

function formatDuration(ms) {

    const totalMinutes = Math.max(0, Math.floor(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    return `${hours}h ${minutes}m`;

}

// Credits any full 6h periods that have passed since the company's last
// payout, advances lastPayout by exactly that many periods, and returns the
// amount collected (0 if none owed yet). This is what makes the income
// "automatic" without needing a background timer — it settles up whenever
// the user next touches their company.
function collectPendingIncome(users, userId) {

    const company = users[userId].company;

    if (!company) return 0;

    const now = Date.now();
    const elapsed = now - company.lastPayout;
    const periods = Math.floor(elapsed / PAYOUT_INTERVAL_MS);

    if (periods <= 0) return 0;

    const income = incomeAtLevel(company.level);
    const collected = income * periods;

    users[userId].wallet += collected;
    company.lastPayout += periods * PAYOUT_INTERVAL_MS;

    saveUsers(users);

    return collected;

}

// ---------- .company — view your company status ----------
async function companyCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: notRegisteredMessage() },
            { quoted: msg }
        );
    }

    const company = users[sender].company;

    if (!company) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: errorBox("𝗡𝗢 𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗬𝗘𝗧", `You don't have a company yet.\nStart one for ${CREATE_COST.toLocaleString()} 🌙.`, [".companycreate Roy Trading Group"]) },
            { quoted: msg }
        );
    }

    const collected = collectPendingIncome(users, sender);
    const income = incomeAtLevel(company.level);
    const nextUpgradeCost = upgradeCostAtLevel(company.level);
    const timeLeft = formatDuration(company.lastPayout + PAYOUT_INTERVAL_MS - Date.now());

    const collectedLine = collected > 0
        ? `💸 *${collected.toLocaleString()} 🌙 in passive income collected!*\n\n`
        : "";

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `${collectedLine}╭━━━━━━━━━━━━━━━━━━━━━━━╮
       𖤓 𝗬𝗢𝗨𝗥 𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𖤓
╰━━━━━━━━━━━━━━━━━━━━━━━╯
» Name    : ${company.name}
» Level   : ${company.level}
» Income  : ${income.toLocaleString()} 🌙 every 6h
» Next Up : ${nextUpgradeCost.toLocaleString()} 🌙 (.companyupgrade)
» Payout  : in ${timeLeft}
━━━━━━━━━━━━━━━━━━━━━━━━━
» Wallet  : ${users[sender].wallet.toLocaleString()} 🌙
━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ Powered by Zorex AI`
        },
        { quoted: msg }
    );

}

// ---------- .companycreate <name> — start a company for 300,000 ----------
async function companyCreateCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: notRegisteredMessage() },
            { quoted: msg }
        );
    }

    if (users[sender].company) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: `⚠️ You already own a company — *${users[sender].company.name}*.\n\nUse .companyupgrade to grow it instead.` },
            { quoted: msg }
        );
    }

    const name = text.replace(".companycreate", "").trim();

    if (!name) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: errorBox("𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗖𝗥𝗘𝗔𝗧𝗘", "Enter a name for your company.", [".companycreate Roy Trading Group"]) },
            { quoted: msg }
        );
    }

    if (users[sender].wallet < CREATE_COST) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: `❌ You need ${CREATE_COST.toLocaleString()} 🌙 in your wallet to start a company.\n\n💰 Wallet: ${users[sender].wallet.toLocaleString()} 🌙` },
            { quoted: msg }
        );
    }

    users[sender].wallet -= CREATE_COST;

    users[sender].company = {
        name: name,
        level: 0,
        createdAt: Date.now(),
        lastPayout: Date.now()
    };

    saveUsers(users);

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
   🏢 𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗖𝗥𝗘𝗔𝗧𝗘𝗗 🏢
╰━━━━━━━━━━━━━━━━━━━━━━━╯
» Name    : ${name}
» Income  : ${incomeAtLevel(0).toLocaleString()} 🌙 every 6h
» Wallet  : ${users[sender].wallet.toLocaleString()} 🌙
━━━━━━━━━━━━━━━━━━━━━━━━━
Use .companyupgrade to grow your empire.`
        },
        { quoted: msg }
    );

}

// ---------- .companyupgrade — level up, cost +20%, income +40% each time ----------
async function companyUpgradeCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: notRegisteredMessage() },
            { quoted: msg }
        );
    }

    const company = users[sender].company;

    if (!company) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: errorBox("𝗡𝗢 𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗬𝗘𝗧", `You don't have a company yet.\nStart one for ${CREATE_COST.toLocaleString()} 🌙.`, [".companycreate Roy Trading Group"]) },
            { quoted: msg }
        );
    }

    // Settle any income owed before spending, so nothing is lost to the upgrade
    collectPendingIncome(users, sender);

    const cost = upgradeCostAtLevel(company.level);

    if (users[sender].wallet < cost) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: `❌ You need ${cost.toLocaleString()} 🌙 to upgrade *${company.name}*.\n\n💰 Wallet: ${users[sender].wallet.toLocaleString()} 🌙` },
            { quoted: msg }
        );
    }

    users[sender].wallet -= cost;
    company.level += 1;

    saveUsers(users);

    const newIncome = incomeAtLevel(company.level);
    const nextCost = upgradeCostAtLevel(company.level);

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
  🏢 𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗨𝗣𝗚𝗥𝗔𝗗𝗘𝗗 🏢
╰━━━━━━━━━━━━━━━━━━━━━━━╯
» Name       : ${company.name}
» New Level  : ${company.level}
» New Income : ${newIncome.toLocaleString()} 🌙 every 6h
» Wallet     : ${users[sender].wallet.toLocaleString()} 🌙
━━━━━━━━━━━━━━━━━━━━━━━━━
Next upgrade costs ${nextCost.toLocaleString()} 🌙`
        },
        { quoted: msg }
    );

}

module.exports = {
    companyCommand,
    companyCreateCommand,
    companyUpgradeCommand
};