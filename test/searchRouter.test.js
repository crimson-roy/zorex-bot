"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const priorSearchEnabled = process.env.SEARCH_ENABLED;
process.env.SEARCH_ENABLED = "false";
const { SearchRouter, canonicalUrl, deduplicate, open_webpage } = require("../lib/searchRouter");
const { requestJson } = require("../lib/searchRouter/providerUtils");
const { searchTools, formatUntrustedToolOutput } = require("../lib/searchRouter/tools");
const { openWebpage, resolvePublicHost, extractPage } = require("../lib/searchRouter/openWebpage");
const TavilyProvider = require("../lib/searchRouter/providers/tavily");
const SearXNGProvider = require("../lib/searchRouter/providers/searxng");
const SerperProvider = require("../lib/searchRouter/providers/serper");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "zorex-search-router-"));
const stateFile = path.join(temp, "usage.json");
let now = Date.parse("2026-11-09T12:00:00.000Z");

function provider(name, fn, configured = true) {
    return { name, configured, search: fn };
}
function makeRouter(providers, overrides = {}) {
    const env = {
        SEARCH_ENABLED: "true", SEARCH_PROVIDER_ORDER: "tavily,searxng,serper",
        SEARCH_MAX_FALLBACKS: "2", SEARCH_CIRCUIT_FAILURES: "3",
        SEARCH_CIRCUIT_COOLDOWN_MS: "5000", SEARCH_MONTHLY_SOFT_LIMIT: "900",
        SEARCH_RESEARCH_MODE: "true", ...overrides
    };
    return new SearchRouter({ env, providers, stateFile,
        state: { month: "2026-11", requests: 0, successes: 0, failures: 0, credits: 0, providers: {} },
        clock: () => now });
}
function result(url, providerName, extra = {}) {
    return { title: "Example", url, snippet: "Snippet", content: null, published_at: null, provider: providerName, score: null, ...extra };
}
function response(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

async function testProviderNormalization() {
    let tavilyRequest;
    const tv = new TavilyProvider({ env: { TAVILY_API_KEY: "mock-secret" }, fetchImpl: async (url, init) => {
        tavilyRequest = { url: String(url), init };
        return response({ results: [{ title: "T", url: "https://example.org/a", content: "Snippet", raw_content: "Full", score: 0.7, published_date: "2026-11-01" }], usage: { credits: 2 } });
    } });
    const tvResult = await tv.search({ query: "q", limit: 3, freshness: "week", country: "US", research_mode: true }, { timeoutMs: 1000 });
    assert.equal(tavilyRequest.url, "https://api.tavily.com/search");
    assert.equal(tavilyRequest.init.headers.Authorization, "Bearer mock-secret");
    assert.equal(JSON.parse(tavilyRequest.init.body).search_depth, "advanced");
    assert.equal(tvResult.results[0].content, "Full");
    assert.equal(tvResult.results[0].provider, "tavily");
    assert.equal(tvResult.credits, 2);

    let sxUrl;
    const sx = new SearXNGProvider({ env: { SEARXNG_BASE_URL: "https://search.example/base" }, fetchImpl: async url => {
        sxUrl = new URL(url); return response({ results: [{ title: "S", url: "https://example.org/s", content: "text", score: 1 }] });
    } });
    const sxResult = await sx.search({ query: "query", limit: 4, language: "en", freshness: "month" }, { timeoutMs: 1000 });
    assert.equal(sxUrl.pathname, "/base/search");
    assert.equal(sxUrl.searchParams.get("format"), "json");
    assert.equal(sxUrl.searchParams.get("time_range"), "month");
    assert.equal(sxResult.results[0].provider, "searxng");

    let serperRequest;
    const serper = new SerperProvider({ env: { SERPER_API_KEY: "mock-serper" }, fetchImpl: async (url, init) => {
        serperRequest = { url: String(url), init };
        return response({ organic: [{ title: "S", link: "https://example.org/s", snippet: "Serper result", date: "2026-11-03" }] });
    } });
    const serperResult = await serper.search({ query: "latest", limit: 5, country: "NG", language: "en" }, { timeoutMs: 1000 });
    assert.equal(serperRequest.url, "https://google.serper.dev/search");
    assert.equal(serperRequest.init.headers["X-API-KEY"], "mock-serper");
    assert.deepEqual(JSON.parse(serperRequest.init.body), { q: "latest", num: 5, gl: "ng", hl: "en" });
    assert.equal(serperResult.results[0].provider, "serper");
    assert.equal(serperResult.results[0].published_at, "2026-11-03T00:00:00.000Z");
    assert.equal(serperResult.credits, null);

    await assert.rejects(requestJson("https://provider.invalid/search", {}, {
        timeoutMs: 1000, fetchImpl: async () => response({ error: "rate limit" }, 429, { "retry-after": "17" })
    }), error => error.status === 429 && error.retryAfter === "17");
    await assert.rejects(requestJson("https://provider.invalid/search", {}, {
        timeoutMs: 1000,
        fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true }))
    }), error => error.kind === "timeout");
}

