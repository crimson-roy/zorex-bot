"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "zorex-chloe-stickers-"));
const roots = [path.join(testDir, "media")];

function addSticker(mood) {
    const folder = path.join(roots[0], mood);
    fs.mkdirSync(folder, { recursive: true });
    const filename = path.join(folder, mood + ".webp");
    fs.writeFileSync(filename, "fixture");
    return filename;
}

const neutralSticker = addSticker("neutral");
const happySticker = addSticker("happy");
addSticker("laughing");

const { pickSticker, TIER_MOODS } = require("../lib/chloeStickers");

async function main() {
    try {
        assert.equal(TIER_MOODS.stranger.includes("happy"), false,
            "strangers should not receive automatically cheerful stickers");
        assert.equal(TIER_MOODS.stranger.includes("shy"), false,
            "strangers should not receive automatically bashful stickers");
        assert.equal(TIER_MOODS.acquaintance.includes("happy"), false,
            "acquaintances should remain emotionally reserved by default");
        assert.equal(TIER_MOODS.friend.includes("happy"), false,
            "friendship alone should not automatically unlock happy stickers");

        const lowTrustCompliment = pickSticker("stranger", "happy", {
            trust: 0,
            affection: 0,
            userMessage: "You're beautiful",
            roots
        });
        assert.equal(lowTrustCompliment, neutralSticker,
            "a compliment at zero trust/affection should not produce a happy sticker");

        const ordinaryPraise = pickSticker("stranger", "happy", {
            trust: 0,
            affection: 0,
            userMessage: "You're so nice",
            roots
        });
        assert.equal(ordinaryPraise, neutralSticker,
            "ordinary praise at zero trust/affection must not earn a happy sticker");

        const lowAffectionFriend = pickSticker("friend", "happy", {
            trust: 4,
            affection: 0,
            userMessage: "You're the best",
            roots
        });
        assert.equal(lowAffectionFriend, neutralSticker,
            "friend tier must not override a low affection score");

        const earnedWarmth = pickSticker("bestfriend", "happy", {
            trust: 7,
            affection: 5,
            userMessage: "You're beautiful",
            roots
        });
        assert.equal(earnedWarmth, happySticker,
            "higher trust and affection may unlock warmer stickers");

        const lovingOnlyRoot = path.join(testDir, "loving-only");
        const lovingDir = path.join(lovingOnlyRoot, "loving");
        fs.mkdirSync(lovingDir, { recursive: true });
        fs.writeFileSync(path.join(lovingDir, "loving.webp"), "fixture");
        const noNeutralSticker = pickSticker("stranger", "neutral", {
            trust: 0,
            affection: 0,
            roots: [lovingOnlyRoot]
        });
        assert.equal(noNeutralSticker, null,
            "missing neutral stickers must not silently fall back to unrelated loving art");

        console.log("PASS: stranger and acquaintance stickers remain cold by default");
        console.log("PASS: compliments do not unlock warm stickers at low affection");
        console.log("PASS: higher-trust, higher-affection relationships can use warm stickers");
        console.log("PASS: missing mood assets never fall back to a mismatched sticker");
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
