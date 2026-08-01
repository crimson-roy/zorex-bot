// lib/dataPath.js
//
// Single source of truth for where persistent JSON/auth data lives.
//
// Locally (no DATA_DIR set), everything resolves relative to the project
// root, same as before — nothing changes for local development.
//
// On Railway, DATA_DIR should be set to the mount path of an attached
// Volume (e.g. "/data"). Every file that used to do
// `const USERS_FILE = "./users.json"` should instead do
// `const USERS_FILE = dataPath("users.json")` — that's the only change
// needed per file. Writing straight to "./users.json" without this means
// the file lives on the container's ephemeral disk and gets wiped on
// every redeploy, which is the bug this fixes.
//
// If you add a new file that needs to persist data (a new economy
// feature, a new game's state, etc.), route it through dataPath() from
// the start rather than a bare relative path — this is the one place
// that needs to be right.

const path = require("path");
const fs = require("fs");

const DATA_DIR = process.env.DATA_DIR || ".";

// Fails loudly and immediately on startup if DATA_DIR is set but doesn't
// exist/isn't writable, rather than failing later and confusingly the
// first time some command tries to save something. A misconfigured mount
// path (typo, volume not actually attached yet, etc.) should be obvious
// from the boot logs, not from users reporting "my data disappeared again"
// a week later.
function ensureDataDir() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.accessSync(DATA_DIR, fs.constants.W_OK);
    } catch (err) {
        throw new Error(
            `[dataPath] DATA_DIR ("${DATA_DIR}") is not writable: ${err.message}\n` +
            `If this is Railway, check that a Volume is attached and mounted at this exact path.`
        );
    }
}

ensureDataDir();

/**
 * Resolves a filename to its full path inside the configured data
 * directory. Use this for every file that needs to survive a redeploy —
 * user data, economy state, game state, the Baileys auth folder, etc.
 *
 * @param {string} filename - e.g. "users.json", or "auth" for a folder.
 * @returns {string} The full path, e.g. "/data/users.json".
 */
function dataPath(filename) {
    return path.join(DATA_DIR, filename);
}

module.exports = dataPath;
module.exports.DATA_DIR = DATA_DIR;