async function testNoProviderAndValidation() {
    const router = makeRouter({ tavily: provider("tavily", async () => ({ results: [] }), false), searxng: provider("searxng", async () => ({ results: [] }), false), serper: provider("serper", async () => ({ results: [] }), false) });
    await assert.rejects(router.web_search("hello"), e => e.code === "NO_SEARCH_PROVIDER");
    await assert.rejects(router.web_search(" "), e => e.statusCode === 400);
    await assert.rejects(router.web_search("hello", { freshness: "hour" }), e => e.statusCode === 400);
    const disabled = makeRouter({}, { SEARCH_ENABLED: "false" });
    await assert.rejects(disabled.web_search("hello"), e => e.code === "SEARCH_DISABLED");
    await assert.rejects(open_webpage("https://example.org/"), e => e.code === "SEARCH_DISABLED");
}

async function testFallbackAndStatusHandling() {
    let primaryCalls = 0, fallbackCalls = 0;
    const router = makeRouter({
        tavily: provider("tavily", async () => { primaryCalls++; throw Object.assign(new Error("down"), { status: 503, kind: "http" }); }),
        searxng: provider("searxng", async () => { fallbackCalls++; return { results: [result("https://example.org/ok", "searxng")] }; }),
        serper: provider("serper", async () => ({ results: [] }))
    });
    const data = await router.web_search("q");
    assert.equal(primaryCalls, 1); assert.equal(fallbackCalls, 1);
    assert.deepEqual(data.providers_used, ["searxng"]);
    assert.equal(data.results.length, 1);

    for (const status of [401, 403]) {
        const authRouter = makeRouter({
            tavily: provider("tavily", async () => { throw Object.assign(new Error("auth"), { status }); }),
            searxng: provider("searxng", async () => ({ results: [result("https://example.org/auth-fallback", "searxng")] })),
            serper: provider("serper", async () => ({ results: [] }))
        });
        const fallback = await authRouter.web_search("q");
        assert.equal(fallback.providers_used[0], "searxng");
        assert.equal(authRouter.getStatus().providers.find(p => p.name === "tavily").eligible, false);
    }
    for (const status of [429, 500, 502, 503]) {
        const rateRouter = makeRouter({
            tavily: provider("tavily", async () => { throw Object.assign(new Error("status"), { status, retryAfter: "30" }); }),
            searxng: provider("searxng", async () => ({ results: [result("https://example.org/fallback", "searxng")] })),
            serper: provider("serper", async () => ({ results: [] }))
        });
        await rateRouter.web_search("q");
        const tavily = rateRouter.getStatus().providers.find(p => p.name === "tavily");
        if (status === 429) { assert.equal(tavily.rate_limit_events, 1); assert.ok(Date.parse(tavily.rate_limited_until) > now); }
    }
    const timeoutRouter = makeRouter({
        tavily: provider("tavily", async () => { throw Object.assign(new Error("timeout"), { kind: "timeout" }); }),
        searxng: provider("searxng", async () => ({ results: [result("https://example.org/timeout", "searxng")] })),
        serper: provider("serper", async () => ({ results: [] }))
    });
    assert.equal((await timeoutRouter.web_search("q")).providers_used[0], "searxng");

    const invalidRouter = makeRouter({
        tavily: provider("tavily", async () => { throw Object.assign(new Error("bad payload"), { kind: "invalid_response" }); }),
        searxng: provider("searxng", async () => ({ results: [result("https://example.org/valid", "searxng")] })),
        serper: provider("serper", async () => ({ results: [] }))
    });
    assert.equal((await invalidRouter.web_search("q")).providers_used[0], "searxng");
}

