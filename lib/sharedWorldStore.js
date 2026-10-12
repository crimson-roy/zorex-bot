"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dataPath = require("./dataPath");
const { normalizeAliases, normalizeJid } = require("./characterRegistry");

const STORE_PATH = dataPath("sharedWorlds.json");
const WORLD_AFK_MS = 30 * 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 10 * 60 * 1000;

function emptyStore() {
    return { version: 1, worlds: {}, invitations: {} };
}

function saveStore(store) {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const temp = STORE_PATH + "." + process.pid + ".tmp";

    fs.writeFileSync(temp, JSON.stringify(store, null, 2) + "\n", {
        mode: 0o600
    });
    fs.renameSync(temp, STORE_PATH);
    fs.chmodSync(STORE_PATH, 0o600);
}

function sweep(store, now = Date.now()) {
    let changed = false;

    for (const [groupId, world] of Object.entries(store.worlds || {})) {
        const ownerLastSeen = Number(world.ownerLastSeenAt || world.createdAt || now);

        // The creator's inactivity timer is independent of other members' activity.
        if (now - ownerLastSeen >= WORLD_AFK_MS) {
            delete store.worlds[groupId];
            for (const [inviteId, invite] of Object.entries(store.invitations)) {
                if (invite.worldId === world.id) delete store.invitations[inviteId];
            }
            changed = true;
        }
    }

    for (const [inviteId, invite] of Object.entries(store.invitations || {})) {
        if (Number(invite.expiresAt) <= now) {
            delete store.invitations[inviteId];
            changed = true;
        }
    }

    // An unaccepted first invitation does not leave an empty world permanently behind.
    for (const [groupId, world] of Object.entries(store.worlds || {})) {
        const hasPending = Object.values(store.invitations).some(
            invite => invite.worldId === world.id
        );

        if (world.status === "pending" &&
            (world.members || []).length === 1 &&
            !hasPending) {
            delete store.worlds[groupId];
            changed = true;
        }
    }

    return changed;
}

function loadStore(now = Date.now()) {
    if (!fs.existsSync(STORE_PATH)) return emptyStore();

    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Shared-world store has an invalid shape.");
    }

    raw.version = 1;
    raw.worlds = raw.worlds && typeof raw.worlds === "object" ? raw.worlds : {};
    raw.invitations = raw.invitations && typeof raw.invitations === "object"
        ? raw.invitations
        : {};

    if (sweep(raw, now)) saveStore(raw);
    return raw;
}

function sameIdentity(left, right) {
    const rightSet = new Set(normalizeAliases(right));
    return normalizeAliases(left).some(id => rightSet.has(id));
}

function makeError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function findWorldInStoreByUser(store, aliases) {
    for (const world of Object.values(store.worlds)) {
        const member = (world.members || []).find(
            candidate => sameIdentity(candidate.ids, aliases)
        );
        if (member) return { world, member };
    }
    return null;
}

function findPendingInvite(store, groupId, inviteeAliases) {
    return Object.values(store.invitations).find(invite =>
        invite.groupId === groupId &&
        sameIdentity(invite.inviteeIds, inviteeAliases)
    ) || null;
}

function findAnyPendingInviteForUser(store, aliases) {
    return Object.values(store.invitations).find(
        invite => sameIdentity(invite.inviteeIds, aliases)
    ) || null;
}

function activeWorldForGroup(groupId) {
    const store = loadStore();
    const world = store.worlds[groupId] || null;
    return world && world.status === "active" ? world : null;
}

function getWorldForGroup(groupId) {
    return loadStore().worlds[groupId] || null;
}

function getWorldForUser(aliases) {
    const store = loadStore();
    return findWorldInStoreByUser(store, aliases);
}

function getPendingInvitation(groupId, aliases) {
    const store = loadStore();
    return findPendingInvite(store, groupId, aliases);
}

