"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "zorex-sus-test-"));
process.env.DATA_DIR = testDir;

const { MAIN_OWNER, MAIN_OWNER_PHONE } = require("../config");
const subscriptions = require("../lib/subscriptionStore");
const { startOwner } = require("../commands/owner");

const GROUP = "subscription-test@g.us";
const TARGET_PN = "2349000000001@s.whatsapp.net";
const TARGET_LID = "subscriber-test@lid";
const OTHER_PN = "2349000000002@s.whatsapp.net";

const sent = [];
const sock = {
    groupMetadata: async () => ({
        participants: [
            { id: TARGET_PN, lid: TARGET_LID, notify: "Subscriber" },
            { id: MAIN_OWNER_PHONE, lid: MAIN_OWNER, notify: "Main Owner" },
            { id: OTHER_PN, notify: "Other Member" }
        ]
    }),
    sendMessage: async (...args) => {
        sent.push(args);
        return { key: { id: "mock-subscription-message" } };
    }
};

function message(senderPn, senderLid, text, mentions = []) {
    return {
        key: {
            remoteJid: GROUP,
            participant: senderPn,
            participantAlt: senderLid,
            fromMe: false
        },
        message: {
            extendedTextMessage: {
                text,
                contextInfo: { mentionedJid: mentions }
            }
        }
    };
}

async function main() {
    try {
        assert.ok(MAIN_OWNER || MAIN_OWNER_PHONE, "main owner should be configured");

        const unauthorized = message(
            OTHER_PN, null,
            ".sus activate @2349000000001 standard 30 ORDER-UNTRUSTED",
            [TARGET_PN]
        );
        await startOwner(sock, unauthorized, unauthorized.message.extendedTextMessage.text);
        assert.equal(
            subscriptions.getSubscription([TARGET_PN, TARGET_LID]).active,
            false,
            "non-main-owner activation must not grant a plan"
        );

        const helpText = ".sus help";
        await startOwner(sock, message(OTHER_PN, null, helpText), helpText);
        const publicHelp = sent[sent.length - 1][1].text;
        assert.match(publicHelp, /Standard, Pro and Ultra plans allow up to 5/i);
        assert.doesNotMatch(publicHelp, /manual|payment is not verified|provider/i,
            ".sus help must not expose internal payment-processing notes");

        const activationText = ".sus activate @2349000000001 standard 30 ORDER-123";
        await startOwner(
            sock,
            message(MAIN_OWNER_PHONE, MAIN_OWNER, activationText, [TARGET_PN]),
            activationText
        );

        const active = subscriptions.getSubscription([TARGET_LID, TARGET_PN]);
        assert.equal(active.active, true);
        assert.equal(active.plan, "standard");
        assert.equal(active.orderId, "ORDER-123");
        assert.ok(new Date(active.expiresAt).getTime() > Date.now());
        const activationMessage = sent.find(item =>
            String(item[1].text || "").includes("Subscription activated for")
        )[1].text;
        assert.match(activationMessage, /Subscription activated for/i);
        assert.doesNotMatch(activationMessage, /manual|not automatically verified|provider/i,
            "activation result must not expose internal payment-processing notes");

        const statusText = ".sus status";
        await startOwner(
            sock,
            message(MAIN_OWNER_PHONE, MAIN_OWNER, statusText),
            statusText
        );
        assert.match(sent[sent.length - 1][1].text, /Subscription: Free/i,
            "users without a paid plan should be able to check their own status");

        const revokeText = ".sus revoke @2349000000001";
        await startOwner(
            sock,
            message(MAIN_OWNER_PHONE, MAIN_OWNER, revokeText, [TARGET_PN]),
            revokeText
        );
        assert.equal(
            subscriptions.getSubscription([TARGET_LID, TARGET_PN]).active,
            false,
            "main owner should be able to revoke a subscription"
        );

        assert.doesNotMatch(
            sent.map(item => String(item[1].text || "")).join("\n"),
            /activation is manual|payment was not automatically verified|does not verify payments with a provider/i,
            "public subscription output must keep payment-processing implementation notes private"
        );

        console.log("PASS: .sus activation is restricted to MAIN_OWNER");
        console.log("PASS: target membership and LID/phone aliases are resolved");
        console.log("PASS: manual activation records plan, expiry and payment reference");
        console.log("PASS: subscription status and revocation work");
        console.log("PASS: .sus help and responses omit internal payment-processing notes");
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
