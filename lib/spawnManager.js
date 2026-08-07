const fs = require("fs");

const {
    loadCards,
    TIER_ICONS,
    TIER_LABELS
} = require("../commands/card.js");

const { prepareVideo } = require("./videoHelper");

const dataPath = require("../lib/dataPath");

const SPAWN_FILE = dataPath("spawnedCards.json");
const CARD_SETTINGS_FILE = dataPath("cardSettings.json");

// A spawned card stays claimable for 30 minutes.
const SPAWN_DURATION_MS = 30 * 60 * 1000;

// ---------- Tier weights ----------
// These are normalized weighted chances:
//
// UR  = 4.8%
// SSR = 8.8%
// SR  = 12.8%
// S   = 16.8%
// R   = 20.8%
// C   = 36.0%
//
// Original weights were:
// UR 6
// SSR 11
// SR 16
// S 21
// R 26
// C 45
//
// Total = 125
//
// The values below are cumulative percentages out of 100.
const TIER_WEIGHTS = [
    { tier: "UR", weight: 4.8 },
    { tier: "SSR", weight: 8.8 },
    { tier: "SR", weight: 12.8 },
    { tier: "S", weight: 16.8 },
    { tier: "R", weight: 20.8 },
    { tier: "C", weight: 36.0 }
];

// ---------- Claim price ranges ----------
const TIER_PRICE_RANGES = {
    C: {
        min: 40000,
        max: 80000
    },

    R: {
        min: 80000,
        max: 130000
    },

    S: {
        min: 130000,
        max: 220000
    },

    SR: {
        min: 220000,
        max: 300000
    },

    SSR: {
        min: 300000,
        max: 380000
    },

    UR: {
        min: 380000,
        max: 500000
    }
};

// ---------- spawnedCards.json storage ----------

function loadSpawns() {

    if (!fs.existsSync(SPAWN_FILE)) {
        fs.writeFileSync(SPAWN_FILE, "{}");
    }

    return JSON.parse(fs.readFileSync(SPAWN_FILE, "utf8"));
}

function saveSpawns(spawns) {

    fs.writeFileSync(
        SPAWN_FILE,
        JSON.stringify(spawns, null, 4)
    );
}

// ---------- card settings storage ----------

function loadCardSettings() {

    if (!fs.existsSync(CARD_SETTINGS_FILE)) {
        fs.writeFileSync(CARD_SETTINGS_FILE, "{}");
    }

    return JSON.parse(
        fs.readFileSync(CARD_SETTINGS_FILE, "utf8")
    );
}

function saveCardSettings(settings) {

    fs.writeFileSync(
        CARD_SETTINGS_FILE,
        JSON.stringify(settings, null, 4)
    );
}

// Returns true when automatic spawning is enabled for a chat.
function isAutoSpawnEnabled(chatJid) {

    const settings = loadCardSettings();

    // Default = enabled
    return settings[chatJid]?.autoSpawn !== false;
}

function setAutoSpawnEnabled(chatJid, enabled) {

    const settings = loadCardSettings();

    if (!settings[chatJid]) {
        settings[chatJid] = {};
    }

    settings[chatJid].autoSpawn = enabled;

    saveCardSettings(settings);

    return enabled;
}

// ---------- active spawn ----------

function getActiveSpawn(chatJid) {

    const spawns = loadSpawns();
    const spawn = spawns[chatJid];

    if (!spawn) return null;

    if (Date.now() >= spawn.expiresAt) {

        delete spawns[chatJid];

        saveSpawns(spawns);

        return null;
    }

    return spawn;
}

function hasActiveSpawn(chatJid) {

    return getActiveSpawn(chatJid) !== null;
}

function removeSpawn(chatJid) {

    const spawns = loadSpawns();

    if (spawns[chatJid]) {

        delete spawns[chatJid];

        saveSpawns(spawns);
    }
}

// ---------- card selection ----------

function getCardById(cardId) {

    const cards = loadCards();

    return cards[cardId]
        ? [cardId, cards[cardId]]
        : null;
}

function getRandomCard() {

    const cards = loadCards();

    const entries = Object.entries(cards);

    if (entries.length === 0) return null;

    return entries[
        Math.floor(Math.random() * entries.length)
    ];
}

