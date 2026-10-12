"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "zorex-shared-world-test-"));
process.env.DATA_DIR = testDir;

const characters = require("../lib/characterRegistry");
const subscriptions = require("../lib/subscriptionStore");
const worlds = require("../lib/sharedWorldStore");
const { handleSharedWorldMessage } = require("../commands/sharedWorld");
const dataPath = require("../lib/dataPath");

const GROUP = "test-room@g.us";
const OWNER_PN = "111111@s.whatsapp.net";
const OWNER_LID = "owner-test@lid";
const FRIEND_PN = "222222@s.whatsapp.net";
const FRIEND_LID = "friend-test@lid";
const OBSERVER_PN = "333333@s.whatsapp.net";
const OBSERVER_LID = "observer-test@lid";

const sent = [];
const sock = {
    groupMetadata: async () => ({
        participants: [
            { id: OWNER_PN, lid: OWNER_LID, notify: "Owner" },
            { id: FRIEND_PN, lid: FRIEND_LID, notify: "Friend" },
            { id: OBSERVER_PN, lid: OBSERVER_LID, notify: "Observer" }
        ]
    }),
    sendMessage: async (...args) => {
        sent.push(args);
        return { key: { id: "mock-message" } };
    }
};

function groupMessage(name, pn, lid, text, mentions = []) {
    return {
        key: {
            remoteJid: GROUP,
            participant: pn,
            participantAlt: lid,
            fromMe: false
        },
        pushName: name,
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
        const ownerIds = characters.getIdentityAliases({
            key: {
                remoteJid: GROUP,
                participant: OWNER_PN,
                participantAlt: OWNER_LID
            }
        });
        const friendIds = characters.getIdentityAliases({
            key: {
                remoteJid: GROUP,
                participant: FRIEND_PN,
                participantAlt: FRIEND_LID
            }
        });

        assert.equal(ownerIds[0], OWNER_LID, "owner LID should be primary");
        assert.equal(friendIds[0], FRIEND_LID, "friend LID should be primary");
        assert.equal(characters.getSelectedCharacter(ownerIds).id, "chloe", "existing users default to Chloe");

        characters.setSelectedCharacter(friendIds, "chloe");

        const outsideInvite = groupMessage(
            "Owner", OWNER_PN, OWNER_LID, ".chat join @outsider", ["999999@s.whatsapp.net"]
        );
        await handleSharedWorldMessage(sock, outsideInvite);
        assert.equal(worlds.getWorldForGroup(GROUP), null, "non-group user must not be invited");

        const duplicateInvite = groupMessage(
            "Owner", OWNER_PN, OWNER_LID, ".chat join @friend", [FRIEND_PN]
        );
        await handleSharedWorldMessage(sock, duplicateInvite);
        assert.equal(worlds.getWorldForGroup(GROUP), null, "duplicate companion must not create a world");

        characters.setSelectedCharacter(friendIds, "crescent");
        const createInvite = groupMessage(
            "Owner", OWNER_PN, OWNER_LID, ".chat join @friend", [FRIEND_PN]
        );
        const inviteResult = await handleSharedWorldMessage(sock, createInvite);
        assert.equal(inviteResult.consumeMessage, true);
        const pending = worlds.getWorldForGroup(GROUP);
        assert.equal(pending.status, "pending");
        assert.equal(pending.members.length, 1);
        assert.equal(pending.creatorCharacterId, "chloe");
        assert.equal(worlds.getWorldForUser(ownerIds).world.id, pending.id);

        assert.throws(() => worlds.createInitialInvitation({
            groupId: "second-room@g.us",
            creator: { ids: friendIds, name: "Friend", characterId: "crescent" },
            invitee: { ids: ["observer-test@lid"], name: "Observer", characterId: "chloe" },
            memberLimit: 2
        }), err => err.code === "creator_pending_invite",
        "a pending invitee cannot simultaneously create another world");

        // The creator's character is locked as soon as their world is pending.
        const selectionWhilePending = groupMessage(
            "Owner", OWNER_PN, OWNER_LID, ".character select crescent"
        );
        await handleSharedWorldMessage(sock, selectionWhilePending);
        assert.equal(characters.getSelectedCharacter(ownerIds).id, "chloe");

        const acceptInvite = groupMessage(
            "Friend", FRIEND_PN, FRIEND_LID, ".chat join accept"
        );
        await handleSharedWorldMessage(sock, acceptInvite);
        const active = worlds.activeWorldForGroup(GROUP);
        assert.equal(active.status, "active");
        assert.equal(active.members.length, 2);
        assert.equal(active.members[1].characterId, "crescent");

        const summaryUpdated = worlds.updateWorldMemorySummary(
            GROUP,
            "The creator hosts the world at home. Chloe is the creator's assigned companion; Crescent belongs to the visiting friend.",
            1
        );
        assert.equal(summaryUpdated.summaryEventCount, 1);
        assert.match(worlds.getWorldForGroup(GROUP).memorySummary, /creator hosts the world at home/i);

        const memberLine = groupMessage(
            "Friend", FRIEND_PN, FRIEND_LID, "Good evening."
        );
        const memberRoute = await handleSharedWorldMessage(sock, memberLine);
        assert.equal(memberRoute.deferWorldTurn, true);
        assert.equal(memberRoute.suppressChloe, true);

        const observerLine = groupMessage(
            "Observer", OBSERVER_PN, OBSERVER_LID, "Good evening."
        );
        const eventsBeforeObserver = worlds.getWorldEvents(GROUP).length;
        const observerRoute = await handleSharedWorldMessage(sock, observerLine);
        assert.equal(observerRoute.observerMessage, true);
        assert.equal(observerRoute.suppressChloe, true);
        assert.notEqual(observerRoute.deferWorldTurn, true);
        assert.equal(
            worlds.getWorldEvents(GROUP).length,
            eventsBeforeObserver,
            "observer messages must not enter the shared-world memory"
        );

        const ownerExit = groupMessage(
            "Owner", OWNER_PN, OWNER_LID, ".chat exit"
        );
        await handleSharedWorldMessage(sock, ownerExit);
        assert.equal(worlds.activeWorldForGroup(GROUP).members.length, 2, "creator cannot exit");

        const nonOwnerDisband = groupMessage(
            "Friend", FRIEND_PN, FRIEND_LID, ".chat disband"
        );
        await handleSharedWorldMessage(sock, nonOwnerDisband);
        assert.ok(worlds.activeWorldForGroup(GROUP), "ordinary member cannot disband");

        const friendExit = groupMessage(
            "Friend", FRIEND_PN, FRIEND_LID, ".chat exit"
        );
        await handleSharedWorldMessage(sock, friendExit);
        assert.equal(worlds.activeWorldForGroup(GROUP).members.length, 1, "member can exit");

        // Recreate and accept a world, then prove creator inactivity expires it
        // even if the shared group had activity more recently.
        const secondFriend = groupMessage(
            "Owner", OWNER_PN, OWNER_LID, ".chat add @friend", [FRIEND_PN]
        );
        // The existing world now has only the creator, so adding is still permitted.
        await handleSharedWorldMessage(sock, secondFriend);
        await handleSharedWorldMessage(sock, acceptInvite);
        const activeAgain = worlds.activeWorldForGroup(GROUP);
        assert.equal(activeAgain.members.length, 2);

        const storeFile = dataPath("sharedWorlds.json");
        const saved = JSON.parse(fs.readFileSync(storeFile, "utf8"));
        saved.worlds[GROUP].ownerLastSeenAt = Date.now() - worlds.WORLD_AFK_MS - 1000;
        saved.worlds[GROUP].lastActivityAt = Date.now();
        fs.writeFileSync(storeFile, JSON.stringify(saved, null, 2));

        assert.equal(worlds.activeWorldForGroup(GROUP), null, "creator AFK for 30 days should disband world");
        assert.equal(worlds.getWorldForGroup(GROUP), null, "expired world removed");

        // Subscription access stays separate from gambling/other commands.
        assert.equal(subscriptions.getWorldMemberLimit(ownerIds), 2, "unsubscribed user gets free world capacity");
        subscriptions.setSubscription(ownerIds, {
            plan: "standard",
            startedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            orderId: "test-order"
        });
        assert.equal(subscriptions.getWorldMemberLimit(ownerIds), 5, "active paid plan gets five-member capacity");

        // All messages sent in tests are mock-only. No API calls or real WhatsApp
        // sends happen because shared-world turns are only queued by the entrypoint.
        console.log("PASS: LID-first sender identity");
        console.log("PASS: existing users default to Chloe");
        console.log("PASS: duplicate companion invitations are rejected");
        console.log("PASS: invite/accept creates an active world");
        console.log("PASS: character selection is locked in a pending world");
        console.log("PASS: world members trigger roleplay; observers do not");
        console.log("PASS: creator cannot exit and non-owner cannot disband");
        console.log("PASS: ordinary member can exit");
        console.log("PASS: creator inactivity disbands after 30 days");
        console.log("PASS: free and paid world size limits");
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
