const fs = require("fs");

const {
    hasActiveSpawn,
    getRandomCard,
    createSpawn,
    announceSpawn
} = require("./spawnManager");

const ACTIVITY_FILE = "./activity.json";

// Tuning knobs for the automatic spawner. All in one place so they're easy
// to adjust without touching the logic below.
const ACTIVITY_WINDOW_MS = 5 * 60 * 1000;   // messages must land within this window to build the same streak
const ACTIVITY_THRESHOLD = 15;              // messages needed in-window before a spawn becomes possible
const SPAWN_COOLDOWN_MS = 30 * 60 * 1000;   // minimum time between auto-spawns in the same group
const SPAWN_CHANCE = 0.35;                  // chance a spawn actually fires once threshold + cooldown are satisfied


// ---------- activity.json storage ----------
// Shape: { "<groupJid>": { count, lastMessageAt, lastSpawnAt } }

function loadActivity() {

    if (!fs.existsSync(ACTIVITY_FILE)) {
        fs.writeFileSync(ACTIVITY_FILE, "{}");
    }

    return JSON.parse(fs.readFileSync(ACTIVITY_FILE, "utf8"));

}

function saveActivity(activity) {

    fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(activity, null, 4));

}

// Records one message toward a group's activity streak and reports back
// whether that streak has just become spawn-eligible (threshold reached +
// cooldown elapsed). Resets the streak if it goes cold (no messages for
// longer than ACTIVITY_WINDOW_MS) so a slow trickle of messages over hours
// doesn't quietly add up to a spawn.
function recordActivity(groupJid) {

    const activity = loadActivity();
    const now = Date.now();

    const record = activity[groupJid] || { count: 0, lastMessageAt: 0, lastSpawnAt: 0 };

    if (now - record.lastMessageAt > ACTIVITY_WINDOW_MS) {
        record.count = 0;
    }

    record.count += 1;
    record.lastMessageAt = now;

    const cooldownOk = now - record.lastSpawnAt >= SPAWN_COOLDOWN_MS;
    const thresholdOk = record.count >= ACTIVITY_THRESHOLD;

    let eligible = false;

    if (thresholdOk && cooldownOk) {

        // Random chance so a spawn doesn't fire like clockwork on the
        // Nth message every time — reset the streak regardless of the
        // roll's outcome so it doesn't just retry next message.
        record.count = 0;

        if (Math.random() < SPAWN_CHANCE) {

            record.lastSpawnAt = now;
            eligible = true;

        }

    }

    activity[groupJid] = record;
    saveActivity(activity);

    return eligible;

}

// Call this for every incoming live message. It's a no-op for anything
// that isn't a real group chat message, and it never throws — a failure
// here should never take down the main message handler.
async function trackActivityAndMaybeSpawn(sock, msg) {

    try {

        const chatJid = msg.key.remoteJid;

        if (!chatJid || !chatJid.endsWith("@g.us")) return; // groups only
        if (msg.key.fromMe) return; // don't let the bot's own messages count

        const eligible = recordActivity(chatJid);

        if (!eligible) return;

        // Another spawn (manual or automatic) already active here — skip
        // silently, the streak reset above still applies so it isn't
        // retried on the very next message.
        if (hasActiveSpawn(chatJid)) return;

        const picked = getRandomCard();

        if (!picked) return; // card.json is empty — nothing to spawn

        const [cardId, card] = picked;
        const spawn = createSpawn(chatJid, cardId, card);

        await announceSpawn(sock, chatJid, spawn);

    } catch (err) {

        console.error("⚠️ Auto-spawn check failed:", err.message);

    }

}

module.exports = { trackActivityAndMaybeSpawn };
