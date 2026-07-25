// commands/tagall.js
//
// .tagall — pulls every member of the current group and @mentions them all
// in one message. Doesn't require the bot to be a group admin; @mentions
// are just message metadata, not a moderation action, so any member (even
// the bot) can tag the whole group.

async function tagAllCommand(sock, msg) {

    const chatId = msg.key.remoteJid;

    if (!chatId.endsWith("@g.us")) {
        return await sock.sendMessage(chatId, {
            text: `⚠️ This command only works inside a group chat.`
        }, { quoted: msg });
    }

    let participants;

    try {

        const groupMetadata = await sock.groupMetadata(chatId);
        participants = groupMetadata.participants.map(p => p.id);

    } catch (err) {

        console.error("[tagall] failed to fetch group metadata:", err.message);
        return await sock.sendMessage(chatId, {
            text: `❌ Couldn't fetch group members — try again in a moment.`
        }, { quoted: msg });

    }

    if (participants.length === 0) {
        return await sock.sendMessage(chatId, {
            text: `⚠️ No members found in this group.`
        }, { quoted: msg });
    }

    const tagLines = participants.map(p => `@${p.split("@")[0]}`).join(" ");

    const text =
`👑 *Lord Crimson summons everyone!*

${tagLines}`;

    await sock.sendMessage(chatId, {
        text,
        mentions: participants
    }, { quoted: msg });

}

module.exports = { tagAllCommand };