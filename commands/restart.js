// commands/restart.js
//
// .restart — owners only. Exits the process so Railway's restart policy
// relaunches it fresh.
//
// IMPORTANT: this only works if the process exits with a NON-ZERO code.
// Railway's "On Failure" restart policy (the platform default) restarts a
// service when it stops due to an error/non-zero exit — a clean exit(0) is
// recorded as a successful completion and is NOT restarted automatically.
// See: https://docs.railway.com/deployments/restart-policy

const fs = require("fs");
const { jidNormalizedUser } = require("@whiskeysockets/baileys");
const { MAIN_OWNER } = require("../config");

const OWNERS_FILE = "./owners.json";

// Mirrors the isOwner() logic already used in index.js — participant/remoteJid
// can come back as either a phone-number JID or a LID-format JID, so both the
// sender and MAIN_OWNER need to be normalized before comparing, otherwise the
// check can silently fail even for the real owner.
function isOwner(userId) {

    if (!userId) return false;

    const normalized = jidNormalizedUser(userId);

    if (MAIN_OWNER && normalized === jidNormalizedUser(MAIN_OWNER)) {
        return true;
    }

    try {
        const owners = JSON.parse(fs.readFileSync(OWNERS_FILE, "utf8"));
        return owners.includes(normalized);
    } catch (err) {
        return false;
    }

}

async function restartCommand(sock, msg) {

    const chatId = msg.key.remoteJid;
    const userId = msg.key.participant || msg.key.remoteJid;

    if (!isOwner(userId)) {
        return await sock.sendMessage(chatId, {
            text: `⚠️ Only my owner can restart me.`
        }, { quoted: msg });
    }

    await sock.sendMessage(chatId, {
        text: `🔄 Restarting Zorex... back in a moment.`
    }, { quoted: msg });

    console.log("♻️ Restart requested by:", userId);

    // Small delay so the WhatsApp message actually sends before the process
    // dies. Exit code 1 (not 0) is what makes Railway's "On Failure" policy
    // treat this as a crash and bring the service back up.
    setTimeout(() => {
        process.exit(1);
    }, 1500);

}

module.exports = { restartCommand };