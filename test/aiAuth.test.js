"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "zorex-ai-auth-"));
process.env.DATA_DIR = testDir;
process.env.AI_PIN_PEPPER = "legacy-configured-pepper";

const userJid = "2348000000001@s.whatsapp.net";
fs.writeFileSync(
    path.join(testDir, "users.json"),
    JSON.stringify({
        [userJid]: { name: "Test User", registeredAt: "2026-01-01T00:00:00.000Z" }
    }, null, 2)
);

const aiUsersPath = path.join(testDir, "aiusers.json");
const store = require("../lib/aiUserStore");
const { authorizeAiRequest } = require("../lib/aiAuth");

function message(jid, text, group = false) {
    return {
        key: {
            remoteJid: group ? "test-group@g.us" : jid,
            ...(group ? { participant: jid } : {})
        },
        message: { conversation: text },
        pushName: "Test User"
    };
}

const sent = [];
const sock = {
    sendMessage: async (chatId, payload, options) => {
        sent.push({ chatId, payload, options });
        return {};
    }
};

async function main() {
    try {
        const requestMsg = message(userJid, ".ai show my balance");
        const blocked = await authorizeAiRequest(sock, requestMsg, "show my balance");
        assert.equal(blocked.allowed, false);
        assert.ok(sent.some(item => /create your private 4-digit AI PIN/i.test(item.payload.text)));

        const profileId = userJid;
        const setupResult = await authorizeAiRequest(
            sock,
            message(userJid, ".ai 4827"),
            "4827"
        );
        assert.equal(setupResult.allowed, false);
        assert.equal(setupResult.resumeRequest.msg, requestMsg);
        assert.equal(setupResult.resumeRequest.text, ".ai show my balance",
            "a first-time PIN setup should return the original request for automatic continuation");

        const setupProfile = store.getAiProfile(profileId).profile;
        assert.equal(setupProfile.pinHashVersion, 2);
        assert.ok(fs.existsSync(path.join(testDir, "ai-pin-secret.key")));

        // New hashes must not depend on a subsequently changed environment pepper.
        process.env.AI_PIN_PEPPER = "a-different-deployment-value";
        assert.equal(store.verifyPin(profileId, "4827").ok, true,
            "a changed AI_PIN_PEPPER environment value must not break an existing v2 PIN");

        // Exact canonical profile IDs win over a stale duplicate alias entry.
        const saved = JSON.parse(fs.readFileSync(aiUsersPath, "utf8"));
        const canonical = saved[profileId];
        const duplicateId = "legacy-duplicate@lid";
        const reordered = {
            [duplicateId]: {
                aliases: [profileId],
                pinSalt: "0123456789abcdef0123456789abcdef",
                pinHash: "f".repeat(128),
                authenticatedUntil: 0,
                failedAttempts: 0,
                lockedUntil: 0
            },
            [profileId]: canonical
        };
        fs.writeFileSync(aiUsersPath, JSON.stringify(reordered, null, 2));
        const identityMsg = message(userJid, ".ai show my balance");
        const profile = store.ensureAiProfile(profileId, identityMsg, "Test User");
        assert.equal(profile.profileId, profileId);
        assert.equal(profile.profile.pinHash, canonical.pinHash);

        // An expired session should similarly retain and resume the user's request.
        const expiredStore = JSON.parse(fs.readFileSync(aiUsersPath, "utf8"));
        expiredStore[profileId].authenticatedUntil = 0;
        fs.writeFileSync(aiUsersPath, JSON.stringify(expiredStore, null, 2));

        const originalAfterExpiry = message(userJid, ".ai show my company");
        const needsLogin = await authorizeAiRequest(
            sock,
            originalAfterExpiry,
            "show my company"
        );
        assert.equal(needsLogin.allowed, false);

        const loginResult = await authorizeAiRequest(
            sock,
            message(userJid, ".ai 4827"),
            "4827"
        );
        assert.equal(loginResult.allowed, false);
        assert.equal(loginResult.resumeRequest.msg, originalAfterExpiry);
        assert.equal(loginResult.resumeRequest.text, ".ai show my company");

        // Legacy hashes written with no pepper can be verified and upgraded once.
        const latest = JSON.parse(fs.readFileSync(aiUsersPath, "utf8"));
        const legacyId = "legacy-pin@s.whatsapp.net";
        const legacySalt = crypto.randomBytes(16).toString("hex");
        latest[legacyId] = {
            createdAt: new Date().toISOString(),
            displayName: "Legacy User",
            aliases: [],
            pinSalt: legacySalt,
            pinHash: crypto.scryptSync("3691:", legacySalt, 64).toString("hex"),
            authenticatedUntil: 0,
            failedAttempts: 0,
            lockedUntil: 0,
            pendingAuth: null
        };
        fs.writeFileSync(aiUsersPath, JSON.stringify(latest, null, 2));

        const legacyResult = store.verifyPin(legacyId, "3691");
        assert.equal(legacyResult.ok, true);
        assert.equal(store.getAiProfile(legacyId).profile.pinHashVersion, 2);
        assert.equal(store.verifyPin(legacyId, "3691").ok, true);

        console.log("PASS: exact canonical AI profile takes priority over stale phone/LID aliases");
        console.log("PASS: PIN hashes remain valid when AI_PIN_PEPPER changes after v2 migration");
        console.log("PASS: compatible legacy PIN hashes upgrade after successful verification");
        console.log("PASS: PIN setup and expired-session verification resume the original request");
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
