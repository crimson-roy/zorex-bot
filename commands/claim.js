const fs = require("fs");

const { loadCollection, findOwners, sendCardDisplay } = require("../commands/card.js");
const { getActiveSpawn, removeSpawn } = require("../lib/spawnManager");

// PERSISTENCE FIX: this file used to hardcode "./collection.json" for
// writes while commands/card.js's loadCollection() read through
// dataPath() — a split-brain where claimed cards landed on the ephemeral
// container disk instead of the mounted volume. Route through the same
// dataPath() every other collection.json writer uses. See lib/dataPath.js.
const dataPath = require("../lib/dataPath");
const COLLECTION_FILE = dataPath("collection.json");

function saveCollection(collection) {

    fs.writeFileSync(COLLECTION_FILE, JSON.stringify(collection, null, 4));

}

// .claim #CARD_ID
async function execute(sock, msg, args) {

    const chatJid = msg.key.remoteJid;
    const claimerId = msg.key.participant || msg.key.remoteJid;

    const rawId = args[0];

    if (!rawId) {

        return await sock.sendMessage(chatJid, {
            text: `⚠️ Usage:\n\n.claim #CARD_ID\n\nExample:\n.claim #87c6b0e0`
        }, { quoted: msg });

    }

    // Accept both "#87c6b0e0" and "87c6b0e0".
    const claimId = rawId.replace(/^#/, "");

    // getActiveSpawn() auto-clears (and returns null for) an expired spawn,
    // so an expired card is indistinguishable from "no card" here.
    const spawn = getActiveSpawn(chatJid);

    if (!spawn) {

        return await sock.sendMessage(chatJid, {
            text: `⚠️ There's no card to claim right now.`
        }, { quoted: msg });

    }

    if (spawn.cardId !== claimId) {

        return await sock.sendMessage(chatJid, {
            text: `⚠️ That's not the ID of the card currently up for claim here.`
        }, { quoted: msg });

    }

    // Card matches — remove it from the active spawn immediately so a
    // second, near-simultaneous .claim can't also succeed.
    removeSpawn(chatJid);

    let collection;

    try {

        collection = loadCollection();

    } catch (err) {

        console.error("❌ Failed to load collection.json during claim:", err.message);

        return await sock.sendMessage(chatJid, {
            text: `❌ Something went wrong claiming that card. It's no longer available — sorry!`
        }, { quoted: msg });

    }

    const card = spawn.card;

    const claimerCards = collection[claimerId] || [];

    // Preserve the same card-object shape used elsewhere in collection.json.
    claimerCards.push({
        id: spawn.cardId,
        name: card.name,
        type: card.type || "card",
        image: card.image || null,
        video: card.video || null,
        obtainedFrom: "spawn",
        obtainedAt: Date.now()
    });

    collection[claimerId] = claimerCards;

    try {

        saveCollection(collection);

    } catch (err) {

        console.error("❌ Failed to save collection.json during claim:", err.message);

        return await sock.sendMessage(chatJid, {
            text: `❌ Something went wrong saving that card. It's no longer available — sorry!`
        }, { quoted: msg });

    }

    const claimerName = msg.pushName || claimerId.split("@")[0].split(":")[0];

    // Show the claimed card the same way .cs/.addcard do — with its
    // image/video, not just a text summary. This was previously
    // text-only, which is the bug being fixed here. No literal "@number"
    // mention tokens are used in the extra text (claimerName is plain
    // text, not a JID), so there's no dependency on sendCardDisplay's
    // owners-derived mentions list for this to render correctly.
    const owners = findOwners(spawn.cardId, collection);

    const extraText =
`\n\n🎉 ${claimerName} claimed this card!

Added to your collection! Use .col to view.`;

    try {

        await sendCardDisplay(sock, msg, spawn.cardId, card, owners, extraText);

    } catch (err) {

        // The claim already succeeded and was saved — a display error
        // here should never look like the claim failed.
        console.error("⚠️ Card display failed after successful claim:", err.message);

        const icon = "🎴";

        await sock.sendMessage(chatJid, {
            text:
`🎉 ${claimerName} claimed a card!
${icon} ${card.name} [${card.tier}]
📚 ${card.series}
🆔 #${spawn.cardId}

Added to your collection! Use .col to view.`
        }, { quoted: msg });

    }

}

module.exports = { execute };