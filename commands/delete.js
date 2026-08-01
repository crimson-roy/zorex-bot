// commands/delete.js
//
// .d — reply to a message with .d to delete it. Group admins (or bot
// owners) only. Deletes both the replied-to message AND the .d command
// message itself, so no trace of the moderation action is left behind.
//
// Permission model mirrors .mute/.kick/.promote elsewhere in this bot:
// group admin OR bot owner (MAIN_OWNER / owners.json). Requires the bot
// itself to be a group admin, same as .kick — deleting someone else's
// message requires that.

const fs = require("fs");

const { MAIN_OWNER } = require("../config");

// PERSISTENCE FIX applied from the start — routed through dataPath()
// rather than a bare relative path, so owner data survives redeploys.
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

async function deleteCommand(sock, msg) {

    const groupJid = msg.key.remoteJid;

    if (!groupJid.endsWith("@g.us")) {

        return await sock.sendMessage(
            groupJid,
            { text: "❌ This command only works in groups." },
            { quoted: msg }
        );

    }

    const context =
        msg.message?.extendedTextMessage?.contextInfo;

    // A stanzaId on the contextInfo is what tells us this message is a
    // reply to another message — no reply means nothing to delete.
    if (!context?.stanzaId) {

        return await sock.sendMessage(
            groupJid,
            { text: "Usage: reply to a message with .d" },
            { quoted: msg }
        );

    }

    const sender = msg.key.participant || msg.key.remoteJid;

    let metadata;

    try {

        metadata = await sock.groupMetadata(groupJid);

    } catch (err) {

        console.error("[.d] failed to fetch group metadata:", err.message);

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

    // Bot must itself be a group admin to delete another participant's
    // message — same requirement .kick already enforces.
    const botLid = sock.user.lid.split(":")[0] + "@lid";
    const botAdmin = metadata.participants.find(p => p.id === botLid)?.admin;

    if (!botAdmin) {

        return await sock.sendMessage(
            groupJid,
            { text: "❌ I need to be an admin before I can delete messages." },
            { quoted: msg }
        );

    }

    try {

        // Delete the message that was replied to.
        await sock.sendMessage(groupJid, {
            delete: {
                remoteJid: groupJid,
                fromMe: false,
                id: context.stanzaId,
                participant: context.participant
            }
        });

        // Delete the .d command message itself — no trace left behind.
        await sock.sendMessage(groupJid, {
            delete: {
                remoteJid: groupJid,
                fromMe: false,
                id: msg.key.id,
                participant: msg.key.participant
            }
        });

    } catch (err) {

        console.error("[.d] delete failed:", err.message);

        await sock.sendMessage(
            groupJid,
            { text: "❌ Failed to delete message(s)." },
            { quoted: msg }
        );

    }

}

module.exports = { deleteCommand };
