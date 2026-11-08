"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WordNetDictionary } = require("../lib/wordNet");
const { extractDefinitionTerm, respondToLocalLanguage } = require("../lib/localLanguage");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ari-language-test-"));

try {
    fs.writeFileSync(path.join(directory, "index.noun"), [
        "persistence n 2 0 2 2 00000000 00000080"
    ].join("\n") + "\n");
    fs.writeFileSync(path.join(directory, "data.noun"), [
        "00000000 00 n 02 persistence 0 perseverance 0 000 | the act of persisting; continued effort",
        "00000080 00 n 01 persistence 0 000 | the property of persisting"
    ].join("\n") + "\n");

    const dictionary = new WordNetDictionary({ dictDir: directory });

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
