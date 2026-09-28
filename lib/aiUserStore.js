"use strict";

const fs = require("fs");
const crypto = require("crypto");
const dataPath = require("./dataPath");

const USERS_FILE = dataPath("users.json");
const AI_USERS_FILE = dataPath("aiusers.json");
const AI_HISTORY_FILE = dataPath("aiusershistory.json");

const SESSION_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_ENTRIES = 100;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function readJson(file, fallback = {}) {
    try {
        if (!fs.existsSync(file)) {
            fs.writeFileSync(
                file,
                JSON.stringify(fallback, null, 2)
            );
            return JSON.parse(
                JSON.stringify(fallback)
            );
        }

        const parsed =
            JSON.parse(
                fs.readFileSync(
                    file,
                    "utf8"
                )
            );

        return parsed &&
            typeof parsed === "object"
            ? parsed
            : JSON.parse(
                JSON.stringify(fallback)
            );

    } catch (_) {
        return JSON.parse(
            JSON.stringify(fallback)
        );
    }
}

function writeJson(file, value) {
    const temp =
        `${file}.tmp-${process.pid}-${Date.now()}`;

    fs.writeFileSync(
        temp,
        JSON.stringify(
            value,
            null,
            2
        )
    );

    fs.renameSync(
        temp,
        file
    );
}

function isUserJid(value) {
    const jid =
        String(value || "");

    return (
        jid.endsWith("@s.whatsapp.net") ||
        jid.endsWith("@lid")
    );
}

function identityAliases(msg) {
    const key =
        msg?.key || {};

    const context =
        msg?.message
            ?.extendedTextMessage
            ?.contextInfo;

    const candidates = [
        key.participant,
        key.participantAlt,
        key.senderPn,
        key.senderLid,
        key.remoteJidAlt,
        context?.participant,
        context?.participantAlt
    ];

    if (
        key.remoteJid &&
        !String(key.remoteJid)
            .endsWith("@g.us")
    ) {
        candidates.push(
            key.remoteJid
        );
    }

    return [
        ...new Set(
            candidates
                .filter(isUserJid)
                .map(String)
        )
    ];
}

function preferredDmJid(msg) {
    const aliases =
        identityAliases(msg);

    return (
        aliases.find(jid =>
            jid.endsWith(
                "@s.whatsapp.net"
            )
        ) ||
        aliases.find(jid =>
            jid.endsWith("@lid")
        ) ||
        null
    );
}

function isGroupMessage(msg) {
    return String(
        msg?.key?.remoteJid || ""
    ).endsWith("@g.us");
}

function findRegisteredUser(msg) {
    const users =
        readJson(
            USERS_FILE,
            {}
        );

    const aliases =
        identityAliases(msg);

    for (const alias of aliases) {
        if (users[alias]) {
            return {
                userId: alias,
                user: users[alias],
                users,
                aliases
            };
        }
    }

    return {
        userId: null,
        user: null,
        users,
        aliases
    };
}

function loadAiUsers() {
    return readJson(
        AI_USERS_FILE,
        {}
    );
}

function saveAiUsers(value) {
    writeJson(
        AI_USERS_FILE,
        value
    );
}

function findAiProfileByAliases(
    aiUsers,
    aliases
) {
    for (
        const [profileId, profile]
        of Object.entries(aiUsers)
    ) {
        if (
            aliases.includes(profileId)
        ) {
            return {
                profileId,
                profile
            };
        }

        const storedAliases =
            Array.isArray(profile.aliases)
                ? profile.aliases
                : [];

        if (
            storedAliases.some(alias =>
                aliases.includes(alias)
            )
        ) {
            return {
                profileId,
                profile
            };
        }
    }

    return null;
}

function ensureAiProfile(
    registeredUserId,
    msg,
    displayName
) {
    const aiUsers =
        loadAiUsers();

    const aliases =
        identityAliases(msg);

    let found =
        findAiProfileByAliases(
            aiUsers,
            [
                registeredUserId,
                ...aliases
            ]
        );

    let profileId;
    let profile;

    if (found) {
        profileId =
            found.profileId;

        profile =
            found.profile;

    } else {
        profileId =
            registeredUserId;

        profile = {
            createdAt:
                new Date().toISOString(),
            displayName:
                displayName ||
                "Zorex User",
            aliases: [],
            pinSalt: null,
            pinHash: null,
            authenticatedUntil: 0,
            failedAttempts: 0,
            lockedUntil: 0,
            pendingAuth: null
        };

        aiUsers[profileId] =
            profile;
    }

    profile.displayName =
        displayName ||
        profile.displayName ||
        "Zorex User";

    profile.aliases = [
        ...new Set([
            ...(profile.aliases || []),
            registeredUserId,
            ...aliases
        ])
    ];

    saveAiUsers(
        aiUsers
    );

    return {
        profileId,
        profile
    };
}

function getAiProfile(profileId) {
    const aiUsers =
        loadAiUsers();

    return {
        aiUsers,
        profile:
            aiUsers[profileId] ||
            null
    };
}

function hashPin(
    pin,
    salt
) {
    const pepper =
        String(
            process.env.AI_PIN_PEPPER ||
            ""
        );

    return crypto
        .scryptSync(
            `${pin}:${pepper}`,
            salt,
            64
        )
        .toString("hex");
}

function validPin(pin) {
    return /^\d{4}$/.test(
        String(pin || "")
    );
}

