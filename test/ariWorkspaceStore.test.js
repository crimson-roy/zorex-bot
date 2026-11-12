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
                {
                    role: "ari",
                    text: "A local-first design keeps a browser copy and syncs it to the account.",
                    id: "response-1",
                    feedbackRating: "like",
                    activity: ["Understanding the request", "Preparing the response"],
                    activityDurationMs: 1800,
                    createdAt: now + 1
                }
            ],
            createdAt: now,
            updatedAt: now + 1,
            pinned: true,
            projectId: null
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

        await assert.rejects(
            restarted.createProject("google-subject-a", { description: "Missing required name." }),
            { statusCode: 400 }
        );
        const project = await restarted.createProject("google-subject-a", {
            name: "Ari website",
            description: "Build the Ari workspace."
        });
        assert.match(project.id, /^[0-9a-f-]{36}$/i);
        assert.equal(restarted.listProjects("google-subject-a").length, 1);
        assert.deepEqual(restarted.listProjects("google-subject-b"), []);
        assert.equal(restarted.listProjects("google-subject-a")[0].name, "Ari website");

        const projectChat = {
            id: "project-chat-1",
            title: "Library implementation",
            messages: [{ role: "user", text: "Build the Library.", createdAt: now }],
            createdAt: now,
            updatedAt: now,
            pinned: false,
            projectId: project.id
        };
        await restarted.replaceChats("google-subject-a", [projectChat]);
        assert.equal(restarted.getChats("google-subject-a")[0].projectId, project.id);
        assert.equal(restarted.getChats("google-subject-b").length, 0);
        assert.throws(() => normalizeChats([{ ...projectChat, projectId: "not-a-uuid" }]), { statusCode: 400 });

        await assert.rejects(
            restarted.replaceChats("google-subject-a", [{ ...projectChat, projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]),
            { statusCode: 400 }
        );
        const renamed = await restarted.updateProject("google-subject-a", project.id, {
            name: "Ari workspace",
            description: "Updated project description."
        });
        assert.equal(renamed.name, "Ari workspace");
        assert.equal(restarted.listProjects("google-subject-a")[0].description, "Updated project description.");

        const deleted = await restarted.deleteProject("google-subject-a", project.id);
        assert.equal(deleted.project.id, project.id);
        assert.equal(deleted.unassignedChats, 1);
        assert.equal(restarted.listProjects("google-subject-a").length, 0);
        assert.equal(restarted.getChats("google-subject-a")[0].projectId, null,
            "deleting a project must preserve its conversations in general history");
        await assert.rejects(restarted.deleteProject("google-subject-a", project.id), { statusCode: 404 });

        const memory = await restarted.createMemory("google-subject-a", {
            text: "Prefers clear, step-by-step technical explanations."
        });
        assert.equal(memory.status, "active");
        assert.equal(memory.source, "user");
        assert.equal(restarted.listMemories("google-subject-a").length, 1);
        assert.deepEqual(restarted.listMemories("google-subject-b"), []);
        await assert.rejects(
            restarted.createMemory("google-subject-a", { text: "password: example-secret" }),
            { statusCode: 400 }
        );
        const suggestedMemory = await restarted.createMemory("google-subject-a", {
            text: "Ari development is an ongoing project."
        }, { status: "pending", source: "ari" });
        assert.equal(suggestedMemory.status, "pending");
        const approvedMemory = await restarted.updateMemory("google-subject-a", suggestedMemory.id, {
            status: "active",
            text: "Ari development is an ongoing project."
        });
        assert.equal(approvedMemory.status, "active");
        assert.equal(approvedMemory.source, "ari");
        const editedMemory = await restarted.updateMemory("google-subject-a", memory.id, {
            text: "Prefers short, practical technical explanations."
        });
        assert.equal(editedMemory.text, "Prefers short, practical technical explanations.");
        await restarted.deleteMemory("google-subject-a", suggestedMemory.id);
        assert.equal(restarted.listMemories("google-subject-a").length, 1);
        assert.deepEqual(restarted.listMemories("google-subject-b"), []);

        console.log("ariWorkspaceStore.test.js: persistence, projects, review memories, account isolation and validation passed");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
