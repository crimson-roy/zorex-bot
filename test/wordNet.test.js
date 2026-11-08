"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WordNetDictionary, editDistanceAtMostOne } = require("../lib/wordNet");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-wordnet-test-"));

try {
    fs.writeFileSync(path.join(directory, "index.noun"), [
        "  WordNet test fixture",
        "persistence n 2 0 2 2 00000000 00000080",
        "perseverance n 1 0 1 1 00000000",
        "definition n 1 0 1 1 00000100",
        "abandon n 1 0 1 1 00000180",
        "ability n 1 0 1 1 00000200",
        "absence n 1 0 1 1 00000280",
        "academy n 1 0 1 1 00000300",
        "account n 1 0 1 1 00000380"
    ].join("\n") + "\n");

    fs.writeFileSync(path.join(directory, "data.noun"), [
        "00000000 00 n 02 persistence 0 perseverance 0 000 | the act of persisting; continued effort or existence",
        "00000080 00 n 01 persistence 0 000 | the property of persisting for a long time",
        "00000100 00 n 01 definition 0 000 | a statement of the meaning of a word",
        "00000180 00 n 01 abandon 0 000 | to leave someone or something behind",
        "00000200 00 n 01 ability 0 000 | the quality of being able to do something",
        "00000280 00 n 01 absence 0 000 | the state of being away from a place",
        "00000300 00 n 01 academy 0 000 | a school or society for special training",
        "00000380 00 n 01 account 0 000 | a report or description of an event"
    ].join("\n") + "\n");

    const dictionary = new WordNetDictionary({ dictDir: directory });
    assert.equal(dictionary.isAvailable(), true);

    const exact = dictionary.lookup("persistence");
    assert.equal(exact.senses.length, 2);
    assert.equal(exact.senses[0].definition, "the act of persisting; continued effort or existence");
    assert.ok(exact.senses[0].synonyms.includes("perseverance"));

    const typo = dictionary.lookup("persistenca");
    assert.equal(typo.corrected, true);
    assert.equal(typo.lemma, "persistence");
    assert.equal(typo.senses.length, 2);

    const plural = dictionary.lookup("definitions");
    assert.equal(plural.corrected, true);
    assert.equal(plural.lemma, "definition");

    const sevenLetterWords = dictionary.searchWords({ count: 5, length: 7 });
    assert.equal(sevenLetterWords.available, true);
    assert.equal(sevenLetterWords.words.length, 5);
    assert.ok(sevenLetterWords.words.every(entry => entry.word.length === 7 && entry.senses.length > 0));
    assert.deepEqual(sevenLetterWords.words.map(entry => entry.word), [
        "abandon", "ability", "absence", "academy", "account"
    ]);

    const wordsStartingWithA = dictionary.searchWords({ count: 2, startsWith: "a" });
    assert.equal(wordsStartingWithA.words.length, 2);
    assert.ok(wordsStartingWithA.words.every(entry => entry.word.startsWith("a")));

    assert.equal(editDistanceAtMostOne("persistenca", "persistence"), true);
    assert.equal(editDistanceAtMostOne("persistence", "perseverance"), false);

    console.log("PASS: WordNet reads senses, synonyms, plural morphology and one-character spelling corrections.");
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
