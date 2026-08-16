const { isOwner } = require("../lib/ownerCheck");

// TIER_ORDER is the existing tier list from card.js — reused so "valid
// tiers" is never defined in two places.
const { TIER_ORDER } = require("../commands/card.js");

const {
    hasActiveSpawn,
    getCardById,
    getRandomCard,
    getRandomCardByTier,
    createSpawn,
    announceSpawn
} = require("../lib/spawnManager");

// .spawn [CARD_ID | TIER]
//
// Owner-only. Deliberately sends the exact same announcement an automatic
// spawn would — no "OWNER SPAWN" label anywhere — so it looks like a
// natural event to everyone else in the chat.
async function execute(sock, msg, args) {

    const senderId = msg.key.participant || msg.key.remoteJid;
    const chatJid = msg.key.remoteJid;

    if (!isOwner(senderId)) {

        return await sock.sendMessage(chatJid, {
            text: `❌ Only my owners can use this command.`
        }, { quoted: msg });

    }

    // One active card per chat at a time — same rule the automatic
    // spawner respects.
    if (hasActiveSpawn(chatJid)) {

        return await sock.sendMessage(chatJid, {
            text: `⏳ There's already a card waiting to be claimed here. Wait for it to be claimed or expire first.`
        }, { quoted: msg });

    }

    const arg = args[0];
    let picked;

    if (!arg) {

       // No argument — fully random card from the whole pool. Owner
        // spawns are allowed to include event cards on purpose.
        picked = getRandomCard(true);

        if (!picked) {

            return await sock.sendMessage(chatJid, {
                text: `❌ card.json is empty — nothing to spawn.`
            }, { quoted: msg });

        }

    } else if (TIER_ORDER.includes(arg.toUpperCase())) {

        // .spawn SSR / SR / S / R / C — random card from that tier.
        const tier = arg.toUpperCase();
        picked = getRandomCardByTier(tier);

        if (!picked) {

            return await sock.sendMessage(chatJid, {
                text: `❌ No cards exist in tier ${tier}.`
            }, { quoted: msg });

        }

    } else {

        // .spawn <CARD_ID> — spawn that exact card.
        picked = getCardById(arg);

        if (!picked) {

            return await sock.sendMessage(chatJid, {
                text: `❌ No card found with ID "${arg}", and it's not a valid tier (${TIER_ORDER.join("/")}).`
            }, { quoted: msg });

        }

    }

    const [cardId, card] = picked;
    const spawn = createSpawn(chatJid, cardId, card);

    await announceSpawn(sock, chatJid, spawn);

}

module.exports = { execute };