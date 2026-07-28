const fs = require("fs");

const { loadCollection } = require("../commands/card.js");
const { TIER_ICONS } = require("../commands/card.js");
const { getActiveSpawn, removeSpawn } = require("../lib/spawnManager");

const COLLECTION_FILE = "./collection.json";

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
    const icon = TIER_ICONS[card.tier] || "⚪";

    await sock.sendMessage(chatJid, {
        text:
`🎉 ${claimerName} claimed a card!
${icon} ${card.name} [${card.tier}]
📚 ${card.series}
🆔 #${spawn.cardId}

Added to your collection! Use .col to view.`
    }, { quoted: msg });

}

module.exports = { execute };
