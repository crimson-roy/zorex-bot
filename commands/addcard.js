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


// ---------- small helpers, same shape used in give.js ----------
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


// ---------- .addcard <CARD_ID> @user ----------
async function addCardCommand(sock, msg, text) {

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
            text: `⚠️ Usage:\n\n.addcard <CARD_ID> @user\n\nExample:\n.addcard 59e04c5d @user`
        }, { quoted: msg });

    }

    const cardId = rawId.replace(/^#/, "");

    const cards = loadCards();
    const card = cards[cardId];

    if (!card) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ No card exists with ID "${cardId}". Check card.json.`
        }, { quoted: msg });

    }

    let collection;

    try {

        collection = loadCollection();

    } catch (err) {

        console.error("❌ Failed to load collection.json:", err.message);

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ Something went wrong reading the collection. Try again in a bit.`
        }, { quoted: msg });

    }

    if (!collection[recipientId]) collection[recipientId] = [];

    collection[recipientId].push({
        id: cardId,
        name: card.name,
        type: card.type || "card",
        image: card.image || null,
        video: card.video || null,
        obtainedFrom: "owner_gift",
        obtainedAt: Date.now()
    });

    try {

        saveCollection(collection);

    } catch (err) {

        console.error("❌ Failed to save collection.json:", err.message);

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ Couldn't save the card. Nothing was changed — try again in a bit.`
        }, { quoted: msg });

    }

    const owners = findOwners(cardId, collection);

    const extraText =
`\n\n🎁 Card Added by Owner!
👤 Recipient: @${recipientId.split("@")[0]}
✨ Successfully added to their collection!`;

    try {

        await sendCardDisplay(sock, msg, cardId, card, owners, extraText);

    } catch (err) {

        console.error("⚠️ Card display failed after successful add:", err.message);

        await sock.sendMessage(msg.key.remoteJid, {
            text: `🎁 Card Added!\n👤 @${recipientId.split("@")[0]} received "${card.name}".`,
            mentions: [recipientId]
        }, { quoted: msg });

    }

}

module.exports = {
    addCardCommand
};