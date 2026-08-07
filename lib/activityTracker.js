const fs = require("fs");

const {
    hasActiveSpawn,
    getRandomWeightedCard,
    createSpawn,
    announceSpawn,
    isAutoSpawnEnabled
} = require("./spawnManager");

const ACTIVITY_FILE = "./activity.json";

// ---------- Auto-spawn settings ----------

const ACTIVITY_WINDOW_MS = 3 * 60 * 1000;
// Messages must happen within 3 minutes.

const ACTIVITY_THRESHOLD = 15;
// 15 messages required.

const SPAWN_COOLDOWN_MS = 2 * 60 * 60 * 1000;
// 2 hours between successful automatic spawns.

const SPAWN_CHANCE = 0.35;
// 35% chance after the threshold is reached.

// ---------- activity storage ----------

function loadActivity() {

    if (!fs.existsSync(ACTIVITY_FILE)) {
        fs.writeFileSync(ACTIVITY_FILE, "{}");
    }

    return JSON.parse(
        fs.readFileSync(ACTIVITY_FILE, "utf8")
    );
}

function saveActivity(activity) {

    fs.writeFileSync(
        ACTIVITY_FILE,
        JSON.stringify(activity, null, 4)
    );
}

// ---------- activity tracking ----------

function recordActivity(groupJid) {

    const activity = loadActivity();

    const now = Date.now();

    const record =
        activity[groupJid] || {
            count: 0,
            lastMessageAt: 0,
            lastSpawnAt: 0
        };

    // If the group was quiet for more than 3 minutes,
    // start the activity streak over.
    if (
        now - record.lastMessageAt >
        ACTIVITY_WINDOW_MS
    ) {
        record.count = 0;
    }

    record.count += 1;

    record.lastMessageAt = now;

    const cooldownOk =
        now - record.lastSpawnAt >=
        SPAWN_COOLDOWN_MS;

    const thresholdOk =
        record.count >= ACTIVITY_THRESHOLD;

    let eligible = false;

    if (
        thresholdOk &&
        cooldownOk
    ) {

        // Reset regardless of whether the 35% roll succeeds.
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

// ---------- live message hook ----------

async function trackActivityAndMaybeSpawn(
    sock,
    msg
) {

    try {

        const chatJid =
            msg.key.remoteJid;

        // Groups only
        if (
            !chatJid ||
            !chatJid.endsWith("@g.us")
        ) {
            return;
        }

        // Don't count bot messages.
        if (msg.key.fromMe) {
            return;
        }

        // .cardoff means automatic spawning is disabled.
        if (!isAutoSpawnEnabled(chatJid)) {
            return;
        }

        const eligible =
            recordActivity(chatJid);

        if (!eligible) {
            return;
        }

        // Don't replace an existing active spawn.
        if (hasActiveSpawn(chatJid)) {
            return;
        }

        // Weighted tier selection.
        const picked =
            getRandomWeightedCard();

        if (!picked) {
            return;
        }

        const [cardId, card] = picked;

        const spawn =
            createSpawn(
                chatJid,
                cardId,
                card
            );

        await announceSpawn(
            sock,
            chatJid,
            spawn
        );

    } catch (err) {

        console.error(
            "⚠️ Auto-spawn check failed:",
            err.message
        );
    }
}

module.exports = {
    trackActivityAndMaybeSpawn
};