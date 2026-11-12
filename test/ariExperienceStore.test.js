"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    createAriExperienceStore,
    classifyTask,
    responseSignals
} = require("../dev/ariExperienceStore");

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-experience-store-"));
    try {
        let now = 1_800_000_000_000;
        const store = createAriExperienceStore({ dataDir: directory, now: () => now });
        assert.equal(classifyTask("Debug this Python function"), "coding");
        assert.equal(classifyTask("Please draft an email"), "writing");
        assert.ok(responseSignals("## Steps\n1. First\n\n```js\nconsole.log(1)\n```").includes("clear_sections"));

        await store.recordFeedback("account-one", {
            responseId: "response-1",
            tier: "medium",
            taskType: "coding",
            rating: "like",
            signals: ["step_by_step", "code_blocks", "not-a-real-signal"]
        });
        let guidance = store.guidanceFor("account-one", "Help me debug this JavaScript error.");
        assert.match(guidance, /step-by-step/i);
        assert.match(guidance, /fenced code blocks/i);
        assert.equal(store.getSummary("account-one").samples, 1);
        assert.equal(store.getSummary("account-two").samples, 0);

        now++;
        await store.recordFeedback("account-one", {
            responseId: "response-1",
            tier: "medium",
            taskType: "coding",
            rating: "dislike",
            signals: ["step_by_step"]
        });
        assert.deepEqual(store.getSummary("account-one"), { samples: 1, likes: 0, dislikes: 1 });
        guidance = store.guidanceFor("account-one", "Help me debug this JavaScript error.");
        assert.match(guidance, /not found a consistently preferred/i);

        await assert.rejects(
            store.recordFeedback("account-one", {
                responseId: "response-2",
                tier: "mini",
                taskType: "coding",
                rating: "like",
                signals: []
            }),
            { statusCode: 400 }
        );

        const stored = fs.readFileSync(store.filePath, "utf8");
        assert.equal(stored.includes("Debug this Python function"), false);
        assert.equal(stored.includes("console.log(1)"), false);
        const restarted = createAriExperienceStore({ dataDir: directory, now: () => now + 1 });
        assert.equal(restarted.getSummary("account-one").dislikes, 1);
        console.log("ariExperienceStore.test.js: account isolation, de-identified patterns and feedback updates passed");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
