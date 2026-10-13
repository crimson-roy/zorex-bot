"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "zorex-cshop-format-"));
process.env.DATA_DIR = testDir;

const { buildShopText, getNextLagosMidnight } = require("../commands/cshop");

async function main() {
    try {
        const expiresAt = getNextLagosMidnight(Date.UTC(2026, 0, 1, 12, 0, 0));
        assert.equal(expiresAt, Date.UTC(2026, 0, 1, 23, 0, 0),
            "CShop should reset at midnight Lagos time");

        const text = buildShopText({
            slots: [{ slot: 3, cardId: "501", tier: "SSR", price: 380000 }],
            expiresAt
        }, {
            "501": { name: "Rem", series: "Re:Zero", tier: "SSR" }
        });

        assert.match(text, /WELCOME TO ZOREX CARD SHOP/);
        assert.match(text, /New cards every day at 12:00 AM \(Lagos time\)/);
        assert.match(text, /TODAY’S CARDS/);
        assert.match(text, /\[ 3 \] Rem/);
        assert.match(text, /Series: Re:Zero/);
        assert.match(text, /Price: 380,000/);
        assert.match(text, /Next reset:/);
        assert.match(text, /HOW TO BUY/);
        assert.match(text, /\.cshop buy <slot>/);
        assert.doesNotMatch(text, /120 hours|only one shop copy|cooldown|card\.json/i,
            "public CShop display should not expose developer/cooldown implementation notes");

        const soldOut = buildShopText({ slots: [], expiresAt }, {});
        assert.match(soldOut, /Today’s cards are sold out/);
        assert.match(soldOut, /New cards every day at 12:00 AM/);

        console.log("PASS: CShop matches the Shop-style framed menu");
        console.log("PASS: daily reset stays at midnight Lagos time");
        console.log("PASS: internal cooldown and file details are absent from customer messages");
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
