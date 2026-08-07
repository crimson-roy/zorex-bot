// commands/broadcast.js
//
// .broadcast <message> — Main owner ONLY (not the broader owners.json
// list — deliberately stricter than isOwner()). Deletes the owner's own
// command message using the same delete flow as .hidetag, then sends the
// message to EVERY group Chloe (this bot) currently participates in,
// tagging all members in each group with no visible "@number" text in the
// body — same silent-tag mechanism .hidetag uses, just fanned out across
// every group instead of the one it was sent in.

const { MAIN_OWNER } = require("../config");

async function broadcastCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;

    // Main owner only. NOT isOwner() — that also trusts owners.json, and a
    // broadcast reaching every single group is deliberately kept to
    // MAIN_OWNER specifically.
    if (!MAIN_OWNER || sender !== MAIN_OWNER) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: "❌ Only the main owner can use this command." },
            { quoted: msg }
        );

    }

    const message = text.replace(/^\.broadcast/i, "").trim();

    if (!message) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: "Usage: .broadcast <message>" },
            { quoted: msg }
        );

    }

    // Delete the owner's own command message — same mechanism as .hidetag.
    // Unlike .hidetag, a failed delete does NOT abort the broadcast: the
    // whole point here is the fan-out to every group, and this command
    // might be invoked somewhere (e.g. a DM to the bot) where deleting the
    // sender's own message isn't possible at all.
    try {

        await sock.sendMessage(msg.key.remoteJid, {
            delete: {
                remoteJid: msg.key.remoteJid,
                fromMe: false,
                id: msg.key.id,
                participant: msg.key.participant
            }
        });

    } catch (err) {

        console.error("[.broadcast] couldn't delete original message:", err.message);

    }

    let groups;

    try {

        groups = await sock.groupFetchAllParticipating();

    } catch (err) {

        console.error("[.broadcast] failed to fetch group list:", err.message);

        return await sock.sendMessage(msg.key.remoteJid, {
            text: "❌ Couldn't fetch the group list — broadcast aborted."
        });

    }

    const groupIds = Object.keys(groups);

    const broadcastText = `👑 *Lord Crimson Broadcast*\n\n${message}`;

    let sent = 0;
    let failed = 0;

    for (const groupId of groupIds) {

        try {

            const participants = (groups[groupId].participants || []).map(p => p.id);

            await sock.sendMessage(groupId, {
                text: broadcastText,
                mentions: participants
            });

            sent++;

        } catch (err) {

            console.error(`[.broadcast] failed to send to ${groupId}:`, err.message);
            failed++;

        }

    }

    // Feedback for the owner — their own command message is gone, so this
    // is the only confirmation they get that it actually went out.
    await sock.sendMessage(msg.key.remoteJid, {
        text:
`✅ Broadcast sent to ${sent}/${groupIds.length} group${groupIds.length === 1 ? "" : "s"}.${failed ? `\n⚠️ Failed in ${failed} group${failed === 1 ? "" : "s"}.` : ""}`
    });

}

module.exports = { broadcastCommand };
