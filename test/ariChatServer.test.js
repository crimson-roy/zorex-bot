"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WordNetDictionary } = require("../lib/wordNet");
const { createServer, respondToMessage, HOST } = require("../dev/ari-chat-server");
const { AriGpuClient } = require("../dev/ariGpuClient");

function createTestServer(options = {}) {
    const authService = {
        config: () => ({ clientId: "test-client", configured: true, error: null }),
        issueCsrf: () => ({ csrfToken: "test-csrf", clientId: "test-client", configured: true, error: null }),
        requireSession: () => ({ sub: "test-google-sub", email: "test@example.com", name: "Test" }),
        publicUser: session => ({ sub: session.sub, email: session.email, name: session.name }),
        assertOriginAndCsrf() {},
        authenticateCredential: async () => ({ authenticated: true }),
        logout: () => ({ ok: true }),
    };
    const usageStore = { async consumeAcceptedMessage() { return { allowed: true }; } };
    return createServer({ ...options, authService, usageStore });
}

async function main() {
    const arithmetic = respondToMessage("What is 1 + 1?");
    assert.equal(arithmetic.reply, "2");
    assert.match(arithmetic.mode, /no AI API/i);

    const greeting = respondToMessage("Hi Ari");
    assert.match(greeting.reply, /Hi!/);
    assert.match(greeting.mode, /no AI API/i);

    const unsupported = respondToMessage("Explain photosynthesis.");
    assert.match(unsupported.reply, /still learning/i);

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

    const app = createTestServer();
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
        assert.match(html, /Welcome back/);
        assert.match(html, /Google sign-in is currently enabled/);
        assert.match(html, /Other account methods will appear when their verification service is ready/);
        assert.doesNotMatch(html, /invited developers only|invited Google account/i);
        assert.match(html, /<link rel="icon" type="image\/png" href="\/ari-favicon\.png">/);
        const favicon = await fetch(baseUrl + "/ari-favicon.png");
        assert.equal(favicon.status, 200);
        assert.equal(favicon.headers.get("content-type"), "image/png");
        assert.ok(Number(favicon.headers.get("content-length")) > 1000);
        assert.match(html, /Where should we begin/);
        assert.match(html, /ari-playground-chats-v1/);
        assert.match(html, /id="chat-list"/);
        assert.match(html, /--sidebar-width: 268px/);
        assert.match(html, /Newsreader/);
        assert.match(html, /id="library-nav"/);
        assert.match(html, /id="projects-nav"/);
        assert.match(html, /id="account-menu"/);
        assert.match(html, /Profile \/ About You/);
        assert.match(html, /data-account-view="memory"/);
        assert.match(html, /data-account-view="settings"/);
        assert.match(html, /id="workspace-screen"/);
        assert.match(html, /id="attachment-preview"/);
        assert.match(html, /id="paste-card"/);
        assert.match(html, /Copy response/);
        assert.match(html, /function showWorkspaceView/);
        assert.match(html, /Project workspaces in progress/);
        assert.match(html, /Ari does not yet have the verification and account-data deletion endpoint/);
        assert.match(html, /Delete this conversation from this browser/);
        assert.doesNotMatch(html, /class="history-delete"|textContent = "×"/);
        assert.match(html, /contextmenu/);
        assert.match(html, /event\.pointerType !== "touch"/);
        assert.match(html, /Unpin chat/);
        assert.match(html, /target\.pinned = !target\.pinned/);
        assert.match(html, /Create a short chat-list title from this exchange/);
        assert.match(html, /function generateChatTitle/);
        assert.match(html, /Thinking…/);
        assert.doesNotMatch(html, /Ari is replying/);
        assert.match(html, /id="sidebar-toggle"/);
        assert.match(html, /sidebar-collapsed/);
        assert.match(html, /id="attach-menu" role="menu" hidden/);
        assert.match(html, /data-picker="image-input"/);
        assert.match(html, /Photos and images/);
        assert.match(html, /data-picker="audio-input"/);
        assert.match(html, /<span>Audio<\/span>/);
        assert.match(html, /data-picker="file-input"/);
        assert.match(html, /Documents and files/);
        assert.match(html, /Audio and file uploads will be available after Ari's server supports them/);
        assert.ok(html.includes("localStorage.setItem"));
        assert.doesNotMatch(html, /id="model-status"|id="chat-controls"|Kaggle|Cloudflare|Checking Ari-0/);
        assert.match(html, /id="attach-button"/);
        assert.match(html, /attachButton\.addEventListener\("click", \(\) => setAttachMenuOpen\(attachMenu\.hidden\)\)/);
        assert.match(html, /id="tier-select"/);
        assert.match(html, /id="image-input"/);
        assert.match(html, /#image-input, #audio-input, #file-input \{ display: none; \}/);
        assert.match(html, /id="think-toggle" type="button" aria-pressed="false"/);
        assert.match(html, /Ari is AI and can make mistakes\. Please double-check important information\./);
        assert.match(html, /resizeComposer\(\)/);
        assert.match(html, /reader\.readAsDataURL\(file\)/);
        assert.match(html, /data_base64/);
        assert.match(html, /<option value="medium">Medium<\/option>/);
        assert.doesNotMatch(html, /Qwen|Gemma|Alibaba Cloud|Cloudflare|Kaggle|NVIDIA|cuda:\d/);

        const health = await fetch(baseUrl + "/api/health");
        assert.equal(health.status, 200);
        const healthBody = await health.json();
        assert.equal(healthBody.ok, true);
        assert.equal(healthBody.aiModelConnected, false);
        assert.equal(healthBody.gpu.connected, false);
        assert.equal(healthBody.gpu.ready, false);
        assert.equal(JSON.stringify(healthBody).includes("wordNetAvailable"), false);

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

        const creatorQuestion = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Who created you?", tier: "medium" })
        });
        assert.equal(creatorQuestion.status, 200);
        assert.equal((await creatorQuestion.json()).reply, "I'm Ari, an AI assistant created by Zorex AI.");

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
    const modelCalls = [];
    const modelApp = createTestServer({
        modelClient: {
            async health() {
                return { connected: true, model: "Ari-0 BPE v3", mode: "fine-tuned", step: 500, parameters: 1874688 };
            },
            async generate(messages) {
                modelCalls.push(messages);
                return { reply: "Generated by our v3 checkpoint.", model: "Ari-0 BPE v3", step: 500 };
            }
        }
    });
    await new Promise((resolve, reject) => {
        modelApp.once("error", reject);
        modelApp.listen(0, HOST, resolve);
    });

    try {
        const baseUrl = `http://${HOST}:${modelApp.address().port}`;
        const health = await (await fetch(baseUrl + "/api/health")).json();
        assert.equal(health.aiModelConnected, true);
        assert.equal(Object.hasOwn(health, "model"), false);
        assert.equal(JSON.stringify(health).includes("Ari-0 BPE v3"), false);

        const response = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: "Hello Ari",
                messages: [
                    { role: "user", content: "Hi there" },
                    { role: "assistant", content: "Hello!" },
                    { role: "user", content: "Hello Ari" }
                ]
            })
        });
        assert.equal(response.status, 200);
        const generated = await response.json();
        assert.equal(generated.reply, "Generated by our v3 checkpoint.");
        assert.equal(generated.mode, "Mini");
        assert.equal(modelCalls.length, 1);
        assert.equal(modelCalls[0].length, 3);
        assert.equal(modelCalls[0][1].role, "assistant");

        const math = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "2 + 2" })
        });
        assert.equal((await math.json()).reply, "4");
        assert.equal(modelCalls.length, 1, "deterministic maths should not call the language model");

        console.log("PASS: Ari playground routes chat to the injected local model and preserves deterministic maths.");
    } finally {
        await new Promise(resolve => modelApp.close(resolve));
    }

    const gpuCalls = [];
    const gpuApp = createTestServer({
        gpuClient: {
            async health() {
                return {
                    configured: true,
                    connected: true,
                    models: { qwen3_4b: { id: "Qwen/Qwen3-4B" } },
                    tiers: { medium: { text_ready: true, model: "Qwen/Qwen3-4B", device: "cuda:1" } },
                    gpus: [{ name: "NVIDIA Tesla T4", device: "cuda:1" }]
                };
            },
            async chat(payload) {
                gpuCalls.push(payload);
                return { reply: "Kaggle response.", model: "Qwen/Qwen3-4B", tier: payload.tier };
            }
        }
    });
    await new Promise((resolve, reject) => {
        gpuApp.once("error", reject);
        gpuApp.listen(0, HOST, resolve);
    });
    try {
        const baseUrl = `http://${HOST}:${gpuApp.address().port}`;
        const health = await (await fetch(baseUrl + "/api/health")).json();
        assert.equal(health.gpu.connected, true);
        assert.equal(health.gpu.ready, true);
        assert.equal(Object.hasOwn(health.gpu, "tiers"), false);
        assert.equal(JSON.stringify(health).includes("Qwen"), false);
        assert.equal(JSON.stringify(health).includes("cuda:1"), false);
        assert.equal(JSON.stringify(health).includes("T4"), false);

        const remote = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: "Explain photosynthesis.",
                tier: "medium",
                messages: [{ role: "user", content: "Explain photosynthesis." }],
                image: null,
                options: { thinking: false, max_new_tokens: 32 }
            })
        });
        assert.equal(remote.status, 200);
        const remoteBody = await remote.json();
        assert.equal(remoteBody.reply, "Kaggle response.");
        assert.equal(remoteBody.mode, "Medium");
        assert.equal(JSON.stringify(remoteBody).includes("Qwen"), false);
        assert.equal(gpuCalls[0].tier, "medium");
        assert.equal(gpuCalls[0].messages.length, 1);
        assert.equal(gpuCalls[0].options.thinking, false);
        assert.equal(Object.hasOwn(await (await fetch(baseUrl + "/api/health")).json(), "model"), false);

        const thinkingResponse = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: "Compare these two ideas carefully.",
                tier: "medium",
                options: { thinking: true, max_new_tokens: 1024 }
            })
        });
        assert.equal(thinkingResponse.status, 200);
        assert.equal(gpuCalls[1].options.thinking, true);
        assert.equal(gpuCalls[1].options.max_new_tokens, 1024);

        const imageBytes = Buffer.from("mock-image").toString("base64");
        const remoteImage = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: "What is in this image?",
                tier: "ultra",
                messages: [{ role: "user", content: "What is in this image?" }],
                image: { mime_type: "image/png", data_base64: imageBytes },
                options: { thinking: false, max_new_tokens: 32 }
            })
        });
        assert.equal(remoteImage.status, 200);
        assert.equal(gpuCalls[2].tier, "ultra");
        assert.equal(gpuCalls[2].image.mime_type, "image/png");

        const unsupportedImage = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: "What is in this image?",
                tier: "mini",
                messages: [{ role: "user", content: "What is in this image?" }],
                image: { mime_type: "image/png", data_base64: imageBytes }
            })
        });
        assert.equal(unsupportedImage.status, 400);

        const noGpuApp = createTestServer();
        await new Promise((resolve, reject) => {
            noGpuApp.once("error", reject);
            noGpuApp.listen(0, HOST, resolve);
        });
        try {
            const response = await fetch(`http://${HOST}:${noGpuApp.address().port}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: "Explain photosynthesis.",
                    tier: "medium",
                    messages: [{ role: "user", content: "Explain photosynthesis." }]
                })
            });
            assert.equal(response.status, 503);
            assert.match((await response.json()).error, /temporarily unavailable for that model/i);
        } finally {
            await new Promise(resolve => noGpuApp.close(resolve));
        }

        const failureApp = createTestServer({
            gpuClient: {
                async health() { return { configured: true, connected: false, tiers: {} }; },
                async chat() {
                    const error = new Error("Qwen failed at https://secret-tunnel.trycloudflare.com with private details");
                    error.statusCode = 502;
                    error.code = "GPU_HTTP_500";
                    throw error;
                }
            }
        });
        await new Promise((resolve, reject) => {
            failureApp.once("error", reject);
            failureApp.listen(0, HOST, resolve);
        });
        const originalConsoleError = console.error;
        console.error = () => {};
        try {
            const response = await fetch(`http://${HOST}:${failureApp.address().port}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: "hello", tier: "medium" })
            });
            const failure = await response.json();
            assert.equal(response.status, 502);
            assert.match(failure.error, /Ari couldn't complete that answer/);
            assert.equal(JSON.stringify(failure).includes("Qwen"), false);
            assert.equal(JSON.stringify(failure).includes("trycloudflare"), false);
        } finally {
            console.error = originalConsoleError;
            await new Promise(resolve => failureApp.close(resolve));
        }

        const defaultMini = await fetch(baseUrl + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "1 + 1" })
        });
        assert.equal((await defaultMini.json()).reply, "2");
        assert.equal(gpuCalls.length, 3);
        console.log("PASS: Ari routes selected GPU tiers independently and preserves Mini and local maths.");
    } finally {
        await new Promise(resolve => gpuApp.close(resolve));
    }

    const directClient = new AriGpuClient({
        env: { ARI_GPU_BASE_URL: "https://fixture.trycloudflare.com", ARI_GPU_API_KEY: "fixture-secret" },
        fetchImpl: async url => {
            if (url.endsWith("/health")) {
                return new Response(JSON.stringify({ status: "ok", models: {}, tiers: { medium: { text_ready: true } }, gpus: [] }), { status: 200 });
            }
            return new Response(JSON.stringify({ ok: true, tier: "medium", answer: "ARI CONNECTION OK" }), { status: 200 });
        }
    });
    const browserPathApp = createTestServer({ gpuClient: directClient });
    await new Promise((resolve, reject) => {
        browserPathApp.once("error", reject);
        browserPathApp.listen(0, HOST, resolve);
    });
    try {
        const response = await fetch(`http://${HOST}:${browserPathApp.address().port}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Say the connection is okay.", tier: "medium" })
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.reply, "ARI CONNECTION OK");
        assert.equal(result.mode, "Medium");
        assert.equal(JSON.stringify(result).includes("Qwen"), false);
        console.log("PASS: Browser chat route accepts the verified Kaggle answer response shape.");
    } finally {
        await new Promise(resolve => browserPathApp.close(resolve));
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
