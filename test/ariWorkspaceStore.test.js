"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    createAriWorkspaceStore,
    normalizeChats,
    MAX_CHATS,
    MAX_MESSAGES_PER_CHAT
} = require("../dev/ariWorkspaceStore");

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-workspace-store-"));
    try {
        let now = 1_800_000_000_000;
        const first = createAriWorkspaceStore({ dataDir: directory, now: () => now });
        const sample = [{
            id: "chat-1",
            title: "Research notes",
            messages: [
                { role: "user", text: "Find information about local-first storage.", createdAt: now },
                { role: "ari", text: "A local-first design keeps a browser copy and syncs it to the account.", createdAt: now + 1 }
            ],
            createdAt: now,
            updatedAt: now + 1,
            pinned: true
        }];

        await first.replaceChats("google-subject-a", sample);
        assert.deepEqual(first.getChats("google-subject-a"), sample);
        assert.deepEqual(first.getChats("google-subject-b"), [], "accounts must not see each other's chats");
        const storedText = fs.readFileSync(first.filePath, "utf8");
        assert.equal(storedText.includes("google-subject-a"), false, "raw account subjects must not be written into the data file");
        assert.equal(storedText.includes("google-subject-b"), false, "raw account subjects must not be written into the data file");
        assert.equal(fs.statSync(first.filePath).isFile(), true);

        const restarted = createAriWorkspaceStore({ dataDir: directory, now: () => now + 10 });
        assert.deepEqual(restarted.getChats("google-subject-a"), sample, "saved chats must survive store recreation");

        await restarted.replaceChats("google-subject-a", []);
        assert.deepEqual(first.getChats("google-subject-a"), [], "an empty list should sync local deletions");

        assert.throws(() => normalizeChats(null), { statusCode: 400 });
        assert.throws(() => normalizeChats([{ id: "../bad", messages: [] }]), { statusCode: 400 });
        assert.throws(() => normalizeChats([
            { id: "duplicate", messages: [] },
            { id: "duplicate", messages: [] }
        ]), { statusCode: 400 });
        assert.throws(() => normalizeChats([{ id: "bad-role", messages: [{ role: "system", text: "no" }] }]), { statusCode: 400 });
        assert.throws(() => normalizeChats([{ id: "blank", messages: [{ role: "user", text: "   " }] }]), { statusCode: 400 });
        assert.throws(() => normalizeChats([{ id: "too-long", messages: [{ role: "user", text: "x".repeat(50001) }] }]), { statusCode: 400 });
        assert.throws(() => normalizeChats(Array.from({ length: MAX_CHATS + 1 }, (_, i) => ({ id: "chat-" + i, messages: [] }))), { statusCode: 400 });
        assert.throws(() => normalizeChats([{ id: "too-many", messages: Array.from({ length: MAX_MESSAGES_PER_CHAT + 1 }, () => ({ role: "user", text: "x" })) }]), { statusCode: 400 });

        now += 1;
        const sanitized = normalizeChats([{
            id: "safe-1",
            title: "  Trimmed title  ",
            messages: [{ role: "user", text: "  Keep this message  ", createdAt: -1 }],
            createdAt: -1,
            updatedAt: -1,
            pinned: "yes"
        }], now);
        assert.equal(sanitized[0].title, "Trimmed title");
        assert.equal(sanitized[0].messages[0].text, "Keep this message");
        assert.equal(sanitized[0].messages[0].createdAt, now);
        assert.equal(sanitized[0].pinned, false);

        console.log("ariWorkspaceStore.test.js: all persistence, isolation and validation tests passed");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
