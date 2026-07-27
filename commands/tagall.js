// commands/tagall.js
//
// .tagall — pulls every member of the current group and @mentions them all
// in one message. Sending the mentions doesn't require the bot itself to
// be a group admin (@mentions are just message metadata, not a moderation
// action).
//
// Permission gating for WHO can run this command lives in index.js, via
// isOwnerOrAdmin(sock, msg), which runs BEFORE this function is ever
// called. This file intentionally does not duplicate that check.

async function tagAllCommand(sock, msg, args) {

    const chatId = msg.key.remoteJid;

    if (!chatId.endsWith("@g.us")) {
        return await sock.sendMessage(chatId, {
            text: `⚠️ This command only works inside a group chat.`
        }, { quoted: msg });
    }

    let groupMetadata;

    try {

        groupMetadata = await sock.groupMetadata(chatId);

    } catch (err) {

        console.error("[tagall] failed to fetch group metadata:", err.message);
        return await sock.sendMessage(chatId, {
            text: `❌ Couldn't fetch group members — try again in a moment.`
        }, { quoted: msg });

    }

    const participants = groupMetadata.participants.map(p => p.id);

    if (participants.length === 0) {
        return await sock.sendMessage(chatId, {
            text: `⚠️ No members found in this group.`
        }, { quoted: msg });
    }

    const tagLines = participants.map(p => `@${p.split("@")[0]}`).join(" ");
    const reason = args && args.length > 0 ? args.join(" ") : null;

    const text = reason
        ? `👑 *Lord Crimson summons everyone!*\n📢 Reason: *${reason}*\n\n${tagLines}`
        : `👑 *Lord Crimson summons everyone!*\n\n${tagLines}`;

    await sock.sendMessage(chatId, {
        text,
        mentions: participants
    }, { quoted: msg });

}

module.exports = { tagAllCommand };