const fs = require("fs");
const dataPath = require("../lib/dataPath");

// PERSISTENCE FIX + SPLIT-BRAIN FIX: group.js's .mute/.unmute already
// write muted.json through dataPath("muted.json"). This file was reading/
// writing a hardcoded "./muted.json" instead — a DIFFERENT file whenever
// DATA_DIR is set (Railway). That means the watcher below could fail to
// see a mute group.js just recorded, or vice versa, independent of any
// redeploy. Routed through dataPath() to match group.js exactly.
const MUTED_FILE = dataPath("muted.json");
const MUTE_ALL_FILE = dataPath("muteall.json");
const AI_MOD_RULES_FILE = dataPath("aiModerationRules.json");

const ADMIN_CACHE_TTL_MS = 15 * 1000;
const adminCache = new Map();

function loadMuted() {

    if (!fs.existsSync(MUTED_FILE)) {

        fs.writeFileSync(
            MUTED_FILE,
            JSON.stringify({}, null, 4)
        );

    }

    return JSON.parse(
        fs.readFileSync(
            MUTED_FILE,
            "utf8"
        )
    );

}

function saveMuted(data) {

    fs.writeFileSync(
        MUTED_FILE,
        JSON.stringify(
            data,
            null,
            4
        )
    );

}

function loadMuteAll() {

    if (!fs.existsSync(MUTE_ALL_FILE)) {

        fs.writeFileSync(
            MUTE_ALL_FILE,
            JSON.stringify({}, null, 4)
        );

    }

    try {

        const parsed =
            JSON.parse(
                fs.readFileSync(
                    MUTE_ALL_FILE,
                    "utf8"
                )
            );

        return parsed &&
            typeof parsed === "object"
                ? parsed
                : {};

    } catch (_) {

        return {};

    }

}

function loadAiModerationRules() {

    if (!fs.existsSync(AI_MOD_RULES_FILE)) {

        fs.writeFileSync(
            AI_MOD_RULES_FILE,
            JSON.stringify({}, null, 4)
        );

    }

    try {

        const parsed =
            JSON.parse(
                fs.readFileSync(
                    AI_MOD_RULES_FILE,
                    "utf8"
                )
            );

        return parsed &&
            typeof parsed === "object"
                ? parsed
                : {};

    } catch (_) {

        return {};

    }

}

function saveAiModerationRules(data) {

    fs.writeFileSync(
        AI_MOD_RULES_FILE,
        JSON.stringify(
            data,
            null,
            4
        )
    );

}

function armSpamKickRule(
    groupJid,
    target,
    enabledBy,
    expiresAt,
    limit = 5,
    windowMs = 30000
) {

    const rules =
        loadAiModerationRules();

    if (!rules[groupJid]) {
        rules[groupJid] = {};
    }

    rules[groupJid][target] = {
        type:
            "kick_if_spam",
        enabledBy:
            enabledBy || null,
        expiresAt:
            Number(expiresAt || 0),
        limit:
            Math.max(
                2,
                Math.min(
                    Number(limit) || 5,
                    20
                )
            ),
        windowMs:
            Math.max(
                5000,
                Math.min(
                    Number(windowMs) || 30000,
                    300000
                )
            ),
        hits:
            []
    };

    saveAiModerationRules(
        rules
    );

}

function clearSpamKickRule(
    groupJid,
    target
) {

    const rules =
        loadAiModerationRules();

    if (!rules[groupJid]) {
        return;
    }

    delete rules[groupJid][target];

    if (
        Object.keys(
            rules[groupJid]
        ).length === 0
    ) {
        delete rules[groupJid];
    }

    saveAiModerationRules(
        rules
    );

}

function findStoredKey(
    record,
    aliases
) {

    if (
        !record ||
        typeof record !== "object"
    ) {
        return null;
    }

    for (const alias of aliases) {
        if (
            Object.prototype
                .hasOwnProperty
                .call(
                    record,
                    alias
                )
        ) {
            return alias;
        }
    }

    return null;
}

function senderAliases(msg) {

    const key =
        msg?.key || {};

    return [
        ...new Set(
            [
                key.participant,
                key.participantAlt,
                key.senderPn,
                key.senderLid
            ]
                .filter(Boolean)
                .map(String)
        )
    ];

}

function participantAliases(participant) {

    return [
        ...new Set(
            [
                participant?.id,
                participant?.phoneNumber,
                participant?.lid,
                participant?.jid
            ]
                .filter(Boolean)
                .map(String)
        )
    ];

}

async function getAdminIds(
    sock,
    groupJid
) {

    const cached =
        adminCache.get(
            groupJid
        );

    if (
        cached &&
        cached.expiresAt >
            Date.now()
    ) {
        return cached.ids;
    }

    const metadata =
        await sock.groupMetadata(
            groupJid
        );

    const ids =
        new Set();

    for (
        const participant of
        metadata.participants || []
    ) {

        if (
            participant.admin !== "admin" &&
            participant.admin !== "superadmin"
        ) {
            continue;
        }

        for (
            const alias of
            participantAliases(
                participant
            )
        ) {
            ids.add(
                alias
            );
        }

    }

    adminCache.set(
        groupJid,
        {
            ids,
            expiresAt:
                Date.now() +
                ADMIN_CACHE_TTL_MS
        }
    );

    return ids;

}

