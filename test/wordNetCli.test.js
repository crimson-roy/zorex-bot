"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WordNetDictionary } = require("../lib/wordNet");
const { spawnSync } = require("node:child_process");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-wordnet-cli-"));
try {
    fs.writeFileSync(path.join(directory, "index.noun"),
        "persistence n 1 0 1 1 00000000\n");
    fs.writeFileSync(path.join(directory, "data.noun"),
        "00000000 00 n 01 persistence 0 000 | the act of persisting\n");

    const dictionary = new WordNetDictionary({ dictDir: directory });
    assert.equal(dictionary.isAvailable(), true);
    assert.equal(dictionary.lookup("persistence").senses.length, 1);
    assert.equal(dictionary.lookup("persistenca").lemma, "persistence");

    const child = spawnSync(process.execPath, [path.join(__dirname, "../scripts/check-wordnet.js")], {
        encoding: "utf8",
        env: { ...process.env, WORDNET_DICT_DIR: directory }
    });

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Dictionary found at/);
    assert.match(child.stdout, /Suggested correction: persistence/);
    assert.match(child.stdout, /No AI API was used/);

    console.log("PASS: WordNet diagnostic finds the dictionary and tests spelling suggestions.");
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
