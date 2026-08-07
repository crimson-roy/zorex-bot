const fs = require("fs");

const {
    loadCollection,
    findOwners,
    sendCardDisplay
} = require("../commands/card.js");

const {
    getActiveSpawn,
    removeSpawn
} = require("../lib/spawnManager");

const dataPath =
    require("../lib/dataPath");

const COLLECTION_FILE =
    dataPath("collection.json");

const USERS_FILE =
    dataPath("users.json");

function saveCollection(collection) {

    fs.writeFileSync(
        COLLECTION_FILE,
        JSON.stringify(collection, null, 4)
    );
}

function loadUsers() {

    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(
            USERS_FILE,
            "{}"
        );
    }

    return JSON.parse(
        fs.readFileSync(
            USERS_FILE,
            "utf8"
        )
    );
}

function saveUsers(users) {

    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify(users, null, 4)
    );
}

// .claim #CARD_ID
async function execute(
    sock,
    msg,
    args
) {

    const chatJid =
        msg.key.remoteJid;

    const claimerId =
        msg.key.participant ||
        msg.key.remoteJid;

    const rawId = args[0];

    if (!rawId) {

        return await sock.sendMessage(
            chatJid,
            {
                text:
`⚠️ Usage:

.claim #CARD_ID

Example:
.claim #87c6b0e0`
            },
            { quoted: msg }
        );
    }

    const claimId =
        rawId.replace(/^#/, "");

    const spawn =
        getActiveSpawn(chatJid);

    if (!spawn) {

        return await sock.sendMessage(
            chatJid,
            {
                text:
                    `⚠️ There's no card to claim right now.`
            },
            { quoted: msg }
        );
    }

    if (spawn.cardId !== claimId) {

        return await sock.sendMessage(
            chatJid,
            {
                text:
                    `⚠️ That's not the ID of the card currently up for claim here.`
            },
            { quoted: msg }
        );
    }

    // ------------------------------
    // Load user economy
    // ------------------------------

    let users;

    try {

        users = loadUsers();

    } catch (err) {

        console.error(
            "❌ Failed to load users.json:",
            err.message
        );

        return await sock.sendMessage(
            chatJid,
            {
                text:
                    `❌ Something went wrong checking your wallet.`
            },
            { quoted: msg }
        );
    }

    const user = users[claimerId];

    if (!user) {

        return await sock.sendMessage(
            chatJid,
            {
                text:
`⚠️ You need to register first.

Use:
.register YOUR_NAME`
            },
            { quoted: msg }
        );
    }

    const price = spawn.value;

    const wallet =
        Number(user.wallet) || 0;

    // ------------------------------
    // Check affordability
    // ------------------------------

    if (wallet < price) {

        return await sock.sendMessage(
            chatJid,
            {
                text:
`❌ You can't afford this card.

🎴 ${spawn.card.name}
🏷️ Tier: ${spawn.card.tier}
💰 Claim Price: ${price.toLocaleString()} 🌙
👛 Your Wallet: ${wallet.toLocaleString()} 🌙
📉 You need: ${(price - wallet).toLocaleString()} 🌙 more.

The card is still available for someone else to claim.`
            },
            { quoted: msg }
        );
    }

    // ------------------------------
    // Load collection
    // ------------------------------

    let collection;

    try {

        collection = loadCollection();

    } catch (err) {

        console.error(
            "❌ Failed to load collection.json:",
            err.message
        );

        return await sock.sendMessage(
            chatJid,
            {
                text:
                    `❌ Something went wrong claiming that card.`
            },
            { quoted: msg }
        );
    }

    // ------------------------------
    // Deduct price
    // ------------------------------

    user.wallet =
        wallet - price;

    // ------------------------------
    // Add card
    // ------------------------------

    const card =
        spawn.card;

    const claimerCards =
        collection[claimerId] || [];

    claimerCards.push({
        id: spawn.cardId,
        name: card.name,
        type: card.type || "card",
        image: card.image || null,
        video: card.video || null,
        obtainedFrom: "spawn",
        obtainedAt: Date.now()
    });

    collection[claimerId] =
        claimerCards;

    // ------------------------------
    // Save both systems
    // ------------------------------

    try {

        saveUsers(users);

        saveCollection(collection);

    } catch (err) {

        console.error(
            "❌ Failed to save claim:",
            err.message
        );

        return await sock.sendMessage(
            chatJid,
            {
                text:
                    `❌ Something went wrong saving your claim.`
            },
            { quoted: msg }
        );
    }

    // Card is now successfully claimed.
    removeSpawn(chatJid);

    const claimerName =
        msg.pushName ||
        claimerId
            .split("@")[0]
            .split(":")[0];

    const owners =
        findOwners(
            spawn.cardId,
            collection
        );

    const extraText =
`\n\n🎉 ${claimerName} claimed this card!

💸 Paid: ${price.toLocaleString()} 🌙
👛 Wallet: ${user.wallet.toLocaleString()} 🌙

Added to your collection! Use .col to view.`;

    try {

        await sendCardDisplay(
            sock,
            msg,
            spawn.cardId,
            card,
            owners,
            extraText
        );

    } catch (err) {

        console.error(
            "⚠️ Card display failed after successful claim:",
            err.message
        );

        await sock.sendMessage(
            chatJid,
            {
                text:
`🎉 ${claimerName} claimed a card!

🎴 ${card.name}
🏷️ ${card.tier}
📚 ${card.series}
🆔 #${spawn.cardId}

💸 Paid: ${price.toLocaleString()} 🌙
👛 Wallet: ${user.wallet.toLocaleString()} 🌙

Added to your collection! Use .col to view.`
            },
            { quoted: msg }
        );
    }
}

module.exports = {
    execute
};