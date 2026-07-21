const fs = require("fs");
const { checkCooldown, setCooldown } = require("./cooldown");

const USERS_FILE = "./users.json";

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 4));
}

function randomAmount(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

const JOBS = {

    1: {
        min: 200000,
        max: 350000,
        cooldownMs: 60 * 60 * 1000, // 1 hour
        messages: [
            "You worked at a construction site and earned",
            "You ran an errand for the senator's wife and earned",
            "You serviced the senator's wife's car and earned",
            "You washed cars downtown and earned",
            "You helped move furniture and earned"
        ]
    },

    2: {
        min: 650000,
        max: 1250000,
        cooldownMs: 2 * 60 * 60 * 1000, // 2 hours
        messages: [
            "You worked at a marketing firm and earned",
            "You got accepted for the post of assistant by the senator and earned",
            "You closed a deal at the office and earned",
            "You consulted for a mid-size company and earned"
        ]
    },

    3: {
        min: 1300000,
        max: 2000000,
        cooldownMs: 3 * 60 * 60 * 1000, // 3 hours
        messages: [
            "You worked at an engineering firm and earned",
            "Lord Crimson himself hired you and you earned",
            "You worked as the president's personal assistant and earned",
            "You closed a multi-million contract and earned"
        ]
    }

};


// ---------- .work 1 / .work 2 / .work 3 ----------
async function workCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have a Zorex profile.\n\nUse:\n.register YOUR_NAME`
        }, { quoted: msg });
    }

    const tier = text.replace(".work", "").trim();

    if (!["1", "2", "3"].includes(tier)) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text:
`💼 *ZOREX WORK*

Usage:

.work 1 — Basic jobs (200k–350k, 1h cooldown)
.work 2 — Mid-level jobs (650k–1.25M, 2h cooldown)
.work 3 — Top-level jobs (1.3M–2M, 3h cooldown)`
        }, { quoted: msg });
    }

    const job = JOBS[tier];
    const cooldownKey = `work${tier}`;

    const remaining = checkCooldown(sender, cooldownKey, job.cooldownMs);

    if (remaining) {

        const hours = Math.floor(remaining / (60 * 60 * 1000));
        const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⏳ You're still tired from your last job.\n\nTry .work ${tier} again in ${hours}h ${minutes}m.`
        }, { quoted: msg });

    }

    const earned = randomAmount(job.min, job.max);
    const flavor = pick(job.messages);

    users[sender].wallet += earned;
    saveUsers(users);

    setCooldown(sender, cooldownKey);

    return await sock.sendMessage(msg.key.remoteJid, {
        text:
`💼 *WORK COMPLETE*

${flavor} ${earned.toLocaleString()} 🌙

💳 Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
    }, { quoted: msg });

}


module.exports = {
    workCommand
};