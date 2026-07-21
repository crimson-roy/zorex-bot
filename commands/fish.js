const { checkCooldown, setCooldown } = require("./cooldown");
const { loadInventory, saveInventory } = require("./inventory");

const COOLDOWN_MS = 120000; // 2 minutes

const FISH_VALUE = 5000;
const GOLDEN_FISH_VALUE = 15000;

function randomAmount(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function hasFishingRod(userId, inventory) {
    const items = inventory[userId] || [];
    return items.some(it => it.id === "fishing_rod");
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

module.exports = { fishCommand };