function createInitialInvitation(options) {
    const now = options.now || Date.now();
    const groupId = normalizeJid(options.groupId);
    const creatorIds = normalizeAliases(options.creator?.ids);
    const inviteeIds = normalizeAliases(options.invitee?.ids);

    if (!groupId || !groupId.endsWith("@g.us")) {
        throw makeError("group_only", "Shared worlds can only be created inside a WhatsApp group.");
    }
    if (!creatorIds.length || !inviteeIds.length) {
        throw makeError("identity_missing", "I couldn't identify both WhatsApp users.");
    }
    if (sameIdentity(creatorIds, inviteeIds)) {
        throw makeError("self_invite", "You can't invite yourself into your world.");
    }
    if (!options.creator?.characterId || !options.invitee?.characterId) {
        throw makeError("character_missing", "Both users need a selected companion first.");
    }
    if (options.creator.characterId === options.invitee.characterId) {
        throw makeError("duplicate_character", "You and your guest must bring different companions.");
    }

    const store = loadStore(now);

    if (store.worlds[groupId]) {
        throw makeError("world_exists", "This group already has a world. The creator can use .chat add @user to invite someone.");
    }
    if (findWorldInStoreByUser(store, creatorIds)) {
        throw makeError("creator_in_world", "You already belong to a shared world.");
    }
    if (findWorldInStoreByUser(store, inviteeIds)) {
        throw makeError("invitee_in_world", "That user already belongs to another shared world.");
    }
    if (findAnyPendingInviteForUser(store, inviteeIds)) {
        throw makeError("invite_pending", "That user already has a pending shared-world invitation.");
    }

    const worldId = crypto.randomUUID();
    const creator = {
        ids: creatorIds,
        id: creatorIds[0],
        name: String(options.creator.name || "World creator"),
        characterId: options.creator.characterId,
        role: "creator",
        joinedAt: now,
        lastSeenAt: now
    };

    const world = {
        id: worldId,
        groupId,
        status: "pending",
        creatorId: creator.id,
        creatorName: creator.name,
        creatorCharacterId: creator.characterId,
        planAtCreation: options.plan || "free",
        memberLimit: options.memberLimit === 5 ? 5 : 2,
        createdAt: now,
        ownerLastSeenAt: now,
        lastActivityAt: now,
        creatorStorySeed: Array.isArray(options.creatorStorySeed)
            ? options.creatorStorySeed.slice(-8)
            : [],
        members: [creator],
        events: []
    };

    const invitationId = crypto.randomUUID();
    const invitation = {
        id: invitationId,
        worldId,
        groupId,
        inviterIds: creatorIds,
        inviteeIds,
        inviterName: creator.name,
        inviteeName: String(options.invitee.name || "Guest"),
        inviteeCharacterIdAtInvite: options.invitee.characterId,
        createdAt: now,
        expiresAt: now + INVITE_TTL_MS
    };

    store.worlds[groupId] = world;
    store.invitations[invitationId] = invitation;
    saveStore(store);

    return { world, invitation };
}

