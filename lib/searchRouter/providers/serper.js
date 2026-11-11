"use strict";

const { requestJson, normalizedResult } = require("../providerUtils");

class SerperProvider {
    constructor({ env = process.env, fetchImpl } = {}) {
        this.name = "serper";
        this.apiKey = String(env.SERPER_API_KEY || "").trim();
        this.fetchImpl = fetchImpl;
        this.configured = Boolean(this.apiKey);
    }

    async search(options, config) {
        if (!this.configured) throw new Error("Serper is not configured");

        const body = {
            q: options.query,
            num: options.limit
        };
        if (options.country) body.gl = options.country.toLowerCase();
        if (options.language) body.hl = options.language.toLowerCase();

        const { data } = await requestJson("https://google.serper.dev/search", {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-API-KEY": this.apiKey
            },
            body: JSON.stringify(body)
        }, { timeoutMs: config.timeoutMs, fetchImpl: this.fetchImpl });

        if (!Array.isArray(data.organic)) {
            throw Object.assign(new Error("Serper response is missing organic results"), { kind: "invalid_response" });
        }

        return {
            results: data.organic.map(item => normalizedResult({
                title: item.title,
                url: item.link,
                snippet: item.snippet,
                content: null,
                published_at: item.date,
                score: null
            }, this.name)).filter(Boolean),
            credits: null
        };
    }
}

module.exports = SerperProvider;
