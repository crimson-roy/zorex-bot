const fs = require("fs");
const { MAIN_OWNER } = require("../config");
const dataPath = require("./dataPath");

const OWNERS_FILE = dataPath("owners.json");

// Same pattern as commands/chloe.js's isOwner(): MAIN_OWNER from config.js
// is always trusted, plus anyone added to owners.json via .addowner.
// Kept as its own tiny module so any command file can reuse it without
// pulling in index.js (which owns the jidNormalizedUser-based version and
// isn't require()-able from a command file anyway).
function isOwner(userId) {

    if (!userId) return false;

    if (MAIN_OWNER && userId === MAIN_OWNER) {
        return true;
    }

    try {

        const owners = JSON.parse(fs.readFileSync(OWNERS_FILE, "utf8"));
        return owners.includes(userId);

    } catch (err) {

        // owners.json missing/unreadable — fail closed, not open
        return false;

    }

}

module.exports = { isOwner };
