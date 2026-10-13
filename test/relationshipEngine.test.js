"use strict";

const assert = require("node:assert/strict");

let response = JSON.stringify({
    trustDelta: 0,
    affectionDelta: 0,
    observation: null
});
let shouldThrow = false;

const clientPath = require.resolve("../lib/textAIClient");
require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: {
        callAI: async () => {
            if (shouldThrow) throw new Error("simulated scorer outage");
            return response;
        }
    }
};

const { judgeExchange } = require("../lib/relationshipEngine");

async function main() {
    const neutral = await judgeExchange("Tester", "hello", "Hello.");
    assert.equal(neutral.trustDelta, 0,
        "neutral exchanges must not gain trust automatically");
    assert.equal(neutral.affectionDelta, 0,
        "neutral exchanges must not gain affection automatically");
    assert.equal(neutral.observation, null);

    response = JSON.stringify({
        trustDelta: 0.08,
        affectionDelta: 0.12,
        observation: "Keeps a meaningful promise"
    });
    const earned = await judgeExchange(
        "Tester",
        "I remembered your promise and followed through.",
        "…I noticed. Thank you."
    );
    assert.equal(earned.trustDelta, 0.08,
        "only the scorer's concrete assessment should change trust");
    assert.equal(earned.affectionDelta, 0.12,
        "only earned affection should change the relationship score");

    shouldThrow = true;
    const failed = await judgeExchange("Tester", "hi", "Hm.");
    assert.equal(failed.trustDelta, 0,
        "a scorer failure must not increase trust");
    assert.equal(failed.affectionDelta, 0,
        "a scorer failure must not increase affection");
    assert.equal(failed.observation, null);

    console.log("PASS: neutral conversation does not automatically raise relationship scores");
    console.log("PASS: meaningful changes come from the relationship scorer");
    console.log("PASS: scorer failures do not grant free trust or affection");
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
