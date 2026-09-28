"use strict";

const { MAIN_OWNER } = require("../config");

async function inviteCommands(sock, msg, text) {

    if (text !== ".inviteowner") return;

    const groupJid = msg.key.remoteJid;

    if (!groupJid || !groupJid.endsWith("@g.us")) {
        return await sock.sendMessage(
            groupJid,
            { text: "⚠️ .inviteowner can only be used inside a group." },
            { quoted: msg }
        );
    }

    try {
        await sock.sendMessage(
            groupJid,
            {
                text:
`💙 Preparing Lord Crimson\'s invitation...

> Generating this group\'s invite link
> Sending it to him privately`
            },
            { quoted: msg }
        );

        const inviteCode = await sock.groupInviteCode(groupJid);
        const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;

        await sock.sendMessage(
            MAIN_OWNER,
            {
                text:
`💙 *Zorex Group Invitation*

A group admin has invited you to join their group.

> ${inviteLink}

Join only if you want to.

Powered by Zorex AI 🤖`,
                linkPreview: false
            }
        );

        return await sock.sendMessage(
            groupJid,
            {
                text:
`✅ *Invitation Sent*

I\'ve sent Lord Crimson the group invite privately.

> He can choose whether or not to join.`
            },
            { quoted: msg }
        );

    } catch (err) {

        console.error("[.inviteowner] failed:", err.message);

        return await sock.sendMessage(
            groupJid,
            {
                text:
`❌ I couldn\'t prepare the invitation.

> ${err.message}`
            },
            { quoted: msg }
        );
    }
}

module.exports = { inviteCommands };
