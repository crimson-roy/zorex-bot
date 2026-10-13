"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "zorex-chloe-behavior-"));
process.env.DATA_DIR = testDir;

const {
    buildRelationshipInstructions,
    formatActionBeats
} = require("../lib/chloeStyle");
const relationships = require("../lib/relationshipStore");

async function main() {
    try {
        const zeroTrust = buildRelationshipInstructions({
            trust: 0,
            affection: 0,
            tier: "stranger"
        });
        assert.match(zeroTrust, /Trust: 0\.00\/10/);
        assert.match(zeroTrust, /guarded, reserved, observant/i);
        assert.match(zeroTrust, /Do not be automatically sweet/i);
        assert.match(zeroTrust, /No pet names, flirting/i);
        assert.match(zeroTrust, /not a command to be cruel/i);

        const acquaintance = buildRelationshipInstructions({
            trust: 2.5,
            affection: 1,
            tier: "acquaintance"
        });
        assert.match(acquaintance, /EARLY-FAMILIARITY BEHAVIOR/i);
        assert.match(acquaintance, /LOW-AFFECTION BOUNDARY/i);

        const trusted = buildRelationshipInstructions({
            trust: 8,
            affection: 8,
            tier: "crush"
        });
        assert.doesNotMatch(trusted, /LOW-TRUST BEHAVIOR/i);

        assert.equal(
            formatActionBeats("*She folds her arms, looking away.*\nI didn't say I trusted you."),
            "> *She folds her arms, looking away.*\nI didn't say I trusted you.",
            "standalone italicized action should be formatted as a WhatsApp blockquote"
        );
        assert.equal(
            formatActionBeats("> *She glances aside.*\nNot impressed."),
            "> *She glances aside.*\nNot impressed.",
            "existing action blockquotes should not be duplicated"
        );
        assert.equal(
            formatActionBeats("*I really mean it.*"),
            "*I really mean it.*",
            "ordinary italicized emphasis should not be reclassified as an action"
        );
        assert.equal(
            formatActionBeats("(She sighs and looks away.)\nFine."),
            "> *She sighs and looks away.*\nFine.",
            "standalone parenthetical actions should be converted to blockquotes"
        );

        const existingRelationshipPath = path.join(testDir, "relationships.json");
        fs.writeFileSync(existingRelationshipPath, JSON.stringify({
            "person-phone@s.whatsapp.net": {
                trust: 0,
                affection: 0,
                conversations: 3,
                firstMet: Date.now() - 10000,
                lastInteraction: Date.now() - 100,
                observations: []
            }
        }, null, 2));
        const resolved = relationships.getRelationshipForAliases([
            "person-lid@lid",
            "person-phone@s.whatsapp.net"
        ]);
        assert.equal(resolved.trust, 0);
        assert.equal(resolved.conversations, 3);

        relationships.recordExchangeForAliases([
            "person-lid@lid",
            "person-phone@s.whatsapp.net"
        ], { trustDelta: 0.1, affectionDelta: 0.02 });
        const stored = JSON.parse(fs.readFileSync(existingRelationshipPath, "utf8"));
        assert.equal(stored["person-phone@s.whatsapp.net"].conversations, 4);
        assert.ok(stored["person-phone@s.whatsapp.net"].trust > 0);
        assert.equal(stored["person-lid@lid"], undefined,
            "alias-based updates must not create a duplicate relationship record");

        console.log("PASS: zero-trust Chloe receives explicit guarded behavior");
        console.log("PASS: trust and affection boundaries are independent");
        console.log("PASS: physical action beats retain the > blockquote format");
        console.log("PASS: ordinary italics and existing blockquotes are preserved");
        console.log("PASS: phone/LID aliases reuse one relationship record");
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
