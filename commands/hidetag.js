// commands/hidetag.js
//
// .hidetag <message> — deletes the admin's own command message, then
// reposts <message> tagging every group member WITHOUT any visible
// "@number" text in the body (the mentions array alone is what notifies
// everyone — no @ tokens are added to the text). Combined with deleting
// the original command message, this hides who actually sent it.
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

async function hidetagCommand(sock, msg, text) {

    const groupJid = msg.key.remoteJid;

    if (!groupJid.endsWith("@g.us")) {

        return await sock.sendMessage(
            groupJid,
            { text: "❌ This command only works in groups." },
            { quoted: msg }
        );

    }

    const sender = msg.key.participant || msg.key.remoteJid;

    let metadata;

    try {

        metadata = await sock.groupMetadata(groupJid);

    } catch (err) {

        console.error("[.hidetag] failed to fetch group metadata:", err.message);

        return await sock.sendMessage(
            groupJid,
            { text: "❌ Couldn't fetch group info — try again." },
            { quoted: msg }
        );

    }

    const senderIsAdmin =
        metadata.participants.some(
            p =>
            p.id === sender &&
            (p.admin === "admin" || p.admin === "superadmin")
        );

    const allowed = senderIsAdmin || isOwner(sender);

    if (!allowed) {

        return await sock.sendMessage(
            groupJid,
            { text: "❌ You are not an admin." },
            { quoted: msg }
        );

    }

    const message = text.replace(/^\.hidetag/i, "").trim();

    if (!message) {

        return await sock.sendMessage(
            groupJid,
            { text: "Usage: .hidetag <message>" },
            { quoted: msg }
        );

    }

    // Deleting the admin's own command message requires the bot itself to
    // be a group admin — same requirement .d/.kick already enforce.
    const botLid = sock.user.lid.split(":")[0] + "@lid";
    const botAdmin = metadata.participants.find(p => p.id === botLid)?.admin;

    if (!botAdmin) {

        return await sock.sendMessage(
            groupJid,
            { text: "❌ I need to be an admin before I can hide who sent this." },
            { quoted: msg }
        );

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

        console.error("[.hidetag] failed to delete original message:", err.message);
        // Not fatal on its own, but the whole point is hiding the sender —
        // bail out here rather than posting the message with the original
        // (undeleted) one still visible above it.
        return await sock.sendMessage(
            groupJid,
            { text: "❌ Couldn't delete your message, so nothing was sent." },
            { quoted: msg }
        );

    }

    const participants = metadata.participants.map(p => p.id);

    await sock.sendMessage(groupJid, {
        text: message,
        mentions: participants
    });

}

module.exports = { hidetagCommand };
