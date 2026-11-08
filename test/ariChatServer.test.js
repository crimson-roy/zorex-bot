"use strict";

const assert = require("node:assert/strict");
const { createServer, respondToMessage, HOST } = require("../dev/ari-chat-server");

async function main() {
    const arithmetic = respondToMessage("What is 1 + 1?");
    assert.equal(arithmetic.reply, "2");
    assert.match(arithmetic.mode, /no AI API/i);

    const unsupported = respondToMessage("Explain photosynthesis.");
    assert.match(unsupported.reply, /local language model is not connected yet/i);

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
        assert.match(html, /aria-playground-chats-v1/);
        assert.match(html, /id="chat-list"/);
        assert.match(html, /Delete this conversation from this browser/);
        assert.match(html, /localStorage\.setItem/);

        const health = await fetch(baseUrl + "/api/health");
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), {
            ok: true,
            mode: "local",
            aiModelConnected: false
        });

        const chat = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "1 + 1" })
        });
        assert.equal(chat.status, 200);
        const chatBody = await chat.json();
        assert.equal(chatBody.reply, "2");
        assert.match(chatBody.mode, /no AI API/i);

        const empty = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "   " })
        });
        assert.equal(empty.status, 400);

        console.log("PASS: Ari playground serves its persistent-history UI and answers arithmetic locally over HTTP.");
    } finally {
        await new Promise(resolve => app.close(resolve));
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
