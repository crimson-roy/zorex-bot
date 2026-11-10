"use strict";

const assert = require("node:assert/strict");
const { AriGpuClient, AriGpuClientError, normalizeBaseUrl } = require("../dev/ariGpuClient");

function response(status, payload) {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

async function main() {
    const noConfig = new AriGpuClient({ env: {}, fetchImpl: async () => { throw new Error("should not fetch"); } });
    assert.deepEqual(noConfig.availability(), { configured: false, connected: false, error: "ARI_GPU_BASE_URL is not configured." });
    await assert.rejects(noConfig.chat({ tier: "medium" }), error => error.code === "GPU_NOT_CONFIGURED" && error.statusCode === 503);
    assert.throws(() => normalizeBaseUrl("http://example.org"), error => error.code === "GPU_CONFIG_INVALID");
    assert.throws(() => normalizeBaseUrl("https://user:secret@example.org"), AriGpuClientError);

    let captured;
    const client = new AriGpuClient({
        env: { ARI_GPU_BASE_URL: "https://abc.trycloudflare.com/", ARI_GPU_API_KEY: "test-secret" },
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return response(200, {
                status: "ok",
                models: { qwen3_4b: { available: true } },
                tiers: { medium: { text_ready: true, image_ready: false } },
                gpus: []
            });
        }
    });
    const health = await client.health();
    assert.equal(health.connected, true);
    assert.equal(captured.url, "https://abc.trycloudflare.com/health");
    assert.equal(captured.options.headers.Authorization, "Bearer test-secret");
    assert.equal(JSON.stringify(health).includes("test-secret"), false);

    const request = {
        tier: "ultra",
        messages: [{ role: "user", content: "Hello" }],
        image: null,
        options: { thinking: false, max_new_tokens: 16 }
    };
    const goodClient = new AriGpuClient({
        env: { ARI_GPU_BASE_URL: "https://abc.trycloudflare.com", ARI_GPU_API_KEY: "test-secret" },
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return response(200, { reply: "Hello from Ultra", tier: "ultra", model: "google/gemma-4-E4B-it" });
        }
    });
    const answer = await goodClient.chat(request);
    assert.equal(answer.reply, "Hello from Ultra");
    assert.equal(captured.url.endsWith("/v1/chat"), true);
    assert.deepEqual(JSON.parse(captured.options.body), request);
    assert.equal(captured.options.headers.Authorization, "Bearer test-secret");

    const verifiedKaggleClient = new AriGpuClient({
        env: { ARI_GPU_BASE_URL: "https://abc.trycloudflare.com", ARI_GPU_API_KEY: "test-secret" },
        fetchImpl: async () => response(200, { ok: true, tier: "medium", answer: "ARI CONNECTION OK" })
    });
    const verified = await verifiedKaggleClient.chat({ ...request, tier: "medium" });
    assert.equal(verified.reply, "ARI CONNECTION OK");
    assert.equal(verified.answer, "ARI CONNECTION OK");

    const markdown = "Here is a list:\n\n- **First**\n- Second\n\nDone.";
    const markdownClient = new AriGpuClient({
        env: { ARI_GPU_BASE_URL: "https://abc.trycloudflare.com", ARI_GPU_API_KEY: "test-secret" },
        fetchImpl: async () => response(200, { ok: true, tier: "medium", answer: markdown })
    });
    assert.equal((await markdownClient.chat({ ...request, tier: "medium" })).reply, markdown);

    for (const [status, expectedCode] of [[401, "GPU_HTTP_401"], [413, "GPU_HTTP_413"], [429, "GPU_HTTP_429"], [500, "GPU_HTTP_500"], [503, "GPU_HTTP_503"]]) {
        const failing = new AriGpuClient({
            env: { ARI_GPU_BASE_URL: "https://abc.trycloudflare.com", ARI_GPU_API_KEY: "test-secret" },
            fetchImpl: async () => response(status, { error: "mocked failure" })
        });
        await assert.rejects(failing.chat(request), error => error.code === expectedCode);
    }

    const badPayload = new AriGpuClient({
        env: { ARI_GPU_BASE_URL: "https://abc.trycloudflare.com", ARI_GPU_API_KEY: "test-secret" },
        fetchImpl: async () => response(200, { reply: "", tier: "ultra", model: "google/gemma-4-E4B-it" })
    });
    await assert.rejects(badPayload.chat(request), error => error.code === "GPU_BAD_RESPONSE" && error.statusCode === 502);

    for (const invalid of [
        { ok: true, tier: "ultra", answer: "   " },
        { ok: true, tier: "ultra" },
        "not-json",
        { ok: true, tier: "ultra", answer: { text: "not a string" } },
        { ok: true, tier: "max", answer: "Wrong tier" }
    ]) {
        const invalidClient = new AriGpuClient({
            env: { ARI_GPU_BASE_URL: "https://abc.trycloudflare.com", ARI_GPU_API_KEY: "test-secret" },
            fetchImpl: async () => response(200, invalid)
        });
        await assert.rejects(invalidClient.chat(request), error => error.code === "GPU_BAD_RESPONSE");
    }

    const disconnected = new AriGpuClient({
        env: { ARI_GPU_BASE_URL: "https://abc.trycloudflare.com", ARI_GPU_API_KEY: "test-secret" },
        fetchImpl: async () => { throw new Error("network down"); }
    });
    assert.equal((await disconnected.health()).connected, false);
    await assert.rejects(disconnected.chat(request), error => error.code === "GPU_DISCONNECTED");

    let resolveFetch;
    const timedOut = new AriGpuClient({
        env: { ARI_GPU_BASE_URL: "https://abc.trycloudflare.com", ARI_GPU_API_KEY: "test-secret" },
        timeoutMs: 10,
        fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
            resolveFetch = reject;
            options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        })
    });
    await assert.rejects(timedOut.chat(request), error => error.code === "GPU_TIMEOUT");
    if (resolveFetch) resolveFetch(new Error("done"));

    console.log("ariGpuClient.test.js: mocked client tests passed");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
