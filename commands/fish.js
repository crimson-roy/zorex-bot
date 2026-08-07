const { checkCooldown, setCooldown } = require("./cooldown");
const { loadInventory, saveInventory } = require("./inventory");
const { getPartner } = require("./marry");
const fs = require("fs");

// PERSISTENCE FIX: this used to be a bare relative path ("./users.json"),
// which lives on the container's ephemeral disk and gets wiped on every
// redeploy. Routed through dataPath() so it persists on the attached
// Railway Volume instead — same fix already applied in economy.js/
// auction.js/owner.js/dig.js/rob.js/blackjack.js. See lib/dataPath.js.
const dataPath = require("../lib/dataPath");

const USERS_FILE = dataPath("users.json");
const COOLDOWN_MS = 120000; // 2 minutes

const FISH_VALUE = 5000;
const GOLDEN_FISH_VALUE = 15000;

// Items .sell knows how to price. Add more entries here later (e.g. from
// dig.js) if other resources should become sellable too.
const SELLABLE = {
    fish: { name: "Fish", value: FISH_VALUE, emoji: "🐟" },
    golden_fish: { name: "Golden Fish", value: GOLDEN_FISH_VALUE, emoji: "🐠" }
};

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

function randomAmount(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Checks the user's own inventory first, then their married partner's —
// married couples share tool access.
function hasFishingRod(userId, inventory) {

    const items = inventory[userId] || [];
    if (items.some(it => it.id === "fishing_rod")) return true;

    const users = loadUsers();
    const partner = getPartner(userId, users);

    if (partner) {
        const partnerItems = inventory[partner] || [];
        return partnerItems.some(it => it.id === "fishing_rod");
    }

    return false;

}

// Adds quantity to an existing stackable item, or creates a new stack entry
function addStackable(inventory, userId, itemDef, quantity) {

    if (!inventory[userId]) inventory[userId] = [];

    const existing = inventory[userId].find(it => it.id === itemDef.id);

    if (existing) {
        existing.quantity = (existing.quantity || 0) + quantity;
        existing.obtainedAt = Date.now();
    } else {
        inventory[userId].push({
            ...itemDef,
            quantity,
            obtainedFrom: "fishing",
            obtainedAt: Date.now()
        });
    }

}

// ---------- .fish — requires fishing_rod, 2 min cooldown ----------
async function fishCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const inventory = loadInventory();

    if (!hasFishingRod(sender, inventory)) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `🎣 You need a Fishing Rod to fish.\n\nGrab one from .shop`
        }, { quoted: msg });
    }

    const remaining = checkCooldown(sender, "fish", COOLDOWN_MS);

    if (remaining) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⏳ Your line's still out. Try again in ${Math.ceil(remaining / 1000)}s.`
        }, { quoted: msg });
    }

    const roll = Math.random();
    let text;

    if (roll < 0.35) {

        // Nothing
        text = `🎣 *FISHING* — NOTHING\nYou fished all day and found nothing.`;

    } else if (roll < 0.90) {

        // Regular fish
        const count = randomAmount(1, 5);

        addStackable(inventory, sender, {
            id: "fish",
            name: "Fish",
            type: "resource",
            value: FISH_VALUE
        }, count);

        saveInventory(inventory);

        text =
`🎣 *FISHING* — CAUGHT!
You caught ${count} fish${count > 1 ? "es" : ""}! 🐟
💎 Worth: ${FISH_VALUE.toLocaleString()} 🌙 each
📦 Added to your inventory — use .sell fish when it's ready.`;

    } else {

        // Golden fish
        addStackable(inventory, sender, {
            id: "golden_fish",
            name: "Golden Fish",
            type: "resource",
            value: GOLDEN_FISH_VALUE
        }, 1);

        saveInventory(inventory);

        text =
`🎣 *FISHING* — RARE CATCH! ✨
You reeled in a Golden Fish! 🐠✨
💎 Worth: ${GOLDEN_FISH_VALUE.toLocaleString()} 🌙
📦 Added to your inventory — use .sell golden_fish when it's ready.`;

    }

    setCooldown(sender, "fish");

    return await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });

}

// ---------- .sell <item> <amount|all> — e.g. .sell fish 3 / .sell golden_fish all ----------
async function sellCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You are not registered.\n\nUse:\n\n.register YOUR_NAME`
        }, { quoted: msg });
    }

    const args = text.replace(".sell", "").trim().split(/\s+/).filter(Boolean);
    const itemId = (args[0] || "").toLowerCase();
    const amountArg = args[1];

    const item = SELLABLE[itemId];

    if (!item) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text:
`⚠️ Usage:

.sell fish AMOUNT
.sell golden_fish AMOUNT

Or sell everything you have:

.sell fish all
.sell golden_fish all`
        }, { quoted: msg });
    }

    const inventory = loadInventory();
    const items = inventory[sender] || [];
    const stack = items.find(it => it.id === itemId);
    const owned = stack ? (stack.quantity || 0) : 0;

    if (owned <= 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have any ${item.name} to sell.`
        }, { quoted: msg });
    }

    if (!amountArg) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Specify an amount.\n\nExample:\n\n.sell ${itemId} 3\n.sell ${itemId} all\n\n📦 You have: ${owned} ${item.name}`
        }, { quoted: msg });
    }

    let amount;

    if (amountArg.toLowerCase() === "all") {
        amount = owned;
    } else {
        amount = Number(amountArg);
    }

    if (!Number.isInteger(amount) || amount <= 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Enter a valid whole number amount, or "all".`
        }, { quoted: msg });
    }

    if (amount > owned) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You only have ${owned} ${item.name} — can't sell ${amount}.`
        }, { quoted: msg });
    }

    const total = amount * item.value;

    stack.quantity -= amount;

    if (stack.quantity <= 0) {
        inventory[sender] = items.filter(it => it.id !== itemId);
    }

    saveInventory(inventory);

    users[sender].wallet += total;
    saveUsers(users);

    await sock.sendMessage(msg.key.remoteJid, {
        text:
`${item.emoji} *SOLD!*
» Item    : ${item.name} x${amount}
» Earned  : ${total.toLocaleString()} 🌙
» Wallet  : ${users[sender].wallet.toLocaleString()} 🌙`
    }, { quoted: msg });

}

module.exports = { fishCommand, sellCommand };