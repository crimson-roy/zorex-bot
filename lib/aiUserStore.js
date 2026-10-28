"use strict";

const fs = require("fs");
const crypto = require("crypto");
const dataPath = require("./dataPath");

const USERS_FILE = dataPath("users.json");
const AI_USERS_FILE = dataPath("aiusers.json");
const AI_HISTORY_FILE = dataPath("aiusershistory.json");
const AI_PIN_SECRET_FILE = dataPath("ai-pin-secret.key");

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
    const orderedAliases = [
        ...new Set(
            (Array.isArray(aliases) ? aliases : [])
                .filter(Boolean)
                .map(String)
        )
    ];

    // Prefer an exact canonical profile key before following an alias.
    // Otherwise a stale duplicate profile can capture a phone/LID lookup
    // and make a valid PIN appear incorrect for the same registered user.
    for (const alias of orderedAliases) {
        const profile = aiUsers[alias];
        if (profile && typeof profile === "object") {
            return { profileId: alias, profile };
        }
    }

    for (const [profileId, profile] of Object.entries(aiUsers)) {
        const storedAliases = Array.isArray(profile?.aliases)
            ? profile.aliases.map(String)
            : [];

        if (storedAliases.some(alias => orderedAliases.includes(alias))) {
            return { profileId, profile };
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
    salt,
    pepper = String(process.env.AI_PIN_PEPPER || "")
) {
    return crypto
        .scryptSync(
            `${pin}:${pepper}`,
            salt,
            64
        )
        .toString("hex");
}

// New PIN hashes use a random secret stored beside the persistent AI user
// data, so an unrelated environment-variable change cannot invalidate PINs.
// The secret is created only when setting a new PIN or migrating a legacy one.
function getPinSecret(createIfMissing = true) {
    try {
        const secret = fs.readFileSync(AI_PIN_SECRET_FILE, "utf8").trim();
        return /^[a-f0-9]{64}$/i.test(secret) ? secret : null;
    } catch (err) {
        if (err.code !== "ENOENT") throw err;
        if (!createIfMissing) return null;
    }

    const generated = crypto.randomBytes(32).toString("hex");
    try {
        fs.writeFileSync(AI_PIN_SECRET_FILE, generated + "\n", {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx"
        });
        return generated;
    } catch (err) {
        if (err.code !== "EEXIST") throw err;
        try {
            const existing = fs.readFileSync(AI_PIN_SECRET_FILE, "utf8").trim();
            return /^[a-f0-9]{64}$/i.test(existing) ? existing : null;
        } catch (_) {
            return null;
        }
    }
}

function hashMatches(expected, candidateHex) {
    if (!/^[a-f0-9]{128}$/i.test(String(candidateHex || ""))) {
        return false;
    }

    const actual = Buffer.from(candidateHex, "hex");
    return expected.length === actual.length &&
        expected.length === 64 &&
        crypto.timingSafeEqual(expected, actual);
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

    const pinSecret = getPinSecret(true);
    if (!pinSecret) {
        return {
            ok: false,
            reason: "The AI PIN verifier could not be initialized."
        };
    }

    profile.pinHash =
        hashPin(
            pin,
            salt,
            pinSecret
        );
    profile.pinHashVersion = 2;

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

    const expected = Buffer.from(String(profile.pinHash || ""), "hex");
    let matches = false;
    let upgradeLegacyHash = false;

    if (Number(profile.pinHashVersion) === 2) {
        const pinSecret = getPinSecret(false);

        // Do not silently generate a replacement secret if the persistent
        // secret file is missing: that would lock out every v2 PIN.
        if (!pinSecret) {
            return {
                ok: false,
                unavailable: true,
                reason: "The saved AI PIN verifier is unavailable."
            };
        }

        matches = hashMatches(
            expected,
            hashPin(pin, profile.pinSalt, pinSecret)
        );
    } else {
        // Older releases used AI_PIN_PEPPER directly. Accept the current
        // setting and the historical empty-pepper form, then migrate on a
        // successful login so future verification no longer depends on env.
        const legacyPeppers = [
            String(process.env.AI_PIN_PEPPER || ""),
            ""
        ];

        for (const legacyPepper of [...new Set(legacyPeppers)]) {
            if (hashMatches(
                expected,
                hashPin(pin, profile.pinSalt, legacyPepper)
            )) {
                matches = true;
                upgradeLegacyHash = true;
                break;
            }
        }
    }

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

    if (upgradeLegacyHash) {
        const newSalt = crypto.randomBytes(16).toString("hex");
        const pinSecret = getPinSecret(true);

        if (!pinSecret) {
            return {
                ok: false,
                unavailable: true,
                reason: "The saved AI PIN verifier could not be upgraded."
            };
        }

        profile.pinSalt = newSalt;
        profile.pinHash = hashPin(pin, newSalt, pinSecret);
        profile.pinHashVersion = 2;
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

function getConversationMessages(
    profileId,
    limit = 8
) {
    const history =
        loadHistory();

    const list =
        Array.isArray(
            history[profileId]
        )
            ? history[profileId]
            : [];

    const allowedTypes =
        new Set([
            "answer",
            "vision",
            "document"
        ]);

    const conversational =
        list
            .filter(entry =>
                allowedTypes.has(
                    String(
                        entry.type ||
                        "answer"
                    )
                ) &&
                String(
                    entry.user ||
                    ""
                ).trim() &&
                String(
                    entry.assistant ||
                    ""
                ).trim()
            )
            .slice(
                -Math.max(
                    1,
                    Math.min(
                        Number(limit) || 8,
                        12
                    )
                )
            );

    const messages = [];

    for (const entry of conversational) {
        messages.push({
            role:
                "user",
            content:
                String(
                    entry.user
                ).slice(
                    0,
                    1800
                )
        });

        messages.push({
            role:
                "assistant",
            content:
                String(
                    entry.assistant
                ).slice(
                    0,
                    3000
                )
        });
    }

    return messages;
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
    getConversationMessages,
    clearHistory
};
