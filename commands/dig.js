const { checkCooldown, setCooldown } = require("./cooldown");
const { loadInventory } = require("./inventory");
const { getPartner } = require("./marry");
const fs = require("fs");
const { formatValue } = require("./misc");

// PERSISTENCE FIX: this used to be a bare relative path ("./users.json"),
// which lives on the container's ephemeral disk and gets wiped on every
// redeploy. Routed through dataPath() so it persists on the attached
// Railway Volume instead — same fix already applied in economy.js/
// auction.js/owner.js. See lib/dataPath.js.
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

// Checks the user's own inventory first, then their married partner's —
// married couples share tool access.
function hasShovel(userId, inventory) {

    const items = inventory[userId] || [];
    if (items.some(it => it.id === "shovel")) return true;

    const users = loadUsers();
    const partner = getPartner(userId, users);

    if (partner) {
        const partnerItems = inventory[partner] || [];
        return partnerItems.some(it => it.id === "shovel");
    }

    return false;

}

const LOSS_LINES = [
    "🕳️ You found nothing but dirt.",
    "🐜 You dug up a termite nest.",
    "💥 You accidentally struck a mine."
];

// Rarer tiers = higher value, lower chance. Weights are out of 100 and only
// apply within the 70% win space.
const WIN_TIERS = [
    { id: "bronze", name: "Bronze", weight: 40, min: 5000, max: 15000, line: "🥉 You dug up a chunk of bronze." },
    { id: "old_coin", name: "Old Coin", weight: 25, min: 15000, max: 35000, line: "🪙 You dug up an old coin." },
    { id: "silver", name: "Silver", weight: 20, min: 35000, max: 70000, line: "🥈 You dug up a vein of silver." },
    { id: "gold", name: "Gold", weight: 10, min: 70000, max: 150000, line: "🥇 You dug up a nugget of gold." },
    { id: "treasure_chest", name: "Treasure Chest", weight: 5, min: 150000, max: 500000, line: "🏆 JACKPOT! You dug up a buried treasure chest." }
];

function rollWinTier() {

    const totalWeight = WIN_TIERS.reduce((sum, t) => sum + t.weight, 0);
    let roll = Math.random() * totalWeight;

    for (const tier of WIN_TIERS) {
        if (roll < tier.weight) return tier;
        roll -= tier.weight;
    }

    return WIN_TIERS[0]; // fallback, should never hit

}

// ---------- .dig — requires shovel, 2 min cooldown ----------
async function digCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const inventory = loadInventory();

    if (!hasShovel(sender, inventory)) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `🪓 You need a Shovel to dig.\n\nGrab one from .shop`
        }, { quoted: msg });
    }

    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have a Zorex profile. Use .register`
        }, { quoted: msg });
    }

    const remaining = checkCooldown(sender, "dig", COOLDOWN_MS);

    if (remaining) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⏳ Let the ground rest. Try again in ${Math.ceil(remaining / 1000)}s.`
        }, { quoted: msg });
    }

    const user = users[sender];
    if (user.wallet === undefined) user.wallet = 0;

    const success = Math.random() < 0.7;

    let text;

    if (success) {

        const tier = rollWinTier();
        const amount = randomAmount(tier.min, tier.max);

        user.wallet += amount;

        text =
`⛏️ *DIG* — SUCCESS
${tier.line}
💰 Sold for: ${formatValue(amount)} 🌙`;

    } else {

        const line = LOSS_LINES[Math.floor(Math.random() * LOSS_LINES.length)];

        text =
`⛏️ *DIG* — NOTHING
${line}`;

    }

    saveUsers(users);
    setCooldown(sender, "dig");

    return await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });

}

module.exports = { digCommand };