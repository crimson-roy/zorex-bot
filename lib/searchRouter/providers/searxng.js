"use strict";
const { requestJson, normalizedResult } = require("../providerUtils");

function normalizeBaseUrl(value) {
    if (!value) return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
}

class SearXNGProvider {
    constructor({ env = process.env, fetchImpl } = {}) {
        this.name = "searxng";
        this.baseUrl = normalizeBaseUrl(String(env.SEARXNG_BASE_URL || "").trim());
        // SearXNG's documented public search API has no standard API-key
        // authentication header. Keep the optional key out of requests until
        // an instance administrator documents the correct auth contract.
        this.apiKeyConfigured = Boolean(String(env.SEARXNG_API_KEY || "").trim());
        this.fetchImpl = fetchImpl;
        this.configured = Boolean(this.baseUrl);
    }
    async search(options, config) {
        if (!this.configured) throw new Error("SearXNG is not configured with a valid base URL");
        const url = new URL(`${this.baseUrl}/search`);
        url.searchParams.set("q", options.query);
        url.searchParams.set("format", "json");
        url.searchParams.set("count", String(options.limit));
        if (options.language) url.searchParams.set("language", options.language);
        if (options.freshness) url.searchParams.set("time_range", options.freshness);
        const headers = { Accept: "application/json" };
        const { data } = await requestJson(url, { headers }, { timeoutMs: config.timeoutMs, fetchImpl: this.fetchImpl });
        if (!Array.isArray(data.results)) throw Object.assign(new Error("SearXNG response is missing results"), { kind: "invalid_response" });
        return { results: data.results.map(item => normalizedResult({
            title: item.title, url: item.url, snippet: item.content || item.snippet,
            content: null, published_at: item.publishedDate || item.published_at,
            score: item.score
        }, this.name)).filter(Boolean), credits: null };
    }
}
SearXNGProvider.normalizeBaseUrl = normalizeBaseUrl;
module.exports = SearXNGProvider;
