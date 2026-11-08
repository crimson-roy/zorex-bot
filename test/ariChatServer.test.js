"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WordNetDictionary } = require("../lib/wordNet");
const { createServer, respondToMessage, HOST } = require("../dev/ari-chat-server");

async function main() {
    const arithmetic = respondToMessage("What is 1 + 1?");
    assert.equal(arithmetic.reply, "2");
    assert.match(arithmetic.mode, /no AI API/i);

    const greeting = respondToMessage("Hi Ari");
    assert.match(greeting.reply, /Hi!/);
    assert.match(greeting.mode, /no AI API/i);

    const unsupported = respondToMessage("Explain photosynthesis.");
    assert.match(unsupported.reply, /local tools/i);

    const dictionaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "ari-server-wordnet-"));
    try {
        fs.writeFileSync(path.join(dictionaryDir, "index.noun"),
            "persistence n 1 0 1 1 00000000\n");
        fs.writeFileSync(path.join(dictionaryDir, "data.noun"),
            "00000000 00 n 01 persistence 0 000 | the act or condition of persisting\n");

        const dictionary = new WordNetDictionary({ dictDir: dictionaryDir });
        const definition = respondToMessage("What does persistence mean?", { dictionary });
        assert.match(definition.reply, /condition of persisting/);
        assert.match(definition.mode, /WordNet dictionary/);
    } finally {
        fs.rmSync(dictionaryDir, { recursive: true, force: true });
    }

    const app = createServer();
    await new Promise((resolve, reject) => {
        app.once("error", reject);
        app.listen(0, HOST, resolve);
    });

    try {
        const address = app.address();
        const baseUrl = `http://${HOST}:${address.port}`;

        const page = await fetch(baseUrl + "/");
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.match(html, /Type to get started with Ari/);
        assert.match(html, /ari-playground-chats-v1/);
        assert.match(html, /id="chat-list"/);
        assert.match(html, /Delete this conversation from this browser/);
        assert.ok(html.includes("localStorage.setItem"));

        const health = await fetch(baseUrl + "/api/health");
        assert.equal(health.status, 200);
        const healthBody = await health.json();
        assert.equal(healthBody.ok, true);
        assert.equal(healthBody.mode, "local");
        assert.equal(healthBody.aiModelConnected, false);
        assert.equal(typeof healthBody.wordNetAvailable, "boolean");

        const chat = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "1 + 1" })
        });
        assert.equal(chat.status, 200);
        const chatBody = await chat.json();
        assert.equal(chatBody.reply, "2");
        assert.match(chatBody.mode, /no AI API/i);

        const greetingChat = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Hi Ari" })
        });
        assert.equal(greetingChat.status, 200);
        assert.match((await greetingChat.json()).reply, /Hi!/);

        const empty = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "   " })
        });
        assert.equal(empty.status, 400);

        console.log("PASS: Ari playground serves persistent history and handles local arithmetic and greetings over HTTP.");
    } finally {
        await new Promise(resolve => app.close(resolve));
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
