"use strict";

const assert = require("node:assert/strict");
const { inspectText, letterFrequency, classifyCharacter } = require("../lib/textTokenizer");

const result = inspectText("Ari, hello! 2 cats.");
assert.deepEqual(result.words, ["Ari", "hello", "cats"]);
assert.equal(result.counts.letters, 12);
assert.equal(result.counts.numbers, 1);
assert.equal(result.counts.words, 3);
assert.ok(result.tokens.some(token => token.type === "punctuation" && token.text === ","));
assert.ok(result.tokens.some(token => token.type === "number" && token.text === "2"));

const frequency = letterFrequency("banana");
assert.deepEqual(frequency, [
    { letter: "a", count: 3 },
    { letter: "b", count: 1 },
    { letter: "n", count: 2 }
]);

assert.equal(classifyCharacter("A"), "letter");
assert.equal(classifyCharacter("7"), "number");
assert.equal(classifyCharacter("?"), "punctuation");
assert.equal(inspectText("  ").counts.letters, 0);
assert.equal(inspectText("café").counts.letters, 4);

console.log("PASS: Ari identifies letters, numbers, punctuation and word tokens.");
