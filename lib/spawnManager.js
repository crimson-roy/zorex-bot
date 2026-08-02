const fs = require("fs");

// Reuse the existing card system exactly as-is — no new card storage, no
// new tier/icon mappings. loadCards() plus TIER_ICONS/TIER_LABELS come
// straight from commands/card.js (already exported there).
const { loadCards, TIER_ICONS, TIER_LABELS } = require("../commands/card.js");

// Same video-conversion helper card.js's sendCardDisplay() uses, so a
// spawned card's video plays back the same way a .cs/.claim display does
// (converted to a WhatsApp-friendly vertical MP4, cached after first use).
const { prepareVideo } = require("./videoHelper");

// PERSISTENCE FIX: this file used to hardcode "./spawnedCards.json". An
// active spawn is real game state (a claimable card with a live expiry
// timer) — losing it on every redeploy means a card mid-claim just
// vanishes with no way to get it back. Route through the same dataPath()
// every other persistent JSON file in the bot uses. See lib/dataPath.js.
const dataPath = require("../lib/dataPath");
const SPAWN_FILE = dataPath("spawnedCards.json");

// A spawned card stays claimable for 2 hours.
const SPAWN_DURATION_MS = 2 * 60 * 60 * 1000;


// ---------- spawnedCards.json storage ----------
// Shape: { "<chatJid>": { cardId, card, value, spawnedAt, expiresAt, groupJid } }
// One key per chat, which is what gives us "only one active card per
// group at a time" — creating a new spawn for a chat overwrites the old
// key, and callers are expected to check hasActiveSpawn() first.

function loadSpawns() {

    if (!fs.existsSync(SPAWN_FILE)) {
        fs.writeFileSync(SPAWN_FILE, "{}");
    }

    return JSON.parse(fs.readFileSync(SPAWN_FILE, "utf8"));

}

function saveSpawns(spawns) {

    fs.writeFileSync(SPAWN_FILE, JSON.stringify(spawns, null, 4));

}

// Returns the active spawn for a chat, or null if there isn't one / it
// expired (an expired entry is cleaned up on read so it can't linger).
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
    return cards[cardId] ? [cardId, cards[cardId]] : null;

}

function getRandomCard() {

    const cards = loadCards();
    const entries = Object.entries(cards);

    if (entries.length === 0) return null;

    return entries[Math.floor(Math.random() * entries.length)];

}

function getRandomCardByTier(tier) {

    const cards = loadCards();
    const entries = Object.entries(cards).filter(([id, c]) => c.tier === tier);

    if (entries.length === 0) return null;

    return entries[Math.floor(Math.random() * entries.length)];

}

function randomValueInRange(min, max) {

    return Math.floor(Math.random() * (max - min + 1)) + min;

}


// ---------- creating + announcing a spawn ----------

// Builds the active-claim record and saves it. Does NOT check
// hasActiveSpawn() — callers must do that check themselves before calling
// this, so the "one active card per group" rule is enforced at the call
// site (manual spawn, auto spawn) rather than silently here.
function createSpawn(chatJid, cardId, card) {

    const now = Date.now();

    const spawn = {
        cardId,
        card,
        value: randomValueInRange(card.valueMin, card.valueMax),
        spawnedAt: now,
        expiresAt: now + SPAWN_DURATION_MS,
        groupJid: chatJid
    };

    const spawns = loadSpawns();
    spawns[chatJid] = spawn;
    saveSpawns(spawns);

    return spawn;

}

// The single spawn-announcement format — used for both manual .spawn and
// automatic spawns, so a normal user has no way to tell them apart.
function formatSpawnAnnouncement(spawn) {

    const { cardId, card, value } = spawn;
    const icon = TIER_ICONS[card.tier] || "⚪";

    return (
`🎴 A card has appeared!
┌─────────────────────
│ ${icon} ${card.name} [${card.tier}]
│ 📚 ${card.series}
│ 💎 Value: ${value.toLocaleString()} Crescents
│ 🆔 #${cardId}
└─────────────────────
⏳ Type .claim #${cardId} within 2 hours to grab it!`
    );

}

// Sends the spawn announcement WITH the card's image/video, the same way
// .cs/.claim display a card — this was previously text-only, which is the
// bug being fixed here.
//
// This can't just call card.js's sendCardDisplay() directly: that function
// requires a `msg` object (it quotes it and reads msg.key.remoteJid), but
// an automatic spawn (see lib/activityTracker.js) has no triggering
// message to quote — only a chatJid to post into. So the same
// image/video/text-fallback detection logic lives here too, adapted for
// that no-msg case, rather than forcing every caller through a shape that
// only one of the two callers (.spawn) could actually satisfy.
async function announceSpawn(sock, chatJid, spawn) {

    const caption = formatSpawnAnnouncement(spawn);
    const card = spawn.card;

    if (card.video && fs.existsSync(card.video)) {

        let videoPath = card.video;

        try {

            videoPath = await prepareVideo(card.video);

        } catch (err) {

            console.error("⚠️ prepareVideo failed, sending original file:", err.message);

        }

        await sock.sendMessage(chatJid, {
            video: fs.readFileSync(videoPath),
            caption,
            gifPlayback: true
        });

    } else if (card.image && fs.existsSync(card.image)) {

        await sock.sendMessage(chatJid, {
            image: fs.readFileSync(card.image),
            caption
        });

    } else {

        await sock.sendMessage(chatJid, {
            text: caption
        });

    }

}

module.exports = {
    SPAWN_DURATION_MS,
    getActiveSpawn,
    hasActiveSpawn,
    removeSpawn,
    getCardById,
    getRandomCard,
    getRandomCardByTier,
    createSpawn,
    formatSpawnAnnouncement,
    announceSpawn
};