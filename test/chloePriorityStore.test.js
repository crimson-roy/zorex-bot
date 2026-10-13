"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "zorex-chloe-priorities-"));
process.env.DATA_DIR = testDir;

const priorities = require("../lib/chloePriorityStore");

function item(items, key) {
    return items.find(entry => entry.key === key);
}

async function main() {
    try {
        const familyUpdates = {
            upserts: [
                {
                    key: "relationship.status",
                    category: "relationship",
                    title: "Relationship status",
                    details: "Chloe and Daniel are married in their roleplay.",
                    priority: "high"
                },
                {
                    key: "relationship.partner-name",
                    category: "relationship",
                    title: "Spouse",
                    details: "Her spouse's established name is Daniel.",
                    priority: "high"
                },
                {
                    key: "family.child.maya",
                    category: "family",
                    title: "Child: Maya",
                    details: "Maya is Chloe and Daniel's daughter.",
                    priority: "high"
                },
                {
                    key: "family.child.eli",
                    category: "family",
                    title: "Child: Eli",
                    details: "Eli is Chloe and Daniel's son.",
                    priority: "high"
                },
                {
                    key: "home.current",
                    category: "home",
                    title: "Current home",
                    details: "The family currently lives in House 12.",
                    priority: "high"
                },
                {
                    key: "routine.school-pickup",
                    category: "routine",
                    title: "School pickup",
                    details: "Chloe usually picks Maya and Eli up from school.",
                    priority: "high",
                    recurrence: "School days"
                }
            ],
            complete: [],
            remove: []
        };

        const saved = priorities.applyUpdate(
            ["family-test@lid", "123456@s.whatsapp.net"],
            familyUpdates,
            100000
        );
        assert.equal(saved.upserted, 6);

        const sameUser = priorities.getPriorities(["123456@s.whatsapp.net"]);
        assert.equal(item(sameUser, "relationship.status").details,
            "Chloe and Daniel are married in their roleplay.");
        assert.equal(item(sameUser, "family.child.maya").title, "Child: Maya");
        assert.equal(item(sameUser, "family.child.eli").title, "Child: Eli");
        assert.equal(item(sameUser, "home.current").details,
            "The family currently lives in House 12.");

        const context = priorities.buildPriorityContext(["123456@s.whatsapp.net"]);
        assert.match(context, /Child: Maya/);
        assert.match(context, /Child: Eli/);
        assert.match(context, /school-pickup/);
        assert.match(context, /House 12/);

        assert.deepEqual(priorities.getPriorities(["different-user@lid"]), [],
            "one user's family memories must never leak to another user");

        const corrected = priorities.applyUpdate(
            ["123456@s.whatsapp.net"],
            {
                upserts: [{
                    key: "home.current",
                    category: "home",
                    title: "Current home",
                    details: "The family now lives in House 14.",
                    priority: "high"
                }],
                complete: [],
                remove: []
            },
            200000
        );
        assert.equal(corrected.upserted, 1);
        const afterCorrection = priorities.getPriorities(["family-test@lid"]);
        assert.equal(item(afterCorrection, "home.current").details,
            "The family now lives in House 14.",
            "the same stable key should update instead of retaining an obsolete home");

        const completion = priorities.applyUpdate(
            ["123456@s.whatsapp.net"],
            { upserts: [], complete: ["commitment.school-trip"], remove: [] },
            300000
        );
        assert.equal(completion.completed, 0,
            "a missing commitment must not be fabricated during completion");

        priorities.applyUpdate(
            ["family-test@lid"],
            {
                upserts: [{
                    key: "commitment.school-trip",
                    category: "commitment",
                    title: "School trip",
                    details: "Confirm the children's school trip permission slip.",
                    priority: "normal"
                }],
                complete: [],
                remove: []
            },
            350000
        );
        const completed = priorities.applyUpdate(
            ["123456@s.whatsapp.net"],
            { upserts: [], complete: ["commitment.school-trip"], remove: [] },
            400000
        );
        assert.equal(completed.completed, 1);
        const completedItem = item(
            priorities.getPriorities(["family-test@lid"]),
            "commitment.school-trip"
        );
        assert.equal(completedItem.status, "completed");

        const updateTag = {
            upserts: [{
                key: "family.child.nina",
                category: "family",
                title: "Child: Nina",
                details: "Nina is Chloe and Daniel's child.",
                priority: "high"
            }],
            complete: [],
            remove: []
        };
        const modelReply = "She gives him a cool look.\n[priority_memory: " +
            JSON.stringify(updateTag) + "]\n[mood: neutral]";
        const parsed = priorities.extractPriorityUpdate(modelReply);
        assert.equal(parsed.update.upserts[0].key, "family.child.nina");
        assert.equal(parsed.reply, "She gives him a cool look.\n[mood: neutral]");
        assert.doesNotMatch(parsed.reply, /priority_memory/i);

        const malformed = priorities.extractPriorityUpdate(
            "Fine.\n[priority_memory: {broken json}]\n[mood: neutral]"
        );
        assert.equal(malformed.update, null);
        assert.doesNotMatch(malformed.reply, /priority_memory/i,
            "malformed protocol data must never leak into the visible reply");

        const removal = priorities.applyUpdate(
            ["123456@s.whatsapp.net"],
            { upserts: [], complete: [], remove: ["family.child.eli"] },
            500000
        );
        assert.equal(removal.removed, 1);
        assert.equal(item(priorities.getPriorities(["family-test@lid"]),
            "family.child.eli"), undefined);

        assert.ok(fs.existsSync(priorities.STORE_PATH),
            "priority facts should persist in the configured data directory");
        const persisted = JSON.parse(fs.readFileSync(priorities.STORE_PATH, "utf8"));
        assert.equal(persisted.version, 1);
        assert.ok(Object.keys(persisted.profiles).length >= 1);

        console.log("PASS: per-user persistent family, relationship, home and routine facts");
        console.log("PASS: phone/LID aliases resolve to the same priority profile");
        console.log("PASS: saved facts are injected into Chloe's contextual prompt");
        console.log("PASS: stable keys update changed facts instead of duplicating old values");
        console.log("PASS: one-time commitments can be completed and removed");
        console.log("PASS: private memory markers are parsed and stripped from visible replies");
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
