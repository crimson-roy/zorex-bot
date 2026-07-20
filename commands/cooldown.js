const fs = require("fs");
const COOLDOWN_FILE = "./cooldown.json";

function loadCooldowns() {
    if (!fs.existsSync(COOLDOWN_FILE)) {
        fs.writeFileSync(COOLDOWN_FILE, "{}");
    }
    return JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf8"));
}

function saveCooldowns(data) {
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(data, null, 4));
}

function checkCooldown(userId, command, cooldownMs) {
    const cooldowns = loadCooldowns();
    const key = `${command}:${userId}`;
    const last = cooldowns[key];

    if (last && Date.now() - last < cooldownMs) {
        return cooldownMs - (Date.now() - last);
    }

    return null;
}

function setCooldown(userId, command) {
    const cooldowns = loadCooldowns();
    cooldowns[`${command}:${userId}`] = Date.now();
    saveCooldowns(cooldowns);
}

// Reset every cooldown belonging to one user, across all commands
function resetUserCooldown(userId) {

    const cooldowns = loadCooldowns();

    let cleared = 0;

    for (const key of Object.keys(cooldowns)) {

        // keys look like "cf:12345@s.whatsapp.net"
        if (key.endsWith(`:${userId}`)) {

            delete cooldowns[key];
            cleared++;

        }

    }

    saveCooldowns(cooldowns);

    return cleared;

}

// Wipe every cooldown for every user/command
function resetAllCooldowns() {

    const cooldowns = loadCooldowns();

    const cleared = Object.keys(cooldowns).length;

    saveCooldowns({});

    return cleared;

}

module.exports = {
    checkCooldown,
    setCooldown,
    resetUserCooldown,
    resetAllCooldowns
};