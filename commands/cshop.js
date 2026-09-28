const fs = require("fs");

const dataPath = require("../lib/dataPath");
const {
    loadCards,
    TIER_ICONS
} = require("./card");

const {
    loadCollection,
    saveCollection
} = require("./inventory");

const USERS_FILE = dataPath("users.json");
const CSHOP_FILE = dataPath("cardShop.json");
const CSHOP_HISTORY_FILE = dataPath("cardShopHistory.json");

const SLOT_COUNT = 6;

// Once somebody buys a card from CShop, that card cannot
// appear in CShop again for 120 hours / 5 days.
const CSHOP_CARD_COOLDOWN_MS =
    120 * 60 * 60 * 1000;

// Card-shop rarity.
// Slightly more generous than natural spawns because cards cost Crescents.
const CSHOP_WEIGHTS = [
    { tier: "UR",  weight: 1 },
    { tier: "SSR", weight: 4 },
    { tier: "SR",  weight: 8 },
    { tier: "S",   weight: 17 },
    { tier: "R",   weight: 30 },
    { tier: "C",   weight: 40 }
];

const FALLBACK_PRICE = {
    C: 80000,
    R: 130000,
    S: 220000,
    SR: 300000,
    SSR: 380000,
    UR: 500000
};

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, "{}");
    }

    return JSON.parse(
        fs.readFileSync(USERS_FILE, "utf8")
    );
}

function saveUsers(users) {
    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify(users, null, 4)
    );
}

function loadShopState() {
    if (!fs.existsSync(CSHOP_FILE)) {
        return null;
    }

    try {
        return JSON.parse(
            fs.readFileSync(CSHOP_FILE, "utf8")
        );
    } catch {
        return null;
    }
}

function saveShopState(state) {
    fs.writeFileSync(
        CSHOP_FILE,
        JSON.stringify(state, null, 4)
    );
}


function getLagosDateKey(now = Date.now()) {

    // Nigeria is UTC+1 and does not use DST.
    const d = new Date(
        now + (60 * 60 * 1000)
    );

    const year = d.getUTCFullYear();
    const month =
        String(d.getUTCMonth() + 1)
            .padStart(2, "0");
    const day =
        String(d.getUTCDate())
            .padStart(2, "0");

    return `${year}-${month}-${day}`;
}


function getNextLagosMidnight(now = Date.now()) {

    const d = new Date(
        now + (60 * 60 * 1000)
    );

    // Midnight Lagos = 23:00 UTC.
    return (
        Date.UTC(
            d.getUTCFullYear(),
            d.getUTCMonth(),
            d.getUTCDate() + 1,
            0,
            0,
            0
        ) -
        (60 * 60 * 1000)
    );
}


function loadCardShopHistory() {

    if (!fs.existsSync(CSHOP_HISTORY_FILE)) {

        fs.writeFileSync(
            CSHOP_HISTORY_FILE,
            "{}"
        );

    }

    let history;

    try {

        history = JSON.parse(
            fs.readFileSync(
                CSHOP_HISTORY_FILE,
                "utf8"
            )
        );

    } catch (err) {

        console.error(
            "⚠️ Failed to read cardShopHistory.json:",
            err.message
        );

        history = {};

    }

    return pruneCardShopHistory(history);
}


function saveCardShopHistory(history) {

    fs.writeFileSync(
        CSHOP_HISTORY_FILE,
        JSON.stringify(
            history,
            null,
            4
        )
    );

}


function pruneCardShopHistory(history) {

    const now = Date.now();
    let changed = false;

    for (const [cardId, boughtAt] of
        Object.entries(history || {})) {

        if (
            !Number.isFinite(Number(boughtAt)) ||
            now - Number(boughtAt) >=
                CSHOP_CARD_COOLDOWN_MS
        ) {

            delete history[cardId];
            changed = true;

        }

    }

    if (changed) {
        saveCardShopHistory(history);
    }

    return history;
}


function isCardOnShopCooldown(
    cardId,
    history = null
) {

    history =
        history || loadCardShopHistory();

    const boughtAt =
        Number(history[cardId]);

    if (!boughtAt) {
        return false;
    }

    return (
        Date.now() - boughtAt <
        CSHOP_CARD_COOLDOWN_MS
    );
}


