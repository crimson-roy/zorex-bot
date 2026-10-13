"use strict";

const assert = require("node:assert/strict");
const { COMMANDS, buildKnowledgeContext } = require("../lib/commandRegistry");

function description(name) {
    const command = COMMANDS.find(entry => entry.name === name);
    assert.ok(command, "expected command help for ." + name);
    return command.description;
}

const sus = buildKnowledgeContext(".sus").context;
assert.match(sus, /Access: Lord Crimson only/i);
assert.doesNotMatch(sus, /activation is manual|payment is not verified|does not verify payments with a provider|MAIN_OWNER/i);
assert.doesNotMatch(description("sus"), /manual|provider|not automatically verify/i);

const chatDescription = description("chat");
assert.match(chatDescription, /private story context is added only after its owner previews and confirms sharing/i);
assert.doesNotMatch(chatDescription, /developer-only|implementation details|provisional Crescent|30 days of creator inactivity/i);

const aiDescription = description("ai");
assert.match(aiDescription, /Answers questions, explains Zorex commands/i);
assert.doesNotMatch(aiDescription, /Azure multimodal vision|4-digit AI PIN|Crescent confirmation threshold|allowlisted set|Real-ESRGAN/i);

const cshopDescription = description("cshop");
assert.match(cshopDescription, /daily rotating card shop/i);
assert.doesNotMatch(cshopDescription, /single-copy|120 hours|cooldown/i);

console.log("PASS: public command help describes user-visible features, not internal implementation");
