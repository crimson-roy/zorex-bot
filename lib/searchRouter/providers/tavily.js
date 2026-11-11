"use strict";
const { requestJson, normalizedResult } = require("../providerUtils");

class TavilyProvider {
    constructor({ env = process.env, fetchImpl } = {}) {
        this.name = "tavily";
        this.apiKey = String(env.TAVILY_API_KEY || "").trim();
        this.fetchImpl = fetchImpl;
        this.configured = Boolean(this.apiKey);
    }
    async search(options, config) {
        if (!this.configured) throw new Error("Tavily is not configured");
        const body = {
            query: options.query,
            max_results: options.limit,
            search_depth: options.research_mode ? "advanced" : "basic",
            topic: "general",
            include_raw_content: options.research_mode ? "text" : false,
            include_usage: true
        };
        if (options.freshness) body.time_range = options.freshness;
        if (options.country) body.country = options.country;
        if (options.language) body.language = options.language;
        const { data } = await requestJson("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify(body)
        }, { timeoutMs: config.timeoutMs, fetchImpl: this.fetchImpl });
        if (!Array.isArray(data.results)) throw Object.assign(new Error("Tavily response is missing results"), { kind: "invalid_response" });
        return {
            results: data.results.map(item => normalizedResult({
                title: item.title, url: item.url, snippet: item.content,
                content: typeof item.raw_content === "string" ? item.raw_content : null,
                published_at: item.published_date, score: item.score
            }, this.name)).filter(Boolean),
            credits: Number.isFinite(data.usage?.credits) ? data.usage.credits :
                Number.isFinite(data.credits) ? data.credits : null
        };
    }
}
module.exports = TavilyProvider;