function getRandomCardByTier(tier) {

    const cards = loadCards();

    const entries = Object.entries(cards)
        .filter(([id, card]) => card.tier === tier);

    if (entries.length === 0) return null;

    return entries[
        Math.floor(Math.random() * entries.length)
    ];
}

// Selects a tier using the normalized weighted probabilities.
function getRandomTier() {

    const roll = Math.random() * 100;

    let cumulative = 0;

    for (const entry of TIER_WEIGHTS) {

        cumulative += entry.weight;

        if (roll < cumulative) {
            return entry.tier;
        }
    }

    // Safety fallback
    return "C";
}

// Automatically chooses a tier first,
// then chooses a random card inside that tier.
function getRandomWeightedCard() {

    const selectedTier = getRandomTier();

    let picked = getRandomCardByTier(selectedTier);

    // If that tier has no cards, fall back to another
    // available tier rather than failing the spawn.
    if (picked) {
        return picked;
    }

    const cards = loadCards();

    const availableTiers = [
        "UR",
        "SSR",
        "SR",
        "S",
        "R",
        "C"
    ].filter(tier =>
        Object.values(cards).some(card => card.tier === tier)
    );

    if (availableTiers.length === 0) {
        return null;
    }

    const fallbackTier =
        availableTiers[
            Math.floor(
                Math.random() * availableTiers.length
            )
        ];

    return getRandomCardByTier(fallbackTier);
}

// ---------- value generation ----------

function randomValueInRange(min, max) {

    return Math.floor(
        Math.random() * (max - min + 1)
    ) + min;
}

function getClaimPriceForTier(tier) {

    const range = TIER_PRICE_RANGES[tier];

    if (!range) {
        return 0;
    }

    return randomValueInRange(
        range.min,
        range.max
    );
}

// ---------- creating spawn ----------

function createSpawn(chatJid, cardId, card) {

    const now = Date.now();

    const value = getClaimPriceForTier(card.tier);

    const spawn = {
        cardId,
        card,
        value,
        spawnedAt: now,
        expiresAt: now + SPAWN_DURATION_MS,
        groupJid: chatJid
    };

    const spawns = loadSpawns();

    spawns[chatJid] = spawn;

    saveSpawns(spawns);

    return spawn;
}

// ---------- announcement ----------

function formatSpawnAnnouncement(spawn) {

    const {
        cardId,
        card,
        value
    } = spawn;

    const icon =
        TIER_ICONS[card.tier] || "⚪";

    return (
`🎴 A card has appeared!
┌─────────────────────
│ ${icon} ${card.name} [${card.tier}]
│ 📚 ${card.series}
│ 💎 Claim Price: ${value.toLocaleString()} Crescents
│ 🆔 #${cardId}
└─────────────────────
⏳ Type .claim #${cardId} within 30 minutes to grab it!`
    );
}

async function announceSpawn(
    sock,
    chatJid,
    spawn
) {

    const caption =
        formatSpawnAnnouncement(spawn);

    const card = spawn.card;

    if (
        card.video &&
        fs.existsSync(card.video)
    ) {

        let videoPath = card.video;

        try {

            videoPath =
                await prepareVideo(card.video);

        } catch (err) {

            console.error(
                "⚠️ prepareVideo failed, sending original file:",
                err.message
            );
        }

        await sock.sendMessage(
            chatJid,
            {
                video: fs.readFileSync(videoPath),
                caption,
                gifPlayback: true
            }
        );

    } else if (
        card.image &&
        fs.existsSync(card.image)
    ) {

        await sock.sendMessage(
            chatJid,
            {
                image: fs.readFileSync(card.image),
                caption
            }
        );

    } else {

        await sock.sendMessage(
            chatJid,
            {
                text: caption
            }
        );
    }
}

module.exports = {
    SPAWN_DURATION_MS,

    TIER_WEIGHTS,
    TIER_PRICE_RANGES,

    loadCardSettings,
    saveCardSettings,
    isAutoSpawnEnabled,
    setAutoSpawnEnabled,

    getActiveSpawn,
    hasActiveSpawn,
    removeSpawn,

    getCardById,
    getRandomCard,
    getRandomCardByTier,
    getRandomTier,
    getRandomWeightedCard,

    randomValueInRange,
    getClaimPriceForTier,

    createSpawn,
    formatSpawnAnnouncement,
    announceSpawn
};