async function testCircuitQuotaAndRecovery() {
    let attempts = 0;
    const circuit = makeRouter({
        tavily: provider("tavily", async () => { attempts++; throw Object.assign(new Error("server"), { status: 500 }); }),
        searxng: provider("searxng", async () => ({ results: [] }), false),
        serper: provider("serper", async () => ({ results: [] }), false)
    }, { SEARCH_MAX_FALLBACKS: "0" });
    for (let i = 0; i < 3; i++) await assert.rejects(circuit.web_search("q"), e => e.code === "SEARCH_FAILED");
    assert.equal(circuit.getStatus().providers[0].circuit_breaker, "open");
    now += 6000;
    circuit.providers.tavily.search = async () => ({ results: [result("https://example.org/recovered", "tavily")] });
    assert.equal((await circuit.web_search("q")).results.length, 1);
    assert.equal(circuit.getStatus().providers[0].circuit_breaker, "closed");
    assert.equal(attempts, 3);

    const quota = makeRouter({
        tavily: provider("tavily", async () => ({ results: [result("https://example.org/quota", "tavily")] })),
        searxng: provider("searxng", async () => ({ results: [] }), false),
        serper: provider("serper", async () => ({ results: [] }), false)
    }, { SEARCH_MONTHLY_SOFT_LIMIT: "1" });
    await quota.web_search("first");
    await assert.rejects(quota.web_search("second"), e => e.code === "NO_SEARCH_PROVIDER");
    assert.equal(quota.getStatus().total.requests, 1);

    const monthState = {
        month: "2026-10", requests: 7, successes: 6, failures: 1, credits: 4,
        providers: { tavily: { month: "2026-10", requests: 7, successes: 6, failures: 1, credits: 4, observations: [] } }
    };
    const monthly = new SearchRouter({
        env: { SEARCH_ENABLED: "true", SEARCH_PROVIDER_ORDER: "tavily" },
        providers: { tavily: provider("tavily", async () => ({ results: [] })) },
        state: monthState, stateFile, clock: () => now
    });
    assert.equal(monthly.getStatus().month_utc, "2026-11");
    assert.equal(monthly.getStatus().total.requests, 0);
}

async function testCanonicalDedupAndResearchMode() {
    assert.equal(canonicalUrl("HTTPS://Example.org:443/a/?utm_source=x&keep=1#part"), "https://example.org/a?keep=1");
    const unique = deduplicate([
        result("https://example.org/a?utm_source=x#one", "tavily"),
        result("https://EXAMPLE.org/a#two", "serper")
    ]);
    assert.equal(unique.length, 1);
    assert.equal(unique[0].url, "https://example.org/a?utm_source=x#one");

    const research = makeRouter({
        tavily: provider("tavily", async () => ({ results: [result("https://example.org/shared?utm_medium=a", "tavily", { score: 0.9 }), result("https://example.org/one", "tavily")] })),
        searxng: provider("searxng", async () => ({ results: [result("https://example.org/shared#top", "searxng"), result("https://example.org/two", "searxng")] })),
        serper: provider("serper", async () => ({ results: [] }))
    });
    const output = await research.web_search("q", { research_mode: true });
    assert.deepEqual(new Set(output.providers_used), new Set(["tavily", "searxng"]));
    assert.equal(output.research_mode, true); assert.equal(output.results.length, 3);
    await assert.rejects(makeRouter({ tavily: provider("tavily", async () => ({ results: [] })) }, { SEARCH_RESEARCH_MODE: "false" })
        .web_search("q", { research_mode: true }), e => e.code === "RESEARCH_MODE_DISABLED");

    const researchFallback = makeRouter({
        tavily: provider("tavily", async () => { throw Object.assign(new Error("down"), { status: 503 }); }),
        searxng: provider("searxng", async () => ({ results: [result("https://example.org/second", "searxng")] })),
        serper: provider("serper", async () => ({ results: [result("https://example.org/third", "serper")] }))
    });
    const recovered = await researchFallback.web_search("q", { research_mode: true });
    assert.equal(recovered.providers_used.length, 2);
    assert.ok(recovered.providers_used.includes("serper"));
}