function createInvitation(options) {
    const now = options.now || Date.now();
    const groupId = normalizeJid(options.groupId);
    const inviterIds = normalizeAliases(options.inviterIds);
    const inviteeIds = normalizeAliases(options.invitee?.ids);

    if (!groupId || !groupId.endsWith("@g.us")) {
        throw makeError("group_only", "This command only works inside a WhatsApp group.");
    }
    if (!inviteeIds.length) {
        throw makeError("identity_missing", "I couldn't identify that WhatsApp user.");
    }
    if (!options.invitee?.characterId) {
        throw makeError("character_missing", "That user needs a selected companion first.");
    }

    const store = loadStore(now);
    const world = store.worlds[groupId];

    if (!world || world.status !== "active") {
        throw makeError("no_active_world", "There isn't an active shared world in this group yet.");
    }
    if (!sameIdentity(world.members[0]?.ids, inviterIds) ||
        !sameIdentity(world.creatorId, inviterIds)) {
        throw makeError("not_creator", "Only the creator of this world can add members.");
    }
    if (findWorldInStoreByUser(store, inviteeIds)) {
        throw makeError("invitee_in_world", "That user already belongs to a shared world.");
    }
    if (findAnyPendingInviteForUser(store, inviteeIds)) {
        throw makeError("invite_pending", "That user already has a pending shared-world invitation.");
    }
    const effectiveLimit = options.memberLimit === 5 ? 5 : 2;
    if (world.members.length >= effectiveLimit) {
        throw makeError("world_full", "This world has reached the creator's current member limit.");
    }
    world.memberLimit = effectiveLimit;
    if (world.members.some(member => member.characterId === options.invitee.characterId)) {
        throw makeError("duplicate_character", "That companion is already assigned in this world. The visitor must select a different companion.");
    }
    if (Object.values(store.invitations).some(invite => invite.worldId === world.id)) {
        throw makeError("invite_outstanding", "Please wait for the current invitation to be accepted or expire first.");
    }

    const invitationId = crypto.randomUUID();
    const invitation = {
        id: invitationId,
        worldId: world.id,
        groupId,
        inviterIds,
        inviteeIds,
        inviterName: String(options.inviterName || world.creatorName),
        inviteeName: String(options.invitee.name || "Guest"),
        inviteeCharacterIdAtInvite: options.invitee.characterId,
        createdAt: now,
        expiresAt: now + INVITE_TTL_MS
    };

    world.ownerLastSeenAt = sameIdentity(world.creatorId, inviterIds)
        ? now
        : world.ownerLastSeenAt;
    world.lastActivityAt = now;
    store.invitations[invitationId] = invitation;
    saveStore(store);

    return invitation;
}

function acceptInvitation(options) {
    const now = options.now || Date.now();
    const groupId = normalizeJid(options.groupId);
    const inviteeIds = normalizeAliases(options.inviteeIds);

    if (!options.characterId) {
        throw makeError("character_missing", "Select a companion before accepting.");
    }

    const store = loadStore(now);
    const invitation = findPendingInvite(store, groupId, inviteeIds);

    if (!invitation) {
        throw makeError("no_invitation", "You don't have a valid pending invitation in this group.");
    }

    const world = store.worlds[groupId];
    if (!world || world.id !== invitation.worldId) {
        delete store.invitations[invitation.id];
        saveStore(store);
        throw makeError("world_missing", "That world no longer exists.");
    }

    if (findWorldInStoreByUser(store, inviteeIds)) {
        throw makeError("invitee_in_world", "You already belong to a shared world.");
    }
    if (options.memberLimit === 2 || options.memberLimit === 5) {
        world.memberLimit = options.memberLimit;
    }
    if (world.members.length >= Number(world.memberLimit || 2)) {
        throw makeError("world_full", "This world has reached the creator's current member limit.");
    }
    if (world.members.some(member => member.characterId === options.characterId)) {
        throw makeError("duplicate_character", "That companion is already assigned in this world. Select a different companion before accepting.");
    }

    const member = {
        ids: inviteeIds,
        id: inviteeIds[0],
        name: String(options.inviteeName || invitation.inviteeName || "Guest"),
        characterId: options.characterId,
        role: "member",
        joinedAt: now,
        lastSeenAt: now
    };

    world.members.push(member);
    world.status = "active";
    world.startedAt = world.startedAt || now;
    world.lastActivityAt = now;
    if (sameIdentity(world.creatorId, inviteeIds)) world.ownerLastSeenAt = now;

    world.events.push({
        type: "system",
        content:
            member.name + " has joined the shared world with " +
            String(options.characterName || options.characterId) +
            ". Continue from the creator's established story. The guest's private chat history is not available to the world.",
        ts: now
    });


    delete store.invitations[invitation.id];
    saveStore(store);

    return { world, member, invitation };
}

