"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAriWorkspaceStore } = require("../dev/ariWorkspaceStore");

async function main() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ari-workspace-store-"));
    try {
        let currentTime = Date.UTC(2026, 10, 11, 12, 0, 0);
        const store = createAriWorkspaceStore({ dataDir, now: () => currentTime });
        assert.deepEqual(await store.listChats("google-subject-one"), []);
        assert.deepEqual(await store.listChats("google-subject-two"), []);

        const olderChat = {
            id: "chat-account-01",
            title: "Research notes",
            pinned: false,
            createdAt: currentTime - 1000,
            updatedAt: currentTime - 500,
            messages: [
                { role: "user", text: "Help me organise my notes.", createdAt: currentTime - 900 },
                { role: "ari", text: "Let's group them by topic.", createdAt: currentTime - 700 }
            ]
        };
        const pinnedChat = {
            id: "chat-account-02",
            title: "Project planning",
            pinned: true,
            createdAt: currentTime - 200,
            updatedAt: currentTime - 100,
            messages: [
                { role: "user", text: "Let's plan the project.", createdAt: currentTime - 150 }
            ]
        };
        const saved = await store.replaceChats("google-subject-one", [olderChat, pinnedChat]);
        assert.equal(saved.length, 2);
        assert.equal(saved[0].id, pinnedChat.id, "pinned conversations should sort first");

        await store.replaceChats("google-subject-two", [{
            id: "chat-account-03",
            title: "Private conversation",
            createdAt: currentTime,
            updatedAt: currentTime,
            messages: [{ role: "user", text: "This belongs to account two.", createdAt: currentTime }]
        }]);

        const fileData = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
        assert.equal(fileData.version, 1);
        assert.ok(fileData.accounts[crypto.createHash("sha256").update("google-subject-one").digest("hex")]);
        assert.equal(JSON.stringify(fileData).includes("google-subject-one"), false,
            "the raw Google subject must not be written as an account key");
        assert.equal((fs.statSync(store.filePath).mode & 0o777), 0o600,
            "workspace data should have owner-only file permissions");

        const restarted = createAriWorkspaceStore({ dataDir, now: () => currentTime });
        const restoredOne = await restarted.listChats("google-subject-one");
        const restoredTwo = await restarted.listChats("google-subject-two");
        assert.equal(restoredOne.length, 2, "conversations should survive store reconstruction");
        assert.equal(restoredTwo.length, 1);
        assert.equal(restoredTwo[0].id, "chat-account-03");

        restoredOne[0].title = "Mutated in caller";
        assert.notEqual((await restarted.listChats("google-subject-one"))[0].title, "Mutated in caller",
            "returned chat objects must not mutate stored data");

        await assert.rejects(
            () => restarted.replaceChats("google-subject-one", [
                olderChat,
                { ...olderChat, title: "Duplicate ID" }
            ]),
            error => error.statusCode === 400
        );
        await assert.rejects(
            () => restarted.replaceChats("google-subject-one", [{
                id: "chat-invalid-01",
                messages: [{ role: "system", text: "not allowed" }]
            }]),
            error => error.statusCode === 400
        );
        await assert.rejects(
            () => restarted.replaceChats("google-subject-one", [{
                id: "chat-invalid-02",
                messages: [{ role: "user", text: "x".repeat(12_001) }]
            }]),
            error => error.statusCode === 400
        );

        currentTime += 1000;
        await restarted.replaceChats("google-subject-one", []);
        assert.deepEqual(await restarted.listChats("google-subject-one"), []);
        assert.equal((await restarted.listChats("google-subject-two")).length, 1);

        console.log("PASS: Ari workspace conversations persist across restarts and remain account-scoped.");
        console.log("PASS: workspace storage validates chat data and writes private atomic JSON records.");
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
