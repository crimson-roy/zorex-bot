"use strict";

const assert = require("node:assert/strict");
const { buildConversationExamples, splitForTree } = require("../lib/oasst1");

const tree = {
    message_tree_id: "tree-1",
    prompt: {
        message_id: "m1",
        role: "prompter",
        lang: "en",
        text: "What is persistence?",
        replies: [
            {
                message_id: "m2",
                role: "assistant",
                lang: "en",
                text: "Persistence means continuing despite difficulty.",
                replies: [
                    {
                        message_id: "m3",
                        role: "prompter",
                        lang: "en",
                        text: "Can you give an example?",
                        replies: [
                            {
                                message_id: "m4",
                                role: "assistant",
                                lang: "en",
                                text: "Practising regularly is an example.",
                                replies: []
                            }
                        ]
                    }
                ]
            },
            {
                message_id: "m5",
                role: "assistant",
                lang: "es",
                text: "Spanish branch is ignored.",
                replies: []
            },
            {
                message_id: "m6",
                role: "assistant",
                lang: "en",
                text: "This branch has a flagged personal-data label.",
                labels: { pii: { value: 1.0 } },
                replies: []
            }
        ]
    }
};

const result = buildConversationExamples(tree);
assert.equal(result.skippedTree, false);
assert.equal(result.examples.length, 2);
assert.deepEqual(result.examples[0].messages.map(message => message.role), ["user", "assistant"]);
assert.deepEqual(result.examples[1].messages.map(message => message.role), ["user", "assistant", "user", "assistant"]);
assert.equal(result.examples[1].messages.at(-1).content, "Practising regularly is an example.");
assert.ok(result.skippedMessages >= 2);

const unsafeRoot = buildConversationExamples({
    prompt: { role: "prompter", lang: "en", text: "Hello", labels: { pii: { value: 1 } }, replies: [] }
});
assert.equal(unsafeRoot.skippedTree, true);
assert.equal(unsafeRoot.examples.length, 0);

assert.equal(splitForTree("same-tree"), splitForTree("same-tree"));
assert.ok(["train", "validation"].includes(splitForTree("same-tree")));

console.log("PASS: OASST1 tree paths become alternating chat examples with language and risk-label filtering.");
