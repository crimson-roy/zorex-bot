"use strict";

class ProviderError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "ProviderError";
        Object.assign(this, details);
    }
}

const MAX_JSON_BYTES = 2 * 1024 * 1024;

async function readLimitedBody(response, maxBytes = MAX_JSON_BYTES) {
    const contentLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new ProviderError("Provider response exceeded the size limit", { kind: "invalid_response" });
    }
    if (!response.body?.getReader) {
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > maxBytes) {
            throw new ProviderError("Provider response exceeded the size limit", { kind: "invalid_response" });
        }
        return text;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
                await reader.cancel().catch(() => {});
                throw new ProviderError("Provider response exceeded the size limit", { kind: "invalid_response" });
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock?.();
    }
    return Buffer.concat(chunks).toString("utf8");
}

async function requestJson(url, init = {}, options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 12000);
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        const raw = await readLimitedBody(response, options.maxBytes || MAX_JSON_BYTES);
        if (!response.ok) {
            let body = null;
            try { body = JSON.parse(raw); } catch { body = raw.slice(0, 1000) || null; }
            const retryAfter = response.headers?.get?.("retry-after") || null;
            throw new ProviderError(`Provider returned HTTP ${response.status}`, {
                kind: "http", status: response.status, retryAfter, body
            });
        }
        let data;
        try { data = JSON.parse(raw); }
        catch (cause) {
            throw new ProviderError("Provider returned invalid JSON", {
                kind: "invalid_response", status: response.status, cause
            });
        }
        return { data, status: response.status, headers: response.headers };
    } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (controller.signal.aborted || error?.name === "AbortError") {
            throw new ProviderError("Provider request timed out", { kind: "timeout", cause: error });
        }
        throw new ProviderError("Provider network request failed", { kind: "network", cause: error });
    } finally {
        clearTimeout(timer);
    }
}

function text(value) {
    return typeof value === "string" ? value.trim() : "";
}

function nullableDate(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizedResult(fields, provider) {
    const url = text(fields.url);
    if (!url) return null;
    try {
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return null;
    } catch { return null; }
    const score = typeof fields.score === "number" && Number.isFinite(fields.score) ? fields.score : null;
    return {
        title: text(fields.title),
        url,
        snippet: text(fields.snippet),
        content: typeof fields.content === "string" && fields.content.trim() ? fields.content.trim() : null,
        published_at: nullableDate(fields.published_at),
        provider,
        score
    };
}

function searchOptions(query, options = {}) {
    const cleanQuery = typeof query === "string" ? query.trim() : "";
    if (!cleanQuery) throw Object.assign(new Error("query is required"), { statusCode: 400 });
    if (cleanQuery.length > 1000) throw Object.assign(new Error("query must be 1000 characters or fewer"), { statusCode: 400 });
    const limit = options.limit === undefined ? 8 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
        throw Object.assign(new Error("limit must be an integer from 1 to 20"), { statusCode: 400 });
    }
    const allowedFreshness = new Set(["day", "week", "month", "year"]);
    if (options.freshness != null && !allowedFreshness.has(options.freshness)) {
        throw Object.assign(new Error("freshness must be day, week, month, or year"), { statusCode: 400 });
    }
    for (const key of ["country", "language"]) {
        if (options[key] != null && (typeof options[key] !== "string" || options[key].length > 16)) {
            throw Object.assign(new Error(`${key} must be a short string`), { statusCode: 400 });
        }
    }
    return { query: cleanQuery, limit, freshness: options.freshness || null,
        country: options.country || null, language: options.language || null,
        research_mode: options.research_mode === true };
}

module.exports = { ProviderError, requestJson, normalizedResult, nullableDate, searchOptions, text };
