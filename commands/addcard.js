const fs = require("fs");

const { loadCards, findOwners, sendCardDisplay } = require("./card.js");
const { MAIN_OWNER } = require("../config");

const {
    getRandomWeightedCard,
    getRandomCardByTier
} = require("../lib/spawnManager");

const dataPath = require("../lib/dataPath");
const COLLECTION_FILE = dataPath("collection.json");

// ---------- owner check ----------
// Kept here exactly as your current system expects.
function loadOwners() {

    const OWNERS_FILE = dataPath("owners.json");

    if (!fs.existsSync(OWNERS_FILE)) {
        fs.writeFileSync(OWNERS_FILE, "[]");
    }

    return JSON.parse(
        fs.readFileSync(OWNERS_FILE, "utf8")
    );

}

function isOwner(userId) {

    if (MAIN_OWNER && userId === MAIN_OWNER) {
        return true;
    }

    return loadOwners().includes(userId);

}


// ---------- collection helpers ----------

function loadCollection() {

    if (!fs.existsSync(COLLECTION_FILE)) {
        fs.writeFileSync(COLLECTION_FILE, "{}");
    }

    return JSON.parse(
        fs.readFileSync(COLLECTION_FILE, "utf8")
    );

}

function saveCollection(collection) {

    fs.writeFileSync(
        COLLECTION_FILE,
        JSON.stringify(collection, null, 4)
    );

}


// ---------- WhatsApp helpers ----------

function getContextInfo(msg) {

    const m = msg.message || {};

    return (
        m.extendedTextMessage &&
        m.extendedTextMessage.contextInfo
    ) || {};

}

function getMentionedJids(msg) {

    const ctx = getContextInfo(msg);

    return ctx.mentionedJid || [];

}

function getSenderId(msg) {

    return msg.key.participant || msg.key.remoteJid;

}


// ---------- card selection helpers ----------

function getCardsByTier(tier) {

    const cards = loadCards();

    return Object.entries(cards).filter(
        ([, card]) =>
            String(card.tier || "").toUpperCase() === tier
    );

}


// Add one card using the existing weighted spawn system.
//
// This means:
// .addcard 1
//
// uses the exact same tier chances as card spawning.
function getOneWeightedCard() {

    return getRandomWeightedCard();

}


// Add one random card from a specific tier.
function getOneCardByTier(tier) {

    return getRandomCardByTier(tier);

}


// ---------- build collection entry ----------

function createCollectionEntry(cardId, card) {

    return {
        id: cardId,
        name: card.name,
        type: card.type || "card",
        image: card.image || null,
        video: card.video || null,
        obtainedFrom: "owner_gift",
        obtainedAt: Date.now()
    };

}


// ---------- .addcard ----------
//
// Supported forms:
//
// .addcard <CARD_ID>
// .addcard <NUMBER>
// .addcard <TIER> <NUMBER>
// .addcard <TIER> all
// .addcard all
//
// Target priority:
//
// @mention > reply > self
//
async function addCardCommand(sock, msg, text) {

    const senderId = getSenderId(msg);

    if (!isOwner(senderId)) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    `❌ You don't have permission to use this command.`
            },
            { quoted: msg }
        );

    }


    // ---------- target ----------

    const context = getContextInfo(msg);
    const mentions = getMentionedJids(msg);

    if (mentions.length > 1) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    `⚠️ Please mention exactly one user.`
            },
            { quoted: msg }
        );

    }

    // Priority:
    // @mention > reply-to-user > self
    const recipientId =
        mentions[0] ||
        context.participant ||
        senderId;


    // ---------- arguments ----------

    const args = text
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    // Remove the command itself.
    //
    // Example:
    // text = ".addcard C 3"
    // args = [".addcard", "C", "3"]
    const command = (args[0] || "").toLowerCase();

    if (command !== ".addcard") {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    `❌ Invalid command.`
            },
            { quoted: msg }
        );

    }


    // Everything after .addcard
    const input = args.slice(1);

    if (input.length === 0) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ Usage:

.addcard <CARD_ID> @user
.addcard <NUMBER> @user
.addcard <TIER> <NUMBER> @user
.addcard <TIER> all @user
.addcard all @user

Examples:

