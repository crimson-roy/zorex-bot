const fs = require("fs");

const USERS_FILE = "./users.json";
const PROPOSALS_FILE = "./marriageproposals.json";
const PROPOSAL_EXPIRY_MS = 60000; // 1 minute to respond

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 4));
}

function loadProposals() {
    if (!fs.existsSync(PROPOSALS_FILE)) fs.writeFileSync(PROPOSALS_FILE, "{}");
    return JSON.parse(fs.readFileSync(PROPOSALS_FILE, "utf8"));
}

function saveProposals(data) {
    fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(data, null, 4));
}

// Returns the partner's userId if married, or null. Used by other command
// files (fish.js, dig.js, auction.js) to extend shared access.
function getPartner(userId, users) {
    const u = users[userId];
    return (u && u.partner) ? u.partner : null;
}

// ---------- .marry @user — send a proposal ----------
async function marryCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const target = mentioned[0];

    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have a Zorex profile. Use .register`
        }, { quoted: msg });
    }

    if (!target) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You need to tag someone to propose to.\n\nExample:\n.marry @user`
        }, { quoted: msg });
    }

    if (target === sender) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `😂 You can't marry yourself.`
        }, { quoted: msg });
    }

    if (!users[target]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ That user doesn't have a Zorex profile.`
        }, { quoted: msg });
    }

    if (users[sender].partner) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `💍 You're already married. Use .divorce first if you want to remarry.`
        }, { quoted: msg });
    }

    if (users[target].partner) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `💔 @${target.split("@")[0]} is already married.`,
            mentions: [target]
        }, { quoted: msg });
    }

    const proposals = loadProposals();

    proposals[target] = {
        from: sender,
        createdAt: Date.now()
    };

    saveProposals(proposals);

    await sock.sendMessage(msg.key.remoteJid, {
        text:
`💍 *MARRIAGE PROPOSAL*
@${sender.split("@")[0]} has proposed to @${target.split("@")[0]}!
@${target.split("@")[0]}, you have 60 seconds to respond.
Type .marryaccept or .marrydecline`,
        mentions: [sender, target]
    }, { quoted: msg });

    setTimeout(async () => {

        const current = loadProposals();

        if (current[target] && current[target].from === sender) {

            delete current[target];
            saveProposals(current);

            await sock.sendMessage(msg.key.remoteJid, {
                text: `⌛ The proposal from @${sender.split("@")[0]} to @${target.split("@")[0]} expired.`,
                mentions: [sender, target]
            });

        }

    }, PROPOSAL_EXPIRY_MS);

}

// ---------- .marryaccept ----------
async function marryAcceptCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const proposals = loadProposals();
    const proposal = proposals[sender];

    if (!proposal) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You don't have a pending marriage proposal.`
        }, { quoted: msg });
    }

    const users = loadUsers();
    const partnerA = sender;
    const partnerB = proposal.from;

    if (!users[partnerA] || !users[partnerB]) {
        delete proposals[sender];
        saveProposals(proposals);

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ One of you no longer has a valid profile. Proposal cancelled.`
        }, { quoted: msg });
    }

    // Merge bank + bankLimit into a single shared total on both accounts
    const combinedBank = (users[partnerA].bank || 0) + (users[partnerB].bank || 0);
    const combinedLimit = (users[partnerA].bankLimit || 100000) + (users[partnerB].bankLimit || 100000);

    users[partnerA].bank = combinedBank;
    users[partnerB].bank = combinedBank;
    users[partnerA].bankLimit = combinedLimit;
    users[partnerB].bankLimit = combinedLimit;

    users[partnerA].partner = partnerB;
    users[partnerB].partner = partnerA;

    const marriedAt = Date.now();
    users[partnerA].marriedAt = marriedAt;
    users[partnerB].marriedAt = marriedAt;

    // marriageCount tracks how many times each user has married, so a second
    // (or later) marriage shows as "re-married" instead of "married"
    users[partnerA].marriageCount = (users[partnerA].marriageCount || 0) + 1;
    users[partnerB].marriageCount = (users[partnerB].marriageCount || 0) + 1;

    users[partnerA].maritalStatus = users[partnerA].marriageCount > 1 ? "re-married" : "married";
    users[partnerB].maritalStatus = users[partnerB].marriageCount > 1 ? "re-married" : "married";

    saveUsers(users);

    delete proposals[sender];
    saveProposals(proposals);

    return await sock.sendMessage(msg.key.remoteJid, {
        text:
`💒 *CONGRATULATIONS!*
@${partnerA.split("@")[0]} and @${partnerB.split("@")[0]} are now married! 💍
🏦 Your banks have been merged: ${combinedBank.toLocaleString()} 🌙 (Limit: ${combinedLimit.toLocaleString()} 🌙)
📦 You now share your collection and inventory.`,
        mentions: [partnerA, partnerB]
    }, { quoted: msg });

}

// ---------- .marrydecline ----------
async function marryDeclineCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const proposals = loadProposals();

    if (!proposals[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You don't have a pending marriage proposal.`
        }, { quoted: msg });
    }

    const proposer = proposals[sender].from;

    delete proposals[sender];
    saveProposals(proposals);

    return await sock.sendMessage(msg.key.remoteJid, {
        text: `💔 @${sender.split("@")[0]} declined @${proposer.split("@")[0]}'s proposal.`,
        mentions: [sender, proposer]
    }, { quoted: msg });

}

// ---------- .divorce ----------
async function divorceCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender] || !users[sender].partner) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You're not married.`
        }, { quoted: msg });
    }

    const partner = users[sender].partner;

    users[sender].partner = null;
    users[sender].marriedAt = null;
    users[sender].maritalStatus = "divorced";

    if (users[partner]) {
        users[partner].partner = null;
        users[partner].marriedAt = null;
        users[partner].maritalStatus = "divorced";
    }

    saveUsers(users);

    return await sock.sendMessage(msg.key.remoteJid, {
        text: `💔 @${sender.split("@")[0]} and @${partner.split("@")[0]} are now divorced.\n\n🏦 Your bank stays merged as-is — no automatic split.`,
        mentions: [sender, partner]
    }, { quoted: msg });

}

module.exports = {
    marryCommand,
    marryAcceptCommand,
    marryDeclineCommand,
    divorceCommand,
    getPartner
};