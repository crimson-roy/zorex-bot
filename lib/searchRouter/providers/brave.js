"use strict";
const { requestJson, normalizedResult } = require("../providerUtils");

const FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" };
class BraveProvider {
    constructor({ env = process.env, fetchImpl } = {}) {
        this.name = "brave";
        this.apiKey = String(env.BRAVE_SEARCH_API_KEY || "").trim();
        this.fetchImpl = fetchImpl;
        this.configured = Boolean(this.apiKey);
    }
    async search(options, config) {
        if (!this.configured) throw new Error("Brave Search is not configured");
        const url = new URL("https://api.search.brave.com/res/v1/web/search");
        url.searchParams.set("q", options.query);
        url.searchParams.set("count", String(options.limit));
        url.searchParams.set("text_decorations", "false");
        if (options.freshness) url.searchParams.set("freshness", FRESHNESS[options.freshness]);
        if (options.country) url.searchParams.set("country", options.country.toUpperCase());
        if (options.language) url.searchParams.set("search_lang", options.language);
        const { data } = await requestJson(url, {
            headers: { Accept: "application/json", "X-Subscription-Token": this.apiKey }
        }, { timeoutMs: config.timeoutMs, fetchImpl: this.fetchImpl });
        const results = data.web?.results;
        if (!Array.isArray(results)) throw Object.assign(new Error("Brave response is missing web.results"), { kind: "invalid_response" });
        return { results: results.map(item => normalizedResult({
            title: item.title, url: item.url, snippet: item.description,
            content: null, published_at: item.page_age || item.age,
            score: null
        }, this.name)).filter(Boolean), credits: null };
    }
}
module.exports = BraveProvider;