function exitWorld(options) {
    const now = options.now || Date.now();
    const groupId = normalizeJid(options.groupId);
    const ids = normalizeAliases(options.memberIds);
    const store = loadStore(now);
    const world = store.worlds[groupId];

    if (!world || world.status !== "active") {
        throw makeError("no_active_world", "There isn't an active world in this group.");
    }

    if (sameIdentity(world.creatorId, ids)) {
        throw makeError("creator_cannot_exit", "The world creator can't exit their own world. Use .chat disband to close it.");
    }

    const index = world.members.findIndex(member => sameIdentity(member.ids, ids));
    if (index < 0) {
        throw makeError("not_member", "You're not a member of this world.");
    }

    const [member] = world.members.splice(index, 1);
    world.lastActivityAt = now;
    world.events.push({
        type: "system",
        content: member.name + " has left the shared world. Do not narrate their actions or speech.",
        ts: now
    });

    for (const [inviteId, invite] of Object.entries(store.invitations)) {
        if (invite.worldId === world.id) delete store.invitations[inviteId];
    }

    saveStore(store);

    return { world, member };
}

function disbandWorld(options) {
    const now = options.now || Date.now();
    const groupId = normalizeJid(options.groupId);
    const ids = normalizeAliases(options.requesterIds);
    const store = loadStore(now);
    const world = store.worlds[groupId];

    if (!world) throw makeError("no_world", "There isn't a shared world in this group.");
    if (!sameIdentity(world.creatorId, ids)) {
        throw makeError("not_creator", "Only the creator can disband this world.");
    }

    delete store.worlds[groupId];
    for (const [inviteId, invite] of Object.entries(store.invitations)) {
        if (invite.worldId === world.id) delete store.invitations[inviteId];
    }

    saveStore(store);
    return world;
}

function appendEvent(options) {
    const now = options.now || Date.now();
    const groupId = normalizeJid(options.groupId);
    const ids = normalizeAliases(options.senderIds);
    const store = loadStore(now);
    const world = store.worlds[groupId];

    if (!world || world.status !== "active") {
        throw makeError("no_active_world", "The shared world is no longer active.");
    }

    const member = world.members.find(candidate => sameIdentity(candidate.ids, ids));
    if (!member) throw makeError("not_member", "Only world members can add events.");

    const event = {
        type: options.type === "npc" ? "npc" :
            options.type === "system" ? "system" : "user",
        content: String(options.content || "").slice(0, 2500),
        senderId: member.id,
        senderName: member.name,
        characterId: member.characterId,
        ts: now
    };

    world.events.push(event);

    member.lastSeenAt = now;
    world.lastActivityAt = now;
    if (sameIdentity(world.creatorId, ids)) world.ownerLastSeenAt = now;

    saveStore(store);
    return { world, event };
}

function touchMember(options) {
    const now = options.now || Date.now();
    const groupId = normalizeJid(options.groupId);
    const ids = normalizeAliases(options.memberIds);
    const store = loadStore(now);
    const world = store.worlds[groupId];

    if (!world || world.status !== "active") return null;

    const member = world.members.find(candidate => sameIdentity(candidate.ids, ids));
    if (!member) return null;

    member.lastSeenAt = now;
    world.lastActivityAt = now;
    if (sameIdentity(world.creatorId, ids)) world.ownerLastSeenAt = now;

    saveStore(store);
    return { world, member };
}

function updateNpcReply(groupId, content, now = Date.now()) {
    const store = loadStore(now);
    const world = store.worlds[groupId];

    if (!world || world.status !== "active") return null;

    const event = {
        type: "npc",
        content: String(content || "").slice(0, 5000),
        ts: now
    };

    world.events.push(event);
    world.lastActivityAt = now;
    saveStore(store);
    return event;
}

function findWorldForUserAliases(aliases) {
    const store = loadStore();
    return findWorldInStoreByUser(store, aliases);
}

function getWorldEvents(groupId) {
    const store = loadStore();
    const world = store.worlds[groupId];
    return world ? world.events.slice() : [];
}

module.exports = {
    WORLD_AFK_MS,
    INVITE_TTL_MS,
    activeWorldForGroup,
    getWorldForGroup,
    getWorldForUser: findWorldForUserAliases,
    getPendingInvitation,
    createInitialInvitation,
    createInvitation,
    acceptInvitation,
    exitWorld,
    disbandWorld,
    appendEvent,
    updateNpcReply,
    touchMember
};
