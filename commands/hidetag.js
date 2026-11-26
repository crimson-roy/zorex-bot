// commands/hidetag.js
//
// .hidetag <message>  — deletes the admin's own command message, then reposts
//                       <message> as a silent tag. Also works as the caption
//                       of an image, which is reposted with the message.
// .hidetext <message> — the same, but the text comes back as view-once.
//
// Tag rule for both: if the admin tagged specific people, only they are
// tagged; otherwise every group member is. Tagging all adds no visible
// "@number" text (the mentions array alone notifies).
//
// Admins and bot owners only — same permission model as .d/.antilink.

const fs = require("fs");

const { MAIN_OWNER } = require("../config");
const dataPath = require("../lib/dataPath");

const OWNERS_FILE = dataPath("owners.json");

function loadOwners() {

    if (!fs.existsSync(OWNERS_FILE)) {
        fs.writeFileSync(OWNERS_FILE, JSON.stringify([], null, 4));
    }

    return JSON.parse(fs.readFileSync(OWNERS_FILE, "utf8"));

}

function isOwner(userId) {

    if (!userId) return false;

    if (MAIN_OWNER && userId === MAIN_OWNER) return true;

    return loadOwners().includes(userId);

}

function reply(sock, msg, text) {
    return sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

// Checks group, sender and bot permissions. Returns the group metadata, or
// null after telling the user what is wrong.
async function authorize(sock, msg, name) {

    const groupJid = msg.key.remoteJid;

    if (!groupJid.endsWith("@g.us")) {
        await reply(sock, msg, "❌ This command only works in groups.");
        return null;
    }

    const sender = msg.key.participant || msg.key.remoteJid;

    let metadata;

    try {
        metadata = await sock.groupMetadata(groupJid);
    } catch (err) {
        console.error(`[${name}] failed to fetch group metadata:`, err.message);
        await reply(sock, msg, "❌ Couldn't fetch group info — try again.");
        return null;
    }

    const senderIsAdmin =
        metadata.participants.some(
            p =>
            p.id === sender &&
            (p.admin === "admin" || p.admin === "superadmin")
        );

    if (!senderIsAdmin && !isOwner(sender)) {
        await reply(sock, msg, "❌ You are not an admin.");
        return null;
    }

    return metadata;

}

// Deleting the admin's command requires the bot itself to be a group admin —
// same requirement .d/.kick already enforce. Returns true once deleted; the
// caller must not send anything if this fails, or the sender is exposed.
async function deleteOriginal(sock, msg, metadata, name) {

    const groupJid = msg.key.remoteJid;

    const botLid = sock.user.lid.split(":")[0] + "@lid";
    const botAdmin = metadata.participants.find(p => p.id === botLid)?.admin;

    if (!botAdmin) {
        await reply(sock, msg, "❌ I need to be an admin before I can hide who sent this.");
        return false;
    }

    try {

        await sock.sendMessage(groupJid, {
            delete: {
                remoteJid: groupJid,
                fromMe: false,
                id: msg.key.id,
                participant: msg.key.participant
            }
        });

    } catch (err) {

        console.error(`[${name}] failed to delete original message:`, err.message);
        await reply(sock, msg, "❌ Couldn't delete your message, so nothing was sent.");
        return false;

    }

    return true;

}

function pickMentions(msg, metadata) {

    const context =
        msg.message?.extendedTextMessage?.contextInfo ||
        msg.message?.imageMessage?.contextInfo;

    const tagged = context?.mentionedJid || [];

    return tagged.length
        ? [...tagged]
        : metadata.participants.map(p => p.id);

}

// The command may be typed in any case or small caps, so strip the first word
// from the already-normalized text rather than matching the raw spelling.
function commandBody(text) {
    return text.trimStart().replace(/^\S+/, "").trim();
}

async function hidetagCommand(sock, msg, text) {

    const metadata = await authorize(sock, msg, ".hidetag");

    if (!metadata) return;

    const groupJid = msg.key.remoteJid;
    const message = commandBody(text);
    const image = msg.message?.imageMessage;

    if (!message && !image) {
        return await reply(sock, msg, "Usage: .hidetag <message>");
    }

    let imageBuffer = null;

    if (image) {

        // Download before deleting, so a failed download loses nothing.
        try {
            const { downloadMediaMessage } =
                await import("@whiskeysockets/baileys");

            imageBuffer = await downloadMediaMessage(msg, "buffer", {});
        } catch (err) {
            console.error("[.hidetag] failed to download image:", err.message);
            return await reply(sock, msg, "❌ Couldn't download your image, so nothing was changed.");
        }

    }

    if (!(await deleteOriginal(sock, msg, metadata, ".hidetag"))) return;

    const mentions = pickMentions(msg, metadata);

    await sock.sendMessage(
        groupJid,
        imageBuffer
            ? { image: imageBuffer, caption: message, mentions }
            : { text: message, mentions }
    );

}

async function hidetextCommand(sock, msg, text) {

    const metadata = await authorize(sock, msg, ".hidetext");

    if (!metadata) return;

    const groupJid = msg.key.remoteJid;
    const message = commandBody(text);

    // Text only: never delete media that would not be sent back.
    if (!message || msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage) {
        return await reply(sock, msg, "Usage: .hidetext <message>");
    }

    if (!(await deleteOriginal(sock, msg, metadata, ".hidetext"))) return;

    // Built by hand: sendMessage({ viewOnce, mentions }) in Baileys rc14 puts
    // the mentions on the view-once wrapper, where they are lost.
    const { generateWAMessageFromContent } =
        await import("@whiskeysockets/baileys");

    const waMessage = generateWAMessageFromContent(
        groupJid,
        {
            viewOnceMessageV2: {
                message: {
                    extendedTextMessage: {
                        text: message,
                        viewOnce: true,
                        contextInfo: { mentionedJid: pickMentions(msg, metadata) }
                    }
                }
            }
        },
        { userJid: sock.user.id }
    );

    await sock.relayMessage(groupJid, waMessage.message, {
        messageId: waMessage.key.id
    });

}

module.exports = { hidetagCommand, hidetextCommand };