function recordCardShopPurchase(cardId) {

    const history =
        loadCardShopHistory();

    history[cardId] =
        Date.now();

    saveCardShopHistory(history);

}


function isDefaultCard(card) {
    const eventName =
        String(card?.eventName || "").toLowerCase();

    return !eventName || eventName === "default";
}

function randomTier() {
    const roll = Math.random() * 100;
    let current = 0;

    for (const entry of CSHOP_WEIGHTS) {
        current += entry.weight;

        if (roll < current) {
            return entry.tier;
        }
    }

    return "C";
}

function calculatePrice(card) {
    const tier =
        String(card.tier || "C").toUpperCase();

    const base =
        Number(card.valueMax) ||
        Number(card.valueMin) ||
        FALLBACK_PRICE[tier] ||
        100000;

    // Shop cards cost more than a lucky natural spawn.
    return Math.ceil(
        (base * 1.35) / 1000
    ) * 1000;
}

function pickCard(
    cards,
    tier,
    usedIds,
    history
) {

    const entries =
        Object.entries(cards)
            .filter(([id, card]) =>
                !usedIds.has(id) &&
                !isCardOnShopCooldown(
                    id,
                    history
                ) &&
                isDefaultCard(card) &&
                String(card.tier || "")
                    .toUpperCase() === tier
            );

    if (!entries.length) {
        return null;
    }

    return entries[
        Math.floor(
            Math.random() *
            entries.length
        )
    ];
}


function createRotation() {

    const cards = loadCards();
    const history =
        loadCardShopHistory();

    const usedIds = new Set();
    const slots = [];

    const availableDefaultCards =
        Object.entries(cards)
            .filter(([id, card]) =>
                isDefaultCard(card) &&
                !isCardOnShopCooldown(
                    id,
                    history
                )
            );

    for (
        let slotNumber = 1;
        slotNumber <= SLOT_COUNT;
        slotNumber++
    ) {

        let picked = null;

        // Try the weighted tier system first.
        for (
            let attempt = 0;
            attempt < 20;
            attempt++
        ) {

            const tier = randomTier();

            picked = pickCard(
                cards,
                tier,
                usedIds,
                history
            );

            if (picked) break;

        }

        // Fallback to any eligible card.
        if (!picked) {

            const remaining =
                availableDefaultCards
                    .filter(
                        ([id]) =>
                            !usedIds.has(id)
                    );

            if (!remaining.length) {
                break;
            }

            picked =
                remaining[
                    Math.floor(
                        Math.random() *
                        remaining.length
                    )
                ];

        }

        const [cardId, card] =
            picked;

        usedIds.add(cardId);

        slots.push({
            slot: slotNumber,
            cardId,
            tier:
                String(
                    card.tier || "C"
                ).toUpperCase(),
            price:
                calculatePrice(card)
        });

    }

    const now = Date.now();

    const state = {
        rotationId:
            `cshop_${getLagosDateKey(now)}`,
        rotationDate:
            getLagosDateKey(now),
        createdAt: now,
        expiresAt:
            getNextLagosMidnight(now),
        slots
    };

    saveShopState(state);

    return state;
}


function getCurrentRotation() {

    let state =
        loadShopState();

    const today =
        getLagosDateKey();

    if (
        !state ||
        !Array.isArray(state.slots) ||
        state.rotationDate !== today ||
        Date.now() >=
            Number(state.expiresAt || 0)
    ) {

        state =
            createRotation();

    }

    return state;
}


function remainingTime(expiresAt) {
    const left =
        Math.max(
            0,
            expiresAt - Date.now()
        );

    const hours =
        Math.floor(
            left / (60 * 60 * 1000)
        );

    const minutes =
        Math.floor(
            (left % (60 * 60 * 1000)) /
            (60 * 1000)
        );

    return `${hours}h ${minutes}m`;
}

function buildShopText(state) {

    const cards =
        loadCards();

    const lines = [
        "╭── 🎴 *ZOREX CARD SHOP* ──╮",
        "",
        "🌙 New cards every day at 12:00 AM.",
        ""
    ];

    if (!state.slots.length) {

        lines.push(
            "🚫 All cards for today have been sold."
        );

        lines.push("");

    }

    for (const slot of state.slots) {

        const card =
            cards[slot.cardId];

        if (!card) continue;

        const icon =
            TIER_ICONS[slot.tier] ||
            "⚪";

        lines.push(
`${icon} *[${slot.slot}] ${card.name}*
├─ 🏷️ ${slot.tier}
├─ 📚 ${card.series || "Unknown"}
├─ 🆔 #${slot.cardId}
└─ 💰 ${slot.price.toLocaleString()} 🌙`
        );

        lines.push("");

    }

    lines.push(
        `⏳ Next reset: ${remainingTime(state.expiresAt)}`
    );

    lines.push(
        "",
        "🛒 Buy with:",
        ".cshop buy <slot>",
        "Example: .cshop buy 3",
        "",
        "⚠️ Each card has only one shop copy.",
        "A purchased card won't return for 120 hours.",
        "",
        "╰── 🤖 Powered by Zorex ──╯"
    );

    return lines.join("\n");
}


async function cshopCommands(sock, msg, text) {
    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const chatJid =
        msg.key.remoteJid;

    const state =
        getCurrentRotation();

    if (text.trim() === ".cshop") {
        return sock.sendMessage(
            chatJid,
            {
                text:
                    buildShopText(
                        state
                    )
            },
            { quoted: msg }
        );
    }

    const parts =
        text.trim().split(/\s+/);

    if (
        parts[0] !== ".cshop" ||
        parts[1] !== "buy"
    ) {
        return;
    }

    const slotNumber =
        Number(parts[2]);

    if (
        !Number.isInteger(slotNumber) ||
        slotNumber < 1
    ) {
        return sock.sendMessage(
            chatJid,
            {
                text:
                    "⚠️ Usage: .cshop buy <slot>\nExample: .cshop buy 2"
            },
            { quoted: msg }
        );
    }

    const slot =
        state.slots.find(
            entry =>
                entry.slot ===
                slotNumber
        );

    if (!slot) {
        return sock.sendMessage(
            chatJid,
            {
                text:
                    "❌ That card-shop slot does not exist."
            },
            { quoted: msg }
        );
    }

    const users = loadUsers();
    const user = users[sender];

    if (!user) {
        return sock.sendMessage(
            chatJid,
            {
                text:
                    "❌ You need a Zorex profile first. Use .register"
            },
            { quoted: msg }
        );
    }

    const wallet =
        Number(user.wallet) || 0;

    if (wallet < slot.price) {
        return sock.sendMessage(
            chatJid,
            {
                text:
`❌ Not enough Crescents.

💰 Price: ${slot.price.toLocaleString()} 🌙
👛 Wallet: ${wallet.toLocaleString()} 🌙
📉 Needed: ${(slot.price - wallet).toLocaleString()} 🌙`
            },
            { quoted: msg }
        );
    }

    const cards = loadCards();
    const card =
        cards[slot.cardId];

    if (!card) {
        return sock.sendMessage(
            chatJid,
            {
                text:
                    "❌ That card no longer exists in card.json."
            },
            { quoted: msg }
        );
    }

    const collection =
        loadCollection();

    if (!collection[sender]) {
        collection[sender] = [];
    }

    user.wallet =
        wallet - slot.price;

    collection[sender].push({
        id: slot.cardId,
        name: card.name,
        type: card.type || "card",
        tier: card.tier,
        series: card.series,
        image: card.image || null,
        video: card.video || null,
        obtainedFrom: "card_shop",
        obtainedAt: Date.now()
    });

    saveUsers(users);
    saveCollection(collection);

    // Remove this exact card from today's shop for everybody.
    state.slots =
        state.slots.filter(
            entry =>
                entry.slot !== slot.slot
        );

    // Keep it out of future CShop rotations for 120 hours.
    recordCardShopPurchase(
        slot.cardId
    );

    saveShopState(state);

    const icon =
        TIER_ICONS[slot.tier] || "🎴";

    return sock.sendMessage(
        chatJid,
        {
            text:
`✅ *CARD PURCHASED!*

${icon} ${card.name}
🏷️ Tier: ${slot.tier}
📚 ${card.series || "Unknown"}
🆔 #${slot.cardId}

💰 Paid: ${slot.price.toLocaleString()} 🌙
👛 Remaining: ${user.wallet.toLocaleString()} 🌙

🎴 Added to your collection.`
        },
        { quoted: msg }
    );
}

module.exports = {
    cshopCommands
};