async function senderIsAdmin(
    sock,
    groupJid,
    msg
) {

    const admins =
        await getAdminIds(
            sock,
            groupJid
        );

    return senderAliases(
        msg
    ).some(alias =>
        admins.has(alias)
    );

}

async function deleteGroupMessage(
    sock,
    groupJid,
    msg
) {

    try {

        await sock.sendMessage(
            groupJid,
            {
                delete:
                    msg.key
            }
        );

        return true;

    } catch (err) {

        console.log(
            "Delete failed:",
            err.message
        );

        return false;

    }

}

async function moderationWatcher(sock, msg) {

    const groupJid = msg.key.remoteJid;

    if (!groupJid?.endsWith("@g.us")) return;

    const sender =
        msg.key.participant;

    if (!sender) return false;

    const muteAll =
        loadMuteAll();

    if (
        muteAll[groupJid]?.enabled
    ) {

        try {

            const isAdmin =
                await senderIsAdmin(
                    sock,
                    groupJid,
                    msg
                );

            if (!isAdmin) {

                return await deleteGroupMessage(
                    sock,
                    groupJid,
                    msg
                );

            }

        } catch (err) {

            // Fail open if WhatsApp metadata cannot be fetched. It is
            // safer to let one message through than accidentally delete
            // an admin's message because admin status could not be read.
            console.log(
                "Mute-all admin check failed:",
                err.message
            );

        }

    }

    const muted =
        loadMuted();

    const aliases =
        senderAliases(
            msg
        );

    const mutedKey =
        findStoredKey(
            muted[groupJid],
            aliases
        );

    const user =
        mutedKey
            ? muted[groupJid]?.[mutedKey]
            : null;

    if (!user) return false;


    // User's mute has expired
    if (Date.now() >= user.expires) {

        delete muted[groupJid][mutedKey];

        clearSpamKickRule(
            groupJid,
            mutedKey
        );

        if (
            Object.keys(
                muted[groupJid]
            ).length === 0
        ) {

            delete muted[groupJid];

        }

        saveMuted(muted);

        const tag =
            "@" + mutedKey.split("@")[0];

        const text =
            user.custom
            ?
`${tag}

⏰ Time's up.

You are free to type now. 😌`
            :
`${tag}

😂 The admins forgot you.

You should be grateful Lord Crimson remembered you.

You are free to type now. 😌💙`;

        await sock.sendMessage(
            groupJid,
            {
                text,
                mentions: [mutedKey]
            }
        );

        return;

    }


    // Optional AI moderation escalation:
    // if an admin asked Zorex to "mute them and kick if they keep
    // spamming", count attempted messages while the mute is active.
    const rules =
        loadAiModerationRules();

    const rule =
        rules[groupJid]?.[mutedKey];

    if (
        rule?.type === "kick_if_spam"
    ) {

        if (
            rule.expiresAt &&
            Date.now() >= rule.expiresAt
        ) {

            clearSpamKickRule(
                groupJid,
                mutedKey
            );

        } else {

            const now =
                Date.now();

            const windowMs =
                Number(
                    rule.windowMs ||
                    30000
                );

            const limit =
                Number(
                    rule.limit ||
                    5
                );

            rule.hits =
                (
                    Array.isArray(
                        rule.hits
                    )
                        ? rule.hits
                        : []
                )
                    .filter(
                        timestamp =>
                            now -
                            Number(timestamp) <=
                            windowMs
                    );

            rule.hits.push(
                now
            );

            rules[groupJid][mutedKey] =
                rule;

            saveAiModerationRules(
                rules
            );

            if (
                rule.hits.length >=
                limit
            ) {

                try {

                    await sock.groupParticipantsUpdate(
                        groupJid,
                        [mutedKey],
                        "remove"
                    );

                    delete muted[groupJid][mutedKey];

                    if (
                        Object.keys(
                            muted[groupJid]
                        ).length === 0
                    ) {
                        delete muted[groupJid];
                    }

                    saveMuted(
                        muted
                    );

                    clearSpamKickRule(
                        groupJid,
                        mutedKey
                    );

                    await sock.sendMessage(
                        groupJid,
                        {
                            text:
`🚫 @${mutedKey.split("@")[0]} was kicked after continuing to spam while muted.

> Trigger: ${limit} messages within ${Math.round(windowMs / 1000)}s.`,
                            mentions:
                                [mutedKey]
                        }
                    );

                    return true;

                } catch (err) {

                    console.log(
                        "Spam escalation kick failed:",
                        err.message
                    );

                }

            }

        }

    }

    // Delete individually muted user's message.
    return await deleteGroupMessage(
        sock,
        groupJid,
        msg
    );

}

module.exports = {
    moderationWatcher,
    armSpamKickRule,
    clearSpamKickRule
};