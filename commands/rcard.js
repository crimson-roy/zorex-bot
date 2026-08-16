const fs = require("fs");

const { loadCards, findOwners, sendCardDisplay } = require("./card.js");
const { MAIN_OWNER } = require("../config");

const dataPath = require("../lib/dataPath");
const COLLECTION_FILE = dataPath("collection.json");

// PERSISTENCE FIX: this was a bare "./owners.json" — the ephemeral
// container disk, not the mounted volume dataPath() resolves to on
// Railway. That meant any owner added via .addowner (which correctly
// writes through dataPath()) would pass isOwner() everywhere else in the
// bot but silently fail it here — a split-brain permission bug. Routed
// through dataPath() so this reads the same persistent owners.json every
// other command checks. See lib/dataPath.js.
const OWNERS_FILE = dataPath("owners.json");


// ---------- owner check ----------
function loadOwners() {

    if (!fs.existsSync(OWNERS_FILE)) {
        fs.writeFileSync(OWNERS_FILE, "[]");
    }

    return JSON.parse(fs.readFileSync(OWNERS_FILE, "utf8"));

}

function isOwner(userId) {

    if (MAIN_OWNER && userId === MAIN_OWNER) return true;

    return loadOwners().includes(userId);

}


// ---------- collection helpers ----------
function loadCollection() {

    if (!fs.existsSync(COLLECTION_FILE)) {
        fs.writeFileSync(COLLECTION_FILE, "{}");
    }

    return JSON.parse(fs.readFileSync(COLLECTION_FILE, "utf8"));

}

function saveCollection(collection) {

    fs.writeFileSync(COLLECTION_FILE, JSON.stringify(collection, null, 4));

}


// ---------- small helpers, same shape used in give.js / addcard.js ----------
function getContextInfo(msg) {

    const m = msg.message || {};

    return (m.extendedTextMessage && m.extendedTextMessage.contextInfo) || {};

}

function getMentionedJids(msg) {

    const ctx = getContextInfo(msg);

    return ctx.mentionedJid || [];

}

function getSenderId(msg) {

    return msg.key.participant || msg.key.remoteJid;

}


// ---------- .rcard <CARD_ID> @user ----------
async function removeCardCommand(sock, msg, text) {

    const senderId = getSenderId(msg);

    if (!isOwner(senderId)) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have permission to use this command.`
        }, { quoted: msg });

    }

  const context = getContextInfo(msg);
    const mentions = getMentionedJids(msg);

    if (mentions.length > 1) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Please mention exactly one user.`
        }, { quoted: msg });

    }

    // Priority: @mention > reply-to-user > self (no target given at all)
    const recipientId = mentions[0] || context.participant || senderId;

    const args = text.trim().split(/\s+/).filter(Boolean);
    const rawId = args[1];

    if (!rawId) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Usage:\n\n.rcard <CARD_ID> @user\n\nExample:\n.rcard 59e04c5d @user`
        }, { quoted: msg });

    }

    const cardId = rawId.replace(/^#/, "");

    let collection;

    try {

        collection = loadCollection();

    } catch (err) {

        console.error("❌ Failed to load collection.json:", err.message);

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ Something went wrong reading the collection. Try again in a bit.`
        }, { quoted: msg });

    }

    const targetCards = collection[targetId] || [];
    const index = targetCards.findIndex(c => c.id === cardId);

    if (index === -1) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ @${targetId.split("@")[0]} doesn't have a card with ID "${cardId}".`,
            mentions: [targetId]
        }, { quoted: msg });

    }

    const [removedCard] = targetCards.splice(index, 1);
    collection[targetId] = targetCards;

    try {

        saveCollection(collection);

    } catch (err) {

        console.error("❌ Failed to save collection.json:", err.message);

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ Couldn't remove the card. Nothing was changed — try again in a bit.`
        }, { quoted: msg });

    }

    // Show exactly which card was taken — same display .cs/.give/.addcard
    // use — so a mistaken removal is immediately obvious rather than just
    // a name in a text line. Prefer full card.json metadata (tier, series,
    // value); fall back to a minimal object built from the removed
    // collection entry itself if the id no longer exists in card.json, so
    // display never blocks the (already-saved) removal from being
    // confirmed.
    const cards = loadCards();
    const cardMeta = cards[cardId] || {
        name: removedCard.name || cardId,
        series: "Unknown",
        tier: "C",
        valueMin: 0,
        valueMax: 0,
        type: removedCard.type || "card",
        image: removedCard.image,
        video: removedCard.video
    };

    const owners = findOwners(cardId, collection);

    // NOTE ON THE MENTION FIX: extraText below deliberately does NOT
    // include a literal "@<number>" token for targetId. sendCardDisplay()'s
    // mentions array comes from findOwners(cardId, collection) — i.e.
    // whoever CURRENTLY owns the card. Since the card was just removed,
    // targetId is no longer an owner, so it would never end up in that
    // mentions array even though its "@number" text was sitting in the
    // caption — meaning the tag would render as dead, unhighlighted text.
    // The confirmation of WHO it was taken from is sent as its own
    // follow-up message instead, with an explicit mentions: [targetId],
    // so it's guaranteed to render as a real mention regardless of
    // post-removal ownership.
    const extraText =
`\n\n🗑️ Card Removed by Owner!
✅ Successfully removed from their collection.`;

    try {

        await sendCardDisplay(sock, msg, cardId, cardMeta, owners, extraText);

        await sock.sendMessage(msg.key.remoteJid, {
            text: `👤 Removed from: @${targetId.split("@")[0]}`,
            mentions: [targetId]
        }, { quoted: msg });

    } catch (err) {

        // The removal already succeeded and was saved — a display error
        // here should never look like the removal failed.
        console.error("⚠️ Card display failed after successful removal:", err.message);

        await sock.sendMessage(msg.key.remoteJid, {
            text:
`🗑️ Card Removed by Owner!
👤 From: @${targetId.split("@")[0]}
🎴 Card: ${cardMeta.name}
🆔 #${cardId}
✅ Successfully removed from their collection.`,
            mentions: [targetId]
        }, { quoted: msg });

    }

}

module.exports = {
    removeCardCommand
};