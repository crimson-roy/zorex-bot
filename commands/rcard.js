const fs = require("fs");

const { loadCards, findOwners, sendCardDisplay } = require("./card.js");
const { MAIN_OWNER } = require("../config");

const dataPath = require("../lib/dataPath");
const COLLECTION_FILE = dataPath("collection.json");
const OWNERS_FILE = dataPath("owners.json");


// ============================================================
// OWNER CHECK
// ============================================================

function loadOwners() {

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


// ============================================================
// COLLECTION
// ============================================================

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


// ============================================================
// WHATSAPP HELPERS
// ============================================================

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


// ============================================================
// CARD HELPERS
// ============================================================

// Get tier from a collection entry.
//
// We prefer the stored tier when available.
// Older collection entries may only have "type", so if the
// current card still exists we also check cards.json.

function getCollectionCardTier(collectionEntry, cards) {

    if (
        collectionEntry.tier &&
        typeof collectionEntry.tier === "string"
    ) {
        return collectionEntry.tier.toUpperCase();
    }

    const currentCard = cards[collectionEntry.id];

    if (
        currentCard &&
        currentCard.tier
    ) {
        return String(
            currentCard.tier
        ).toUpperCase();
    }

    return null;

}


// ============================================================
// .RCARD COMMAND
//
// Supported:
//
// .rcard <CARD_ID>
// .rcard <NUMBER>
// .rcard <TIER> <NUMBER>
// .rcard <TIER> all
// .rcard all
//
// Target:
//
// @mention > reply > self
// ============================================================

async function removeCardCommand(sock, msg, text) {

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


    // ========================================================
    // TARGET
    // ========================================================

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

    // @mention > reply > self
    const targetId =
        mentions[0] ||
        context.participant ||
        senderId;


    // ========================================================
    // ARGUMENTS
    // ========================================================

    const args = text
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    const command = (
        args[0] || ""
    ).toLowerCase();

    if (command !== ".rcard") {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    `❌ Invalid command.`
            },
            { quoted: msg }
        );

    }

    const input = args
        .slice(1)
        .map(value =>
            value.replace(/^#/, "")
        );

    if (input.length === 0) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ Usage:

.rcard <CARD_ID> @user
.rcard <NUMBER> @user
.rcard <TIER> <NUMBER> @user
.rcard <TIER> all @user
.rcard all @user

Examples:

.rcard 59e04c5d @user
.rcard 3 @user
.rcard C 3 @user
.rcard C all @user
.rcard all @user`
            },
            { quoted: msg }
        );

    }


    const first = input[0];
    const second = input[1] || null;

    const normalizedFirst = first.toUpperCase();
    const normalizedSecond = second
        ? second.toUpperCase()
        : null;


    // ========================================================
    // LOAD COLLECTION
    // ========================================================

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


    const targetCards =
        Array.isArray(collection[targetId])
            ? collection[targetId]
            : [];

    if (targetCards.length === 0) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    `⚠️ @${targetId.split("@")[0]} doesn't have any cards in their collection.`,
                mentions: [targetId]
            },
            { quoted: msg }
        );

    }


    const cards = loadCards();

    let selectedIndexes = [];


    // ========================================================
    // MODE 1
    // .rcard all
    //
    // Remove everything from the collection.
    // ========================================================

    if (
        normalizedFirst === "ALL" &&
        !second
    ) {

        selectedIndexes =
            targetCards.map(
                (_, index) => index
            );

    }


    // ========================================================
    // MODE 2
    // .rcard <NUMBER>
    //
    // Remove N cards from the collection.
    //
    // This is deliberately NOT based on the spawn chance system.
    // We are removing cards the user already owns, so we simply
    // choose N owned cards at random.
    // ========================================================

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

        if (amount > targetCards.length) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`⚠️ @${targetId.split("@")[0]} only has ${targetCards.length} card(s).

You asked to remove ${amount}.`,
                    mentions: [targetId]
                },
                { quoted: msg }
            );

        }

        // Build an index list, shuffle it, then take the amount
        // requested. This guarantees that the same collection
        // position isn't selected twice.
        const indexes = targetCards.map(
            (_, index) => index
        );

        for (
            let i = indexes.length - 1;
            i > 0;
            i--
        ) {

            const j =
                Math.floor(
                    Math.random() * (i + 1)
                );

            [
                indexes[i],
                indexes[j]
            ] = [
                indexes[j],
                indexes[i]
            ];

        }

        selectedIndexes =
            indexes.slice(0, amount);

    }


    // ========================================================
    // MODE 3
    // .rcard <TIER> all
    //
    // Example:
    // .rcard C all
    //
    // Remove every card of that tier the user owns.
    // ========================================================

    else if (
        normalizedSecond === "ALL"
    ) {

        const matchingIndexes = [];

        for (
            let i = 0;
            i < targetCards.length;
            i++
        ) {

            const tier = getCollectionCardTier(
                targetCards[i],
                cards
            );

            if (
                tier === normalizedFirst
            ) {
                matchingIndexes.push(i);
            }

        }

        if (matchingIndexes.length === 0) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`⚠️ @${targetId.split("@")[0]} doesn't have any ${normalizedFirst} cards.`,
                    mentions: [targetId]
                },
                { quoted: msg }
            );

        }

        selectedIndexes = matchingIndexes;

    }


    // ========================================================
    // MODE 4
    // .rcard <TIER> <NUMBER>
    //
    // Example:
    // .rcard C 3
    //
    // Remove N randomly selected cards from that tier.
    // ========================================================

    else if (
        second &&
        /^\d+$/.test(second)
    ) {

        const amount = Number(second);

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

        const matchingIndexes = [];

        for (
            let i = 0;
            i < targetCards.length;
            i++
        ) {

            const tier = getCollectionCardTier(
                targetCards[i],
                cards
            );

            if (
                tier === normalizedFirst
            ) {
                matchingIndexes.push(i);
            }

        }

        if (matchingIndexes.length === 0) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`⚠️ @${targetId.split("@")[0]} doesn't have any ${normalizedFirst} cards.`,
                    mentions: [targetId]
                },
                { quoted: msg }
            );

        }

        if (
            amount > matchingIndexes.length
        ) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`⚠️ @${targetId.split("@")[0]} only has ${matchingIndexes.length} ${normalizedFirst} card(s).

You asked to remove ${amount}.`,
                    mentions: [targetId]
                },
                { quoted: msg }
            );

        }

        // Shuffle tier-matching indexes and select the amount.
        for (
            let i = matchingIndexes.length - 1;
            i > 0;
            i--
        ) {

            const j =
                Math.floor(
                    Math.random() * (i + 1)
                );

            [
                matchingIndexes[i],
                matchingIndexes[j]
            ] = [
                matchingIndexes[j],
                matchingIndexes[i]
            ];

        }

        selectedIndexes =
            matchingIndexes.slice(0, amount);

    }


    // ========================================================
    // MODE 5
    // .rcard <CARD_ID>
    //
    // Remove one exact matching collection entry.
    //
    // IMPORTANT:
    // This does NOT require the ID to exist in cards.json.
    //
    // That is what makes this safe for your OLD collection IDs.
    // ========================================================

    else if (!second) {

        const requestedId = first;

        const index =
            targetCards.findIndex(
                card =>
                    String(card.id) ===
                    String(requestedId)
            );

        if (index === -1) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`⚠️ @${targetId.split("@")[0]} doesn't have a card with ID "${requestedId}".`,
                    mentions: [targetId]
                },
                { quoted: msg }
            );

        }

        selectedIndexes = [index];

    }


    // ========================================================
    // INVALID INPUT
    // ========================================================

    else {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ Invalid .rcard format.

Use:

.rcard <CARD_ID>
.rcard <NUMBER>
.rcard <TIER> <NUMBER>
.rcard <TIER> all
.rcard all`
            },
            { quoted: msg }
        );

    }


    // ========================================================
    // REMOVE SELECTED CARDS
    // ========================================================

    // Remove from highest index to lowest index so deleting
    // one entry doesn't shift the indexes of entries we still
    // need to remove.
    selectedIndexes.sort(
        (a, b) => b - a
    );

    const removedCards = [];

    for (const index of selectedIndexes) {

        const [removedCard] =
            targetCards.splice(index, 1);

        if (removedCard) {
            removedCards.push(removedCard);
        }

    }

    collection[targetId] = targetCards;


    // ========================================================
    // SAVE
    // ========================================================

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
                    `❌ Couldn't remove the cards. Nothing was changed — try again in a bit.`
            },
            { quoted: msg }
        );

    }


    // Put cards back into the original-ish order for display.
    removedCards.reverse();


    // ========================================================
    // SINGLE CARD DISPLAY
    // ========================================================

    if (removedCards.length === 1) {

        const removedCard =
            removedCards[0];

        const cardId =
            removedCard.id;

        // IMPORTANT:
        // We first try cards.json.
        // If the old collection ID no longer exists there,
        // use the metadata stored inside collection.json.
        const cardMeta =
            cards[cardId] || {
                name:
                    removedCard.name ||
                    cardId,

                series:
                    removedCard.series ||
                    "Unknown",

                tier:
                    removedCard.tier ||
                    getCollectionCardTier(
                        removedCard,
                        cards
                    ) ||
                    "C",

                valueMin:
                    removedCard.valueMin ||
                    0,

                valueMax:
                    removedCard.valueMax ||
                    0,

                type:
                    removedCard.type ||
                    "card",

                image:
                    removedCard.image ||
                    null,

                video:
                    removedCard.video ||
                    null
            };


        // Since the card was removed, targetId is no longer an owner.
        const owners =
            findOwners(
                cardId,
                collection
            );


        const extraText =
`\n\n🗑️ Card Removed by Owner!
✅ Successfully removed from their collection.`;


        try {

            await sendCardDisplay(
                sock,
                msg,
                cardId,
                cardMeta,
                owners,
                extraText
            );


            await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
                        `👤 Removed from: @${targetId.split("@")[0]}`,
                    mentions: [targetId]
                },
                { quoted: msg }
            );

        } catch (err) {

            console.error(
                "⚠️ Card display failed after successful removal:",
                err.message
            );

            await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`🗑️ Card Removed by Owner!
👤 From: @${targetId.split("@")[0]}
🎴 Card: ${cardMeta.name}
🆔 #${cardId}
✅ Successfully removed from their collection.`,
                    mentions: [targetId]
                },
                { quoted: msg }
            );

        }

        return;

    }


    // ========================================================
    // BULK RESULT
    // ========================================================

    const tierCounts = {};

    for (const removedCard of removedCards) {

        const tier =
            getCollectionCardTier(
                removedCard,
                cards
            ) || "Unknown";

        tierCounts[tier] =
            (tierCounts[tier] || 0) + 1;

    }

    const tierSummary =
        Object.entries(tierCounts)
            .map(
                ([tier, count]) =>
                    `│ ${tier}: ${count}`
            )
            .join("\n");


    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🗑️ *Cards Removed Successfully!*

👤 Removed from: @${targetId.split("@")[0]}
🎴 Cards Removed: ${removedCards.length}

┌─────────────────────
${tierSummary}
└─────────────────────

✅ The cards have been removed from their collection.`,
            mentions: [targetId]
        },
        { quoted: msg }
    );

}


module.exports = {
    removeCardCommand
};