function setPin(
    profileId,
    pin
) {
    if (!validPin(pin)) {
        return {
            ok: false,
            reason:
                "PIN must be exactly 4 digits."
        };
    }

    const {
        aiUsers,
        profile
    } =
        getAiProfile(
            profileId
        );

    if (!profile) {
        return {
            ok: false,
            reason:
                "AI profile does not exist."
        };
    }

    const salt =
        crypto
            .randomBytes(16)
            .toString("hex");

    profile.pinSalt =
        salt;

    profile.pinHash =
        hashPin(
            pin,
            salt
        );

    profile.pinSetAt =
        new Date()
            .toISOString();

    profile.authenticatedUntil =
        Date.now() +
        SESSION_MS;

    profile.failedAttempts = 0;
    profile.lockedUntil = 0;
    profile.pendingAuth = null;

    aiUsers[profileId] =
        profile;

    saveAiUsers(
        aiUsers
    );

    return {
        ok: true,
        authenticatedUntil:
            profile.authenticatedUntil
    };
}

function hasPin(profile) {
    return Boolean(
        profile?.pinHash &&
        profile?.pinSalt
    );
}

function sessionActive(profile) {
    return (
        hasPin(profile) &&
        Number(
            profile.authenticatedUntil ||
            0
        ) > Date.now()
    );
}

function verifyPin(
    profileId,
    pin
) {
    if (!validPin(pin)) {
        return {
            ok: false,
            reason:
                "PIN must be exactly 4 digits."
        };
    }

    const {
        aiUsers,
        profile
    } =
        getAiProfile(
            profileId
        );

    if (
        !profile ||
        !hasPin(profile)
    ) {
        return {
            ok: false,
            reason:
                "No AI PIN has been set yet."
        };
    }

    const now =
        Date.now();

    if (
        Number(
            profile.lockedUntil ||
            0
        ) > now
    ) {
        return {
            ok: false,
            locked: true,
            retryAt:
                profile.lockedUntil
        };
    }

    const expected =
        Buffer.from(
            profile.pinHash,
            "hex"
        );

    const actual =
        Buffer.from(
            hashPin(
                pin,
                profile.pinSalt
            ),
            "hex"
        );

    const matches =
        expected.length ===
            actual.length &&
        crypto.timingSafeEqual(
            expected,
            actual
        );

    if (!matches) {
        profile.failedAttempts =
            Number(
                profile.failedAttempts ||
                0
            ) + 1;

        if (
            profile.failedAttempts >=
            MAX_FAILED_ATTEMPTS
        ) {
            profile.lockedUntil =
                now +
                LOCKOUT_MS;

            profile.failedAttempts =
                0;
        }

        aiUsers[profileId] =
            profile;

        saveAiUsers(
            aiUsers
        );

        return {
            ok: false,
            locked:
                profile.lockedUntil >
                now,
            retryAt:
                profile.lockedUntil ||
                0
        };
    }

    profile.authenticatedUntil =
        now +
        SESSION_MS;

    profile.lastAuthenticatedAt =
        new Date(now)
            .toISOString();

    profile.failedAttempts = 0;
    profile.lockedUntil = 0;
    profile.pendingAuth = null;

    aiUsers[profileId] =
        profile;

    saveAiUsers(
        aiUsers
    );

    return {
        ok: true,
        authenticatedUntil:
            profile.authenticatedUntil
    };
}

function setPendingAuth(
    profileId,
    type
) {
    const {
        aiUsers,
        profile
    } =
        getAiProfile(
            profileId
        );

    if (!profile) {
        return;
    }

    profile.pendingAuth = {
        type:
            type === "setup"
                ? "setup"
                : "login",
        requestedAt:
            Date.now()
    };

    aiUsers[profileId] =
        profile;

    saveAiUsers(
        aiUsers
    );
}

function updateDisplayName(
    registeredUserId,
    displayName
) {
    const aiUsers =
        loadAiUsers();

    const found =
        findAiProfileByAliases(
            aiUsers,
            [registeredUserId]
        );

    if (!found) {
        return false;
    }

    found.profile.displayName =
        displayName;

    aiUsers[found.profileId] =
        found.profile;

    saveAiUsers(
        aiUsers
    );

    return true;
}

function loadHistory() {
    return readJson(
        AI_HISTORY_FILE,
        {}
    );
}

function appendHistory(
    profileId,
    entry
) {
    const history =
        loadHistory();

    const list =
        Array.isArray(
            history[profileId]
        )
            ? history[profileId]
            : [];

    list.push({
        id:
            `ai_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
        time:
            new Date().toISOString(),
        type:
            String(
                entry.type ||
                "answer"
            ),
        user:
            String(
                entry.user ||
                ""
            ).slice(0, 4000),
        assistant:
            String(
                entry.assistant ||
                ""
            ).slice(0, 8000)
    });

    history[profileId] =
        list.slice(
            -MAX_HISTORY_ENTRIES
        );

    writeJson(
        AI_HISTORY_FILE,
        history
    );
}

function getHistory(
    profileId,
    limit = 10
) {
    const history =
        loadHistory();

    const list =
        Array.isArray(
            history[profileId]
        )
            ? history[profileId]
            : [];

    return list.slice(
        -Math.max(
            1,
            Math.min(
                Number(limit) || 10,
                25
            )
        )
    );
}

function clearHistory(
    profileId
) {
    const history =
        loadHistory();

    history[profileId] = [];

    writeJson(
        AI_HISTORY_FILE,
        history
    );
}

module.exports = {
    SESSION_MS,
    MAX_HISTORY_ENTRIES,
    identityAliases,
    preferredDmJid,
    isGroupMessage,
    findRegisteredUser,
    ensureAiProfile,
    getAiProfile,
    hasPin,
    sessionActive,
    setPin,
    verifyPin,
    setPendingAuth,
    updateDisplayName,
    appendHistory,
    getHistory,
    clearHistory
};
