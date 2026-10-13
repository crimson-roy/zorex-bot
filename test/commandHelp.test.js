"use strict";

const assert = require("node:assert/strict");
const { buildKnowledgeContext } = require("../lib/commandRegistry");

function contextFor(command) {
    return buildKnowledgeContext(command).context;
}

const sus = contextFor(".sus");
assert.match(sus, /Lord Crimson only/i);
assert.doesNotMatch(sus, /activation is manual|payment is not verified|does not verify payments with a provider|MAIN_OWNER/i);

const chat = contextFor(".chat");
assert.match(chat, /private story context is added only after its owner previews and confirms sharing/i);
assert.doesNotMatch(chat, /developer-only|implementation details|provisional Crescent|30 days of creator inactivity/i);

const ai = contextFor(".ai");
assert.match(ai, /Answers questions, explains Zorex commands/i);
assert.doesNotMatch(ai, /Azure multimodal vision|4-digit AI PIN|Crescent confirmation threshold|allowlisted set|Real-ESRGAN/i);

const cshop = contextFor(".cshop");
assert.match(cshop, /daily rotating card shop/i);
assert.doesNotMatch(cshop, /single-copy|120 hours|cooldown/i);

console.log("PASS: public command help describes user-visible features, not internal implementation");
