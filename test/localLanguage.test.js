"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WordNetDictionary } = require("../lib/wordNet");
const { extractDefinitionTerm, extractWordListRequest, respondToLocalLanguage } = require("../lib/localLanguage");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-language-test-"));

try {
    fs.writeFileSync(path.join(directory, "index.noun"), [
        "persistence n 2 0 2 2 00000000 00000080",
        "abandon n 1 0 1 1 00000100",
        "ability n 1 0 1 1 00000180",
        "absence n 1 0 1 1 00000200",
        "academy n 1 0 1 1 00000280",
        "account n 1 0 1 1 00000300"
    ].join("\n") + "\n");
    fs.writeFileSync(path.join(directory, "data.noun"), [
        "00000000 00 n 02 persistence 0 perseverance 0 000 | the act of persisting; continued effort",
        "00000080 00 n 01 persistence 0 000 | the property of persisting",
        "00000100 00 n 01 abandon 0 000 | to leave someone or something behind",
        "00000180 00 n 01 ability 0 000 | the quality of being able to do something",
        "00000200 00 n 01 absence 0 000 | the state of being away from a place",
        "00000280 00 n 01 academy 0 000 | a school for special training",
        "00000300 00 n 01 account 0 000 | a report or description of an event"
    ].join("\n") + "\n");

    const dictionary = new WordNetDictionary({ dictDir: directory });

    assert.deepEqual(
        extractWordListRequest("gimme 5 seven letter words and their meanings"),
        { count: 5, length: 7, startsWith: null }
    );
    assert.deepEqual(
        extractWordListRequest("give me three words starting with A and their definitions"),
        { count: 3, length: null, startsWith: "a" }
    );
    assert.deepEqual(
        extractWordListRequest("list 4 words"),
        { count: 4, length: null, startsWith: null }
    );
    assert.deepEqual(
        extractWordListRequest("list 7-letter words"),
        { count: 5, length: 7, startsWith: null }
    );

    assert.equal(extractDefinitionTerm("define persistence"), "persistence");
    assert.equal(extractDefinitionTerm("What does persistence mean?"), "persistence");
    assert.equal(extractDefinitionTerm("What is persistence?"), "persistence");
    assert.equal(extractDefinitionTerm("Hi Ari, define persistence"), "persistence");
    assert.equal(extractDefinitionTerm("Explain the word persistence"), "persistence");
    assert.equal(extractDefinitionTerm("Explain photosynthesis"), null);
    assert.equal(
        require("../lib/localLanguage").extractTextAnalysisRequest("How many letters are in banana?"),
        "banana"
    );

    assert.equal(respondToLocalLanguage("Explain photosynthesis."), null);

    const greeting = respondToLocalLanguage("Hi Ari");
    assert.match(greeting.reply, /Hi!/);
    assert.match(greeting.mode, /no AI API/);

    const letterAnalysis = respondToLocalLanguage("Hi Ari, count letters in banana");
    assert.match(letterAnalysis.reply, /6 letters/);
    assert.match(letterAnalysis.reply, /a × 3/);
    assert.match(letterAnalysis.mode, /no AI API/);

    const smallTalk = respondToLocalLanguage("Hi Ari, how are you?");
    assert.match(smallTalk.reply, /ready to help/);
    assert.match(smallTalk.mode, /no AI API/);

    const goodbye = respondToLocalLanguage("Goodbye Ari");
    assert.match(goodbye.reply, /See you later/);

    const wordList = respondToLocalLanguage(
        "gimme 5 seven letter words and their meanings",
        { dictionary }
    );
    assert.match(wordList.reply, /abandon/);
    assert.match(wordList.reply, /ability/);
    assert.match(wordList.reply, /absence/);
    assert.match(wordList.mode, /no AI API/);

    const definition = respondToLocalLanguage("What is persistence?", { dictionary });
    assert.match(definition.reply, /WordNet entries for "persistence"/);
    assert.match(definition.reply, /continued effort/);

    const typo = respondToLocalLanguage("define persistenca", { dictionary });
    assert.match(typo.reply, /Did you mean "persistence"/);
    assert.match(typo.mode, /no AI API/);

    const missingDictionary = new WordNetDictionary({ dictDir: path.join(directory, "missing") });
    const unavailable = respondToLocalLanguage("define persistence", { dictionary: missingDictionary });
    assert.match(unavailable.reply, /can't find the WordNet dictionary files/i);

    console.log("PASS: local language handling recognises greetings, definition phrasing and likely spelling corrections.");
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