async function testPageExtractionAndSsrF() {
    await assert.rejects(resolvePublicHost("localhost", async () => [{ address: "8.8.8.8", family: 4 }]), e => e.code === "SSRF_BLOCKED");
    for (const address of ["127.0.0.1", "10.0.0.2", "169.254.169.254", "192.168.1.1", "::1", "fe80::1", "fc00::1"]) {
        await assert.rejects(resolvePublicHost(address), e => e.code === "SSRF_BLOCKED");
    }
    await assert.rejects(resolvePublicHost("rebind.example", async () => [
        { address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }
    ]), e => e.code === "SSRF_BLOCKED");

    let calls = 0;
    await assert.rejects(openWebpage("https://public.example/start", {}, {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        request: async url => {
            calls++;
            if (calls === 1) return { status: 302, headers: { location: "http://127.0.0.1/private" }, body: Buffer.alloc(0) };
            throw new Error("unsafe redirect was fetched");
        }
    }), e => e.code === "SSRF_BLOCKED");
    assert.equal(calls, 1, "unsafe redirect destination is rejected before requesting it");
}

async function testSafeRedirectAndContentType() {
    let calls = 0;
    const page = await openWebpage("https://public.example/start", {}, {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        request: async url => {
            calls++;
            if (calls === 1) return { status: 301, headers: { location: "/article" }, body: Buffer.alloc(0) };
            return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from('<html><head><title>Title</title><meta property="article:published_time" content="2026-01-02"></head><body><nav>ignore</nav><article><h1>Heading</h1><p>Readable content.</p><script>bad</script></article></body></html>') };
        }
    });
    assert.equal(calls, 2); assert.equal(page.title, "Title");
    assert.match(page.text, /Readable content/); assert.doesNotMatch(page.text, /ignore|bad/);
    assert.equal(page.publication_date, "2026-01-02T00:00:00.000Z");
    assert.equal(page.http_status, 200); assert.equal(page.source_url, "https://public.example/start");

    await assert.rejects(openWebpage("https://localhost/", {}, { lookup: async () => [] }), e => e.code === "SSRF_BLOCKED");
    await assert.rejects(openWebpage("file:///etc/passwd"), e => e.statusCode === 400);
    await assert.rejects(openWebpage("https://public.example/file", {}, {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        request: async () => ({ status: 200, headers: { "content-type": "application/pdf" }, body: Buffer.from("PDF") })
    }), e => e.code === "INVALID_CONTENT_TYPE");
    const plain = extractPage(Buffer.from("plain\ntext"), "text/plain");
    assert.equal(plain.text, "plain text"); assert.equal(plain.publicationDate, null);
}

async function testSchemasAndUntrustedBoundary() {
    assert.deepEqual(searchTools.map(tool => tool.function.name), ["web_search", "open_webpage"]);
    const toolMessage = formatUntrustedToolOutput("web_search", { results: [{ url: "https://example.org/" }] });
    assert.equal(toolMessage.role, "tool"); assert.equal(toolMessage.name, "web_search");
    assert.match(toolMessage.content, /UNTRUSTED EXTERNAL DATA/);
    assert.throws(() => formatUntrustedToolOutput("system", {}), TypeError);
    const docs = fs.readFileSync(path.join(__dirname, "..", "docs", "search-router.md"), "utf8");
    assert.match(docs, /untrusted/i);
    assert.match(docs, /does not attach it to Baileys/i);
}

async function main() {
    try {
        await testProviderNormalization();
        await testNoProviderAndValidation();
        await testFallbackAndStatusHandling();
        await testCircuitQuotaAndRecovery();
        await testCanonicalDedupAndResearchMode();
        await testPageExtractionAndSsrF();
        await testSafeRedirectAndContentType();
        await testSchemasAndUntrustedBoundary();
        console.log("searchRouter.test.js: all mocked tests passed");
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
        if (priorSearchEnabled === undefined) delete process.env.SEARCH_ENABLED;
        else process.env.SEARCH_ENABLED = priorSearchEnabled;
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