.addcard 59e04c5d @user
.addcard 47 @user
.addcard C 47 @user
.addcard C all @user
.addcard all @user`
            },
            { quoted: msg }
        );

    }


    // ---------- parse request ----------

    const first = input[0].replace(/^#/, "");
    const second = input[1]
        ? input[1].replace(/^#/, "")
        : null;

    const normalizedFirst = first.toUpperCase();
    const normalizedSecond = second
        ? second.toUpperCase()
        : null;

    const cards = loadCards();

    let selectedCards = [];


    // ==========================================================
    // MODE 1
    // .addcard all
    // ==========================================================

    if (normalizedFirst === "ALL" && !second) {

        selectedCards = Object.entries(cards);

    }


    // ==========================================================
    // MODE 2
    // .addcard <NUMBER>
    //
    // Uses existing weighted chance system.
    //
    // Example:
    // .addcard 47
    // ==========================================================

    else if (
        /^\d+$/.test(first) &&
        !second
    ) {

        const amount = Number(first);

        if (amount <= 0) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
                        `⚠️ The number of cards must be greater than 0.`
                },
                { quoted: msg }
            );

        }

        if (amount > 1000) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
                        `⚠️ You can add a maximum of 1000 cards at once.`
                },
                { quoted: msg }
            );

        }

        for (let i = 0; i < amount; i++) {

            const picked = getOneWeightedCard();

            if (!picked) {
                break;
            }

            selectedCards.push(picked);

        }

        if (selectedCards.length === 0) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
                        `❌ No cards are available to add.`
                },
                { quoted: msg }
            );

        }

    }


    // ==========================================================
    // MODE 3
    // .addcard <TIER> all
    //
    // Example:
    // .addcard C all
    // ==========================================================

    else if (
        normalizedSecond === "ALL" &&
        Object.keys(cards).some(
            id =>
                String(cards[id].tier || "").toUpperCase() ===
                normalizedFirst
        )
    ) {

        const tierCards = getCardsByTier(normalizedFirst);

        if (tierCards.length === 0) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
                        `❌ No cards exist in tier ${normalizedFirst}.`
                },
                { quoted: msg }
            );

        }

        // No duplicates here:
        // "C all" means every C card exactly once.
        selectedCards = tierCards;

    }


    // ==========================================================
    // MODE 4
    // .addcard <TIER> <NUMBER>
    //
    // Example:
    // .addcard C 47
    //
    // Random cards from the requested tier.
    // Duplicates are allowed because cards are collectible items.
    // ==========================================================

    else if (
        second &&
        /^\d+$/.test(second)
    ) {

        const amount = Number(second);
        const tier = normalizedFirst;

        const tierCards = getCardsByTier(tier);

        if (tierCards.length === 0) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
                        `❌ No cards exist in tier ${tier}.`
                },
                { quoted: msg }
            );

        }

        if (amount <= 0) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
                        `⚠️ The number of cards must be greater than 0.`
                },
                { quoted: msg }
            );

        }

        if (amount > 1000) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
                        `⚠️ You can add a maximum of 1000 cards at once.`
                },
                { quoted: msg }
            );

        }

        for (let i = 0; i < amount; i++) {

            const picked = getOneCardByTier(tier);

            if (!picked) {
                break;
            }

            selectedCards.push(picked);

        }

        if (selectedCards.length === 0) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
                        `❌ Couldn't find any cards in tier ${tier}.`
                },
                { quoted: msg }
            );

        }

    }


    // ==========================================================
    // MODE 5
    // .addcard <CARD_ID>
    //
    // Existing behavior.
    // ==========================================================

    else if (!second) {

        const cardId = first;
        const card = cards[cardId];

        if (!card) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
                        `❌ No card exists with ID "${cardId}". Check card.json.`
                },
                { quoted: msg }
            );

        }

        selectedCards = [
            [cardId, card]
        ];

    }


    // ==========================================================
    // INVALID INPUT
    // ==========================================================

    else {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ Invalid .addcard format.

Use:

.addcard <CARD_ID>
.addcard <NUMBER>
.addcard <TIER> <NUMBER>
.addcard <TIER> all
.addcard all`
            },
            { quoted: msg }
        );

    }


    // ==========================================================
    // LOAD COLLECTION
    // ==========================================================

    let collection;

    try {

        collection = loadCollection();

    } catch (err) {

        console.error(
            "❌ Failed to load collection.json:",
            err.message
        );

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    `❌ Something went wrong reading the collection. Try again in a bit.`
            },
            { quoted: msg }
        );

    }


    if (!collection[recipientId]) {
        collection[recipientId] = [];
    }


    // ==========================================================
    // ADD SELECTED CARDS
    // ==========================================================

    const addedCards = [];

    for (const [cardId, card] of selectedCards) {

        const entry = createCollectionEntry(
            cardId,
            card
        );

        collection[recipientId].push(entry);

        addedCards.push({
            id: cardId,
            card
        });

    }


    // ==========================================================
    // SAVE ONCE
    // ==========================================================

    try {

        saveCollection(collection);

    } catch (err) {

        console.error(
            "❌ Failed to save collection.json:",
            err.message
        );

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    `❌ Couldn't save the cards. Nothing was changed — try again in a bit.`
            },
            { quoted: msg }
        );

    }


    // ==========================================================
    // RESULT
    // ==========================================================

    // For one card, preserve your existing beautiful card display.
    if (addedCards.length === 1) {

        const added = addedCards[0];

        const owners = findOwners(
            added.id,
            collection
        );

        const extraText =
`\n\n🎁 Card Added by Owner!
👤 Recipient: @${recipientId.split("@")[0]}
✨ Successfully added to their collection!`;

        try {

            await sendCardDisplay(
                sock,
                msg,
                added.id,
                added.card,
                owners,
                extraText
            );

        } catch (err) {

            console.error(
                "⚠️ Card display failed after successful add:",
                err.message
            );

            await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`🎁 Card Added!
👤 @${recipientId.split("@")[0]} received "${added.card.name}".`,
                    mentions: [recipientId]
                },
                { quoted: msg }
            );

        }

        return;

    }


    // ==========================================================
    // BULK RESULT
    // ==========================================================

    const tierCounts = {};

    for (const { card } of addedCards) {

        const tier =
            String(card.tier || "Unknown").toUpperCase();

        tierCounts[tier] =
            (tierCounts[tier] || 0) + 1;

    }

    const tierSummary = Object.entries(tierCounts)
        .map(([tier, count]) => `│ ${tier}: ${count}`)
        .join("\n");

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🎁 *Cards Added Successfully!*

👤 Recipient: @${recipientId.split("@")[0]}
🎴 Cards Added: ${addedCards.length}

┌─────────────────────
${tierSummary}
└─────────────────────

✨ The cards have been added to their collection.`,
            mentions: [recipientId]
        },
        { quoted: msg }
    );

}


module.exports = {
    addCardCommand
};