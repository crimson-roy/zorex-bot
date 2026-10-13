"use strict";

const assert = require("node:assert/strict");
const {
    getLagosDateKey,
    getNextLagosMidnight,
    buildCshopMessage
} = require("../lib/cshopMessage");

async function main() {
    const oneMinuteBeforeLagosMidnight = Date.parse("2026-10-13T22:59:00.000Z");
    const midnight = getNextLagosMidnight(oneMinuteBeforeLagosMidnight);

    assert.equal(new Date(midnight).toISOString(), "2026-10-13T23:00:00.000Z");
    assert.equal(getLagosDateKey(midnight - 1), "2026-10-13");
    assert.equal(getLagosDateKey(midnight), "2026-10-14");

    const cards = {
        "501": { name: "The Moon Empress", series: "Original Collection" }
    };
    const message = buildCshopMessage({
        slots: [{ slot: 1, cardId: "501", tier: "SSR", price: 380000 }],
        expiresAt: midnight
    }, cards, { SSR: "👑" }, oneMinuteBeforeLagosMidnight);

    assert.match(message, /WELCOME TO ZOREX CARD SHOP/);
    assert.match(message, /TODAY'S CARDS/);
    assert.match(message, /New cards reset every day at 12:00 AM WAT/);
    assert.match(message, /HOW TO BUY/);
    assert.match(message, /\.cshop buy 3/);
    assert.match(message, /380,000/);
    assert.doesNotMatch(message, /120 hours|5 days|one shop copy|cooldown/i);

    const empty = buildCshopMessage({ slots: [], expiresAt: midnight }, cards, {}, oneMinuteBeforeLagosMidnight);
    assert.match(empty, /No cards remain in today's shop/);
    assert.match(empty, /12:00 AM WAT/);

    console.log("PASS: CShop rotation still changes at Lagos midnight each day");
    console.log("PASS: CShop follows the main shop's sectioned message style");
    console.log("PASS: CShop output omits internal cooldown/stock implementation notes");
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
