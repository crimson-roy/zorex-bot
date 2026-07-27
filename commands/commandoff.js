// commands/commandoff.js
//
// .commandoff — owners/admins only. Disables every other command in the
// current group. .commandon re-enables it. Chloe and moderation are NOT
// affected — this only gates the prefix-command chain in index.js.
//
// Wire-in note (index.js):
//   Check isCommandsOff(chatId) at the very top of the command chain,
//   BEFORE any other "else if" branches run — except .commandoff/.commandon
//   themselves, which must always be reachable so it can be turned back on.

const fs = require("fs");
const path = require("path");
const { MAIN_OWNER } = require("../config");

const OWNERS_FILE = "./owners.json";
const STORE_PATH = path.join(__dirname, "..", "data", "commandoff.json");

function ensureStore() {
    if (!fs.existsSync(path.dirname(STORE_PATH))) {
        fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    }
    if (!fs.existsSync(STORE_PATH)) {
        fs.writeFileSync(STORE_PATH, "{}");
    }
}

function loadStore() {
    ensureStore();
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
}

function saveStore(store) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 4));
}

function isCommandsOff(chatId) {
    const store = loadStore();
    return store[chatId] === true;
}

function isOwner(userId) {
    if (userId === MAIN_OWNER) return true;
    try {
        const owners = JSON.parse(fs.readFileSync(OWNERS_FILE, "utf8"));
        return owners.includes(userId);
    } catch (err) {
        return false;
    }
}

async function isGroupAdmin(sock, chatId, userId) {
    if (!chatId.endsWith("@g.us")) return false;
    try {
        const metadata = await sock.groupMetadata(chatId);
        const participant = metadata.participants.find(p => p.id === userId);
        return !!participant && (participant.admin === "admin" || participant.admin === "superadmin");
    } catch (err) {
        console.error("[commandoff] failed to check admin status:", err.message);
        return false;
    }
}

async function commandOffCommand(sock, msg) {

    const chatId = msg.key.remoteJid;
    const userId = msg.key.participant || msg.key.remoteJid;

    const allowed = isOwner(userId) || await isGroupAdmin(sock, chatId, userId);

    if (!allowed) {
        return await sock.sendMessage(chatId, {
            text: `❌ Only owners or group admins can do that.`
        }, { quoted: msg });
    }

    const store = loadStore();
    store[chatId] = true;
    saveStore(store);

    await sock.sendMessage(chatId, {
        text: `🔒 Commands are now *disabled* in this group. Use .commandon to restore them.`
    }, { quoted: msg });

}

async function commandOnCommand(sock, msg) {

    const chatId = msg.key.remoteJid;
    const userId = msg.key.participant || msg.key.remoteJid;

    const allowed = isOwner(userId) || await isGroupAdmin(sock, chatId, userId);

    if (!allowed) {
        return await sock.sendMessage(chatId, {
            text: `❌ Only owners or group admins can do that.`
        }, { quoted: msg });
    }

    const store = loadStore();
    store[chatId] = false;
    saveStore(store);

    await sock.sendMessage(chatId, {
        text: `🔓 Commands are back on in this group.`
    }, { quoted: msg });

}

module.exports = { commandOffCommand, commandOnCommand, isCommandsOff };