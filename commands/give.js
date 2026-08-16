const fs = require("fs");

// Reuse the existing card/collection helpers and display logic instead of
// duplicating any of it. No new collection system, no new card display code.
const {
    loadCards,
    loadCollection,
    findOwners,
    sendCardDisplay
} = require("./card.js");

// PERSISTENCE FIX: this file used to hardcode "./collection.json" for
// writes while card.js's loadCollection() read through dataPath() — a
// split-brain where gifted cards landed on the ephemeral container disk
// instead of the mounted volume. Route through the same dataPath() every
// other collection.json writer uses. See lib/dataPath.js.
const dataPath = require("../lib/dataPath");
const COLLECTION_FILE = dataPath("collection.json");


// ---------- small helpers ----------

// Baileys puts @mentions in extendedTextMessage.contextInfo.mentionedJid.
// Same shape used elsewhere in the codebase (see chloe.js's getContextInfo).
function getContextInfo(msg) {

    const m = msg.message || {};

    return (m.extendedTextMessage && m.extendedTextMessage.contextInfo) || {};

}

function getMentionedJids(msg) {

    const ctx = getContextInfo(msg);

    return ctx.mentionedJid || [];

}

// Sender id in group chats comes from key.participant, in DMs it's
// key.remoteJid — same fallback used in chloe.js.
function getSenderId(msg) {

    return msg.key.participant || msg.key.remoteJid;

}

// Best-effort display name resolution: for the sender we have pushName for
// free. For a mentioned user we don't, so we try the socket's contact
// store and fall back to the number/id portion of the JID.
//
// NOTE: this is a placeholder for whatever hb.js actually does — if hb.js
// exposes a shared resolveName()/getName() helper, swap this function out
// for that one so .give matches the rest of the bot exactly.
function resolveDisplayName(sock, jid, msg, senderId) {

    if (jid === senderId && msg.pushName) {
        return msg.pushName;
    }

    try {

        const contact = sock.contacts && sock.contacts[jid];

        if (contact && (contact.name || contact.notify)) {
            return contact.name || contact.notify;
        }

    } catch (err) {

        console.error("⚠️ Name lookup failed, falling back to number:", err.message);

    }

    // Fall back to the number/id portion of the JID (strip @domain and any
    // :device suffix).
    return jid.split("@")[0].split(":")[0];

}

function saveCollection(collection) {

    fs.writeFileSync(COLLECTION_FILE, JSON.stringify(collection, null, 4));

}


// ---------- .give <slot|all> @user ----------
async function giveCommand(sock, msg, text) {

    const senderId = getSenderId(msg);

    // --- 1. Validate mentions: exactly one required ---
  const context = getContextInfo(msg);
    const mentions = getMentionedJids(msg);

    if (mentions.length > 1) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Please mention exactly one user.`
        }, { quoted: msg });

    }

    // Priority: @mention > reply-to-user > self (no target given at all)
    const recipientId = mentions[0] || context.participant || senderId;

    if (recipientId === senderId) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You can't gift a card to yourself.`
        }, { quoted: msg });

    }

    // --- 2. Parse syntax: .give <slot|all> @user ---
    const args =
        text
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    // args[0] is the command itself (".give"), args[1] should be the slot/"all"
    const slotArg = args[1];

    if (!slotArg) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Usage:\n\n.give <slot> @user\n.give all @user\n\nExamples:\n.give 1 @user\n.give 5 @user\n.give all @user`
        }, { quoted: msg });

    }

    const isAll = slotArg.toLowerCase() === "all";

    if (!isAll && !/^\d+$/.test(slotArg)) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Invalid slot. Use a number from your .col list, or "all".`
        }, { quoted: msg });

    }

    // --- 3. Load collection and validate sender actually has cards ---
    let collection;

    try {

        collection = loadCollection();

    } catch (err) {

        console.error("❌ Failed to load collection.json:", err.message);

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ Something went wrong reading the collection. Try again in a bit.`
        }, { quoted: msg });

    }

    const senderCards = collection[senderId] || [];

    if (senderCards.length === 0) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You don't have any cards to give.`
        }, { quoted: msg });

    }

    // --- 4. Validate slot exists (slot number = position shown in .col,
    // i.e. 1-based index into the sender's collection array in stored
    // order — matches the array order .col reads from) ---
    let slotIndex = null;

    if (!isAll) {

        const slotNum = Number(slotArg);

        if (slotNum < 1 || slotNum > senderCards.length) {

            return await sock.sendMessage(msg.key.remoteJid, {
                text: `⚠️ That slot doesn't exist. You have ${senderCards.length} card${senderCards.length === 1 ? "" : "s"} — pick a slot between 1 and ${senderCards.length}.`
            }, { quoted: msg });

        }

        slotIndex = slotNum - 1;

    }

    // --- 5. All validations passed. Build the new collection state in
    // memory first — collection.json is only ever written once, after
    // every check above has succeeded, so a mid-command error can never
    // leave cards half-transferred or lost. ---
    const recipientCards = collection[recipientId] ? [...collection[recipientId]] : [];
    let newSenderCards;
    let giftedCards; // the card(s) that moved, for the reply message

    if (isAll) {

        // Preserve order: sender's cards are appended in their existing order.
        giftedCards = senderCards;
        recipientCards.push(...senderCards);
        newSenderCards = [];

    } else {

        // Preserve the exact card object (id, image/video, obtainedFrom,
        // obtainedAt, everything) — just move it between arrays.
        const [movedCard] = senderCards.splice(slotIndex, 1);

        giftedCards = [movedCard];
        recipientCards.push(movedCard);
        newSenderCards = senderCards;

    }

    collection[senderId] = newSenderCards;
    collection[recipientId] = recipientCards;

    try {

        saveCollection(collection);

    } catch (err) {

        console.error("❌ Failed to save collection.json:", err.message);

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ Couldn't save the transfer. Nothing was changed — try again in a bit.`
        }, { quoted: msg });

    }

    // --- 6. Resolve names for the confirmation message ---
    const senderName = resolveDisplayName(sock, senderId, msg, senderId);
    const recipientName = resolveDisplayName(sock, recipientId, msg, senderId);

    // --- 7. Reply ---
    if (isAll) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text:
`🎁 Collection Gifted!
📦 ${giftedCards.length} card${giftedCards.length === 1 ? "" : "s"} transferred.
👤 ${senderName} ➜ ${recipientName}
✨ Every card has been moved successfully.`,
            mentions: [senderId, recipientId]
        }, { quoted: msg });

    }

    // Single card: show it exactly like the existing card display, using
    // full card metadata from card.json plus its post-transfer owner list.
    const movedCard = giftedCards[0];

    try {

        const cards = loadCards();
        const cardMeta = cards[movedCard.id];
        const owners = findOwners(movedCard.id, collection);

        const extraText =
`\n\n🎁 Card Gifted!
👤 ${senderName} ➜ ${recipientName}
✨ Successfully transferred!`;

        if (cardMeta) {

            await sendCardDisplay(sock, msg, movedCard.id, cardMeta, owners, extraText);

        } else {

            // card.json is missing this id — still confirm the transfer,
            // just without the rich display.
            await sock.sendMessage(msg.key.remoteJid, {
                text: `🎁 Card Gifted!\n👤 ${senderName} ➜ ${recipientName}\n✨ Successfully transferred "${movedCard.name}"!`,
                mentions: [senderId, recipientId]
            }, { quoted: msg });

        }

    } catch (err) {

        // The transfer already succeeded and was saved — a display error
        // here should never look like the gift failed.
        console.error("⚠️ Card display failed after successful transfer:", err.message);

        await sock.sendMessage(msg.key.remoteJid, {
            text: `🎁 Card Gifted!\n👤 ${senderName} ➜ ${recipientName}\n✨ Successfully transferred!`,
            mentions: [senderId, recipientId]
        }, { quoted: msg });

    }

}

module.exports = {
    giveCommand
};