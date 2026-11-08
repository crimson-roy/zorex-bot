"use strict";

const assert = require("node:assert/strict");
const { evaluateMathPrompt } = require("../lib/localMath");

function expectResult(prompt, expected) {
    const result = evaluateMathPrompt(prompt);
    assert.equal(result.matched, true, `Expected local math to match: ${prompt}`);
    assert.equal(result.display, expected, `Unexpected result for: ${prompt}`);
}

expectResult("1 + 1", "2");
expectResult("What is 1 + 1?", "2");
expectResult("please calculate 25% of 800", "200");
expectResult("calculate (12 / 3) + 4", "8");
expectResult("2^3^2", "512");
expectResult("0.1 + 0.2", "0.3");
expectResult("5 minus 2", "3");
expectResult("3 multiplied by 4", "12");
expectResult("-2^2", "-4");

const divisionByZero = evaluateMathPrompt("1 / 0");
assert.equal(divisionByZero.matched, true);
assert.equal(divisionByZero.error, "Cannot divide by zero.");

assert.equal(evaluateMathPrompt("hello there").matched, false);
assert.equal(evaluateMathPrompt("explain 1 + 1").matched, false);
assert.equal(evaluateMathPrompt("process.exit()").matched, false);
assert.equal(evaluateMathPrompt("1 + (2 * 3").matched, false);
assert.equal(evaluateMathPrompt("1 + 2; process.exit()").matched, false);

console.log("PASS: local arithmetic expressions, precedence, percentages and safe rejection");
