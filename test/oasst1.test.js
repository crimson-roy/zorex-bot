"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { buildConversationExamples, splitForTree } = require("../lib/oasst1");
const { prepareDataset } = require("../scripts/prepare-oasst1");

const tree = {
    message_tree_id: "tree-1",
    prompt: {
        message_id: "m1",
        role: "prompter",
        lang: "en",
        text: "What is persistence?",
        replies: [
            {
                message_id: "m2",
                role: "assistant",
                lang: "en",
                text: "Persistence means continuing despite difficulty.",
                replies: [
                    {
                        message_id: "m3",
                        role: "prompter",
                        lang: "en",
                        text: "Can you give an example?",
                        replies: [
                            {
                                message_id: "m4",
                                role: "assistant",
                                lang: "en",
                                text: "Practising regularly is an example.",
                                replies: []
                            }
                        ]
                    }
                ]
            },
            {
                message_id: "m5",
                role: "assistant",
                lang: "es",
                text: "Spanish branch is ignored.",
                replies: []
            },
            {
                message_id: "m6",
                role: "assistant",
                lang: "en",
                text: "This branch has a flagged personal-data label.",
                labels: { pii: { value: 1.0 } },
                replies: []
            },
            {
                message_id: "m7",
                role: "assistant",
                lang: "en",
                text: "This branch has a flagged explicit-content label.",
                labels: { sexual_content: { value: 0.1 } },
                replies: []
            }
        ]
    }
};

async function main() {
    const result = buildConversationExamples(tree);
    assert.equal(result.skippedTree, false);
    assert.equal(result.examples.length, 2);
    assert.deepEqual(result.examples[0].messages.map(message => message.role), ["user", "assistant"]);
    assert.deepEqual(result.examples[1].messages.map(message => message.role), ["user", "assistant", "user", "assistant"]);
    assert.equal(result.examples[1].messages.at(-1).content, "Practising regularly is an example.");
    assert.ok(result.skippedMessages >= 3);

    const unsafeRoot = buildConversationExamples({
        prompt: { role: "prompter", lang: "en", text: "Hello", labels: { pii: { value: 1 } }, replies: [] }
    });
    assert.equal(unsafeRoot.skippedTree, true);
    assert.equal(unsafeRoot.examples.length, 0);

    assert.equal(splitForTree("same-tree"), splitForTree("same-tree"));
    assert.ok(["train", "validation"].includes(splitForTree("same-tree")));

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ari-oasst-export-"));
    try {
        const inputPath = path.join(tempDir, "sample.trees.jsonl.gz");
        const outputDir = path.join(tempDir, "prepared");
        fs.writeFileSync(inputPath, zlib.gzipSync(Buffer.from(JSON.stringify(tree) + "\n", "utf8")));

        const stats = await prepareDataset({ inputPath, outputDir });
        assert.equal(stats.treesRead, 1);
        assert.equal(stats.examplesWritten, 2);
        assert.equal(stats.trainExamples + stats.validationExamples, 2);
        assert.ok(fs.existsSync(stats.trainPath));
        assert.ok(fs.existsSync(stats.validationPath));

        const trainRows = fs.readFileSync(stats.trainPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
        const validationRows = fs.readFileSync(stats.validationPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
        assert.equal(trainRows.length, stats.trainExamples);
        assert.equal(validationRows.length, stats.validationExamples);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    console.log("PASS: OASST1 tree filtering and compressed JSONL preparation produce train and validation files.");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
