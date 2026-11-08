"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { serializeExample, prepareAri0Corpus } = require("../scripts/prepare-ari0-corpus");

async function main() {
    const example = {
        messages: [
            { role: "user", content: "Hello Ari" },
            { role: "assistant", content: "Hello. How can I help?" }
        ]
    };
    assert.equal(
        serializeExample(example),
        "<|user|>\nHello Ari\n<|assistant|>\nHello. How can I help?\n<|end|>\n\n"
    );
    assert.equal(serializeExample({ messages: [{ role: "user", content: "Only a prompt" }] }), "");
    assert.equal(serializeExample({ messages: [
        { role: "user", content: "Hi" },
        { role: "system", content: "Unexpected role" }
    ] }), "");

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ari0-corpus-"));
    try {
        const inputDir = path.join(tempDir, "prepared");
        const outputDir = path.join(tempDir, "corpus");
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, "train.jsonl"),
            JSON.stringify(example) + "\n" +
            JSON.stringify({ messages: [{ role: "user", content: "Skip me" }] }) + "\n");
        fs.writeFileSync(path.join(inputDir, "validation.jsonl"), JSON.stringify(example) + "\n");

        const result = await prepareAri0Corpus({ inputDir, outputDir });
        assert.equal(result.train.conversationsWritten, 1);
        assert.equal(result.train.rowsSkipped, 1);
        assert.equal(result.validation.conversationsWritten, 1);
        assert.match(fs.readFileSync(path.join(outputDir, "train.txt"), "utf8"), /<\|assistant\|>\nHello/);
        assert.match(fs.readFileSync(path.join(outputDir, "validation.txt"), "utf8"), /<\|user\|>\nHello Ari/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
    console.log("PASS: Ari-0 corpus preparation writes explicit role and turn markers.");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
