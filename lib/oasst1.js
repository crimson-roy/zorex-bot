"use strict";

const BLOCKED_LABELS = new Map([
    ["pii", 0],
    ["spam", 0],
    ["lang_mismatch", 0],
    ["not_appropriate", 0.5],
    ["hate_speech", 0.25],
    ["sexual_content", 0],
    ["violence", 0.5],
    ["toxicity", 0.5],
    ["severe_toxicity", 0.25],
    ["obscene", 0],
    ["identity_attack", 0.25],
    ["threat", 0.5],
    ["sexual_explicit", 0]
]);

function labelValue(value) {
    if (typeof value === "number") return value;
    if (value && typeof value.value === "number") return value.value;
    return 0;
}

function hasFlaggedContent(message) {
    if (!message || message.deleted === true || message.review_result === false) {
        return true;
    }

    const labels = message.labels || {};
    for (const [name, threshold] of BLOCKED_LABELS) {
        if (labelValue(labels[name]) > threshold) return true;
    }

    const detoxify = message.detoxify || {};
    if (labelValue(detoxify.severe_toxicity) >= 0.25) return true;
    if (labelValue(detoxify.sexual_explicit) > 0) return true;
    if (labelValue(detoxify.threat) >= 0.5) return true;

    return false;
}

function isUsableMessage(message) {
    return Boolean(
        message &&
        typeof message.text === "string" &&
        message.text.trim() &&
        message.lang === "en" &&
        ["prompter", "assistant"].includes(message.role) &&
        !hasFlaggedContent(message)
    );
}

function buildConversationExamples(tree, options = {}) {
    const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : 16000;
    const examples = [];
    const root = tree && tree.prompt;

    if (!isUsableMessage(root)) {
        return { examples, skippedTree: true, skippedMessages: 1 };
    }

    function visit(node, history, characterCount) {
        if (!isUsableMessage(node)) {
            return { skipped: 1 };
        }

        const previous = history[history.length - 1];
        if (previous && previous.role === node.role) {
            return { skipped: 1 };
        }

        const text = node.text.trim();
        const nextCount = characterCount + text.length;
        if (nextCount > maxChars) return { skipped: 1 };

        const role = node.role === "prompter" ? "user" : "assistant";
        const nextHistory = history.concat({ role, content: text });

        if (role === "assistant" && nextHistory.length >= 2) {
            examples.push({
                source: "oasst1",
                source_tree_id: String(tree.message_tree_id || root.message_id || "unknown"),
                messages: nextHistory
            });
        }

        let skipped = 0;
        const replies = Array.isArray(node.replies) ? node.replies : [];
        for (const reply of replies) {
            const result = visit(reply, nextHistory, nextCount);
            skipped += result.skipped || 0;
        }
        return { skipped };
    }

    const result = visit(root, [], 0);
    return { examples, skippedTree: false, skippedMessages: result.skipped || 0 };
}

function splitForTree(treeId) {
    let hash = 2166136261;
    for (const character of String(treeId || "")) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % 100 < 5 ? "validation" : "train";
}

module.exports = {
    BLOCKED_LABELS,
    hasFlaggedContent,
    isUsableMessage,
    buildConversationExamples,
    splitForTree
};
