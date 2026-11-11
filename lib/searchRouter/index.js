"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dataPath = require("../dataPath");
const { searchOptions, ProviderError } = require("./providerUtils");
const { openWebpage } = require("./openWebpage");
const { searchTools, formatUntrustedToolOutput } = require("./tools");
const TavilyProvider = require("./providers/tavily");
const SearXNGProvider = require("./providers/searxng");
const SerperProvider = require("./providers/serper");

const USAGE_FILE = dataPath("searchRouterUsage.json");
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_COUNTER = 1_000_000_000;

function utcMonth(now = new Date()) { return now.toISOString().slice(0, 7); }
function boundedInt(value, fallback, min, max) {
    const number = Number(value);
    return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function readConfig(env = process.env) {
    const enabled = String(env.SEARCH_ENABLED || "false").trim().toLowerCase() === "true";
    const validNames = new Set(["tavily", "searxng", "serper"]);
    const requestedOrder = String(env.SEARCH_PROVIDER_ORDER || "searxng,serper,tavily")
        .split(",").map(item => item.trim().toLowerCase()).filter(name => validNames.has(name));
    return {
        enabled,
        providerOrder: [...new Set(requestedOrder)],
        strategy: String(env.SEARCH_STRATEGY || "adaptive").toLowerCase() === "adaptive" ? "adaptive" : "adaptive",
        timeoutMs: boundedInt(env.SEARCH_TIMEOUT_MS, 12000, 1000, 60000),
        defaultLimit: boundedInt(env.SEARCH_MAX_RESULTS, 8, 1, 20),
        maxFallbacks: boundedInt(env.SEARCH_MAX_FALLBACKS, 2, 0, 5),
        researchModeEnabled: String(env.SEARCH_RESEARCH_MODE || "false").toLowerCase() === "true",
        monthlySoftLimit: boundedInt(env.SEARCH_MONTHLY_SOFT_LIMIT, 900, 0, MAX_COUNTER),
        maxConcurrent: boundedInt(env.SEARCH_MAX_CONCURRENT, 4, 1, 16),
        circuitThreshold: boundedInt(env.SEARCH_CIRCUIT_FAILURES, 3, 2, 20),
        circuitCooldownMs: boundedInt(env.SEARCH_CIRCUIT_COOLDOWN_MS, 60000, 1000, DAY_MS),
        providerSoftLimits: {
            tavily: boundedInt(env.TAVILY_MONTHLY_SOFT_LIMIT, 0, 0, MAX_COUNTER),
            searxng: boundedInt(env.SEARXNG_MONTHLY_SOFT_LIMIT, 0, 0, MAX_COUNTER),
            serper: boundedInt(env.SERPER_MONTHLY_SOFT_LIMIT, 0, 0, MAX_COUNTER)
        }
    };
}

function emptyProviderState(month) {
    return { month, requests: 0, successes: 0, failures: 0, credits: 0, lastSuccessAt: null,
        lastErrorAt: null, lastLatencyMs: null, averageLatencyMs: null, rateLimitedUntil: null,
        accessErrorUntil: null, consecutiveFailures: 0, circuit: "closed", circuitOpenedAt: null,
        halfOpenInFlight: false, rateLimitEvents: 0, observations: [] };
}
function loadState(file = USAGE_FILE) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed && typeof parsed === "object" && parsed.providers) return parsed;
    } catch {}
    return { month: utcMonth(), requests: 0, successes: 0, failures: 0, credits: 0, providers: {} };
}
function persistState(state, file = USAGE_FILE) {
    const next = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(next, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(next, file);
}
function parseRetryAfter(value, now = Date.now()) {
    if (value == null) return 60000;
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - now;
    return Math.max(1000, Math.min(DAY_MS, Number.isFinite(ms) ? ms : 60000));
}

function canonicalUrl(value) {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    const tracking = /^(utm_[^=]+|gclid|dclid|fbclid|mc_cid|mc_eid|ref_src|ref_url)$/i;
    for (const key of [...url.searchParams.keys()]) if (tracking.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
}
function deduplicate(results) {
    const seen = new Set();
    return results.filter(result => {
        let key;
        try { key = canonicalUrl(result.url); } catch { return false; }
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
function rank(results, order) {
    const position = new Map(order.map((name, index) => [name, index]));
    return results.map((item, index) => ({ item, index })).sort((a, b) => {
        const providerDiff = (position.get(a.item.provider) ?? 999) - (position.get(b.item.provider) ?? 999);
        if (providerDiff) return providerDiff;
        if (a.item.score !== null && b.item.score !== null && a.item.score !== b.item.score) return b.item.score - a.item.score;
        return a.index - b.index;
    }).map(entry => entry.item);
}

class SearchRouter {
    constructor(options = {}) {
        this.env = options.env || process.env;
        this.config = readConfig(this.env);
        this.clock = options.clock || (() => Date.now());
        this.stateFile = options.stateFile || USAGE_FILE;
        this.state = options.state || loadState(this.stateFile);
        this.fetchImpl = options.fetchImpl;
        this.providers = options.providers || {
            tavily: new TavilyProvider({ env: this.env, fetchImpl: this.fetchImpl }),
            searxng: new SearXNGProvider({ env: this.env, fetchImpl: this.fetchImpl }),
            serper: new SerperProvider({ env: this.env, fetchImpl: this.fetchImpl })
        };
        this.active = 0;
        this.activeProviders = new Map();
    }

    _refreshMonth() {
        const month = utcMonth(new Date(this.clock()));
        if (this.state.month !== month) {
            this.state.month = month;
            this.state.requests = 0; this.state.successes = 0; this.state.failures = 0; this.state.credits = 0;
            for (const [name, old] of Object.entries(this.state.providers || {})) {
                this.state.providers[name] = { ...emptyProviderState(month), ...old, month,
                    requests: 0, successes: 0, failures: 0, credits: 0, rateLimitEvents: 0 };
            }
        }
        this.state.providers ||= {};
    }
    _providerState(name) {
        this._refreshMonth();
        this.state.providers[name] ||= emptyProviderState(this.state.month);
        return this.state.providers[name];
    }
    _persist() { persistState(this.state, this.stateFile); }
    _eligible(provider) {
        if (!provider?.configured) return false;
        const state = this._providerState(provider.name);
        const now = this.clock();
        if ((this.activeProviders.get(provider.name) || 0) >= 2) return false;
        if (this.config.monthlySoftLimit > 0 && this.state.requests >= this.config.monthlySoftLimit) return false;
        const providerLimit = this.config.providerSoftLimits[provider.name] || 0;
        if (providerLimit > 0 && state.requests >= providerLimit) return false;
        if (state.rateLimitedUntil && Date.parse(state.rateLimitedUntil) > now) return false;
        if (state.accessErrorUntil && Date.parse(state.accessErrorUntil) > now) return false;
        if (state.circuit === "open") {
            if (now - Date.parse(state.circuitOpenedAt || 0) < this.config.circuitCooldownMs) return false;
            state.circuit = "half_open";
        }
        if (state.circuit === "half_open" && state.halfOpenInFlight) return false;
        return true;
    }
    _quality(provider) {
        const state = this._providerState(provider.name);
        const preference = this.config.providerOrder.indexOf(provider.name);
        const preferenceWeight = 1 / (1 + Math.max(0, preference));
        const recent = Array.isArray(state.observations) ? state.observations.slice(-50) : [];
        const successes = recent.filter(item => item.ok).length;
        const reliability = (successes + 2) / (recent.length + 2);
        const recentLatency = recent.length
            ? recent.reduce((sum, item) => sum + item.latencyMs, 0) / recent.length
            : state.averageLatencyMs;
        const latency = recentLatency == null ? 1 : 1000 / (1000 + recentLatency);
        return preferenceWeight * reliability * Math.sqrt(latency);
    }
    _eligibleProviders(excluded = new Set()) {
        return this.config.providerOrder.map((name, order) => ({ provider: this.providers[name], order }))
            .filter(({ provider }) => provider && !excluded.has(provider.name) && this._eligible(provider))
            .sort((a, b) => this._quality(b.provider) - this._quality(a.provider) || a.order - b.order)
            .map(({ provider }) => provider);
    }
    _startAttempt(provider) {
        const state = this._providerState(provider.name);
        if (state.circuit === "half_open") state.halfOpenInFlight = true;
        state.requests += 1; this.state.requests += 1;
        this._persist();
    }
    _finishAttempt(provider, started, error, credits = null) {
        const state = this._providerState(provider.name);
        const latency = Math.max(0, this.clock() - started);
        state.lastLatencyMs = latency;
        state.averageLatencyMs = state.averageLatencyMs == null ? latency : state.averageLatencyMs * 0.8 + latency * 0.2;
        state.observations = Array.isArray(state.observations) ? state.observations : [];
        state.observations.push({ ok: !error, latencyMs: latency, at: new Date(this.clock()).toISOString() });
        if (state.observations.length > 50) state.observations.splice(0, state.observations.length - 50);
        state.halfOpenInFlight = false;
        if (!error) {
            state.successes += 1; state.consecutiveFailures = 0; state.lastSuccessAt = new Date(this.clock()).toISOString();
            state.circuit = "closed"; state.circuitOpenedAt = null;
            this.state.successes += 1;
            if (Number.isFinite(credits) && credits >= 0) {
                state.credits += credits; this.state.credits += credits;
            }
        } else {
            state.failures += 1; state.consecutiveFailures += 1; state.lastErrorAt = new Date(this.clock()).toISOString();
            this.state.failures += 1;
            if (error.status === 429) {
                state.rateLimitEvents += 1;
                state.rateLimitedUntil = new Date(this.clock() + parseRetryAfter(error.retryAfter, this.clock())).toISOString();
            } else if (error.status === 401 || error.status === 403) {
                state.accessErrorUntil = new Date(this.clock() + 15 * 60 * 1000).toISOString();
            }
            if (state.consecutiveFailures >= this.config.circuitThreshold || state.circuit === "half_open") {
                state.circuit = "open"; state.circuitOpenedAt = new Date(this.clock()).toISOString();
            }
        }
        this._persist();
    }

    async _call(provider, options) {
        this._startAttempt(provider);
        this.activeProviders.set(provider.name, (this.activeProviders.get(provider.name) || 0) + 1);
        const started = this.clock();
        try {
            const result = await provider.search(options, this.config);
            if (!result || !Array.isArray(result.results)) throw new ProviderError("Provider returned invalid result set", { kind: "invalid_response" });
            const normalized = result.results.map(item => {
                if (!item || typeof item !== "object" || typeof item.url !== "string" ||
                    typeof item.title !== "string" || typeof item.snippet !== "string" ||
                    !(item.content === null || typeof item.content === "string") ||
                    !(item.published_at === null || typeof item.published_at === "string") ||
                    !(item.score === null || (typeof item.score === "number" && Number.isFinite(item.score)))) {
                    throw new ProviderError("Provider returned a malformed result", { kind: "invalid_response" });
                }
                const { normalizedResult } = require("./providerUtils");
                const value = normalizedResult(item, provider.name);
                if (!value) throw new ProviderError("Provider returned an invalid result URL", { kind: "invalid_response" });
                return value;
            });
            this._finishAttempt(provider, started, null, result.credits);
            return normalized;
        } catch (error) {
            this._finishAttempt(provider, started, error);
            throw error;
        } finally {
            const remaining = (this.activeProviders.get(provider.name) || 1) - 1;
            if (remaining > 0) this.activeProviders.set(provider.name, remaining);
            else this.activeProviders.delete(provider.name);
        }
    }
    async web_search(query, options = {}) {
        if (!this.config.enabled) throw Object.assign(new Error("Web search is disabled"), { code: "SEARCH_DISABLED", statusCode: 503 });
        const normalized = searchOptions(query, { ...options, limit: options.limit ?? this.config.defaultLimit });
        if (normalized.research_mode && !this.config.researchModeEnabled) {
            throw Object.assign(new Error("Research mode is disabled by configuration"), { code: "RESEARCH_MODE_DISABLED", statusCode: 503 });
        }
        this._refreshMonth();
        if (this.active >= this.config.maxConcurrent) throw Object.assign(new Error("Search concurrency limit reached"), { code: "SEARCH_BUSY", statusCode: 503 });
        this.active += 1;
        try {
            const researchMode = normalized.research_mode && this.config.researchModeEnabled;
            const eligible = this._eligibleProviders();
            if (!eligible.length) throw Object.assign(new Error("No search provider is configured and eligible"), { code: "NO_SEARCH_PROVIDER", statusCode: 503 });
            if (researchMode) return await this._research(normalized, eligible);
            const tried = new Set();
            const aggregated = [];
            let used = null;
            for (let fallback = 0; fallback <= this.config.maxFallbacks; fallback++) {
                const provider = this._eligibleProviders(tried)[0];
                if (!provider) break;
                tried.add(provider.name);
                try { aggregated.push(...await this._call(provider, normalized)); used = provider.name; break; }
                catch (error) {
                    if ([400, 422].includes(error.statusCode || error.status)) {
                        throw Object.assign(new Error("Search provider rejected the query"), { statusCode: 400 });
                    }
                }
            }
            if (!used) throw Object.assign(new Error("All eligible search providers failed"), { code: "SEARCH_FAILED", statusCode: 502 });
            const results = rank(deduplicate(aggregated), [used]).slice(0, normalized.limit);
            return { results, providers_used: [used], research_mode: false };
        } finally { this.active -= 1; }
    }
    async _research(options, eligible) {
        const chosen = eligible.slice(0, 2);
        const settled = await Promise.allSettled(chosen.map(provider => this._call(provider, options)));
        const results = [];
        const providersUsed = [];
        const attempted = new Set(chosen.map(provider => provider.name));
        for (let i = 0; i < settled.length; i++) {
            if (settled[i].status === "fulfilled") {
                providersUsed.push(chosen[i].name);
                results.push(...settled[i].value);
            }
        }
        let fallbacks = 0;
        for (const outcome of settled) {
            if (outcome.status === "fulfilled" || providersUsed.length >= 2 || fallbacks >= this.config.maxFallbacks) continue;
            const provider = this._eligibleProviders(attempted)[0];
            if (!provider) break;
            attempted.add(provider.name);
            fallbacks += 1;
            try {
                results.push(...await this._call(provider, options));
                providersUsed.push(provider.name);
            } catch {}
        }
        if (!providersUsed.length) throw Object.assign(new Error("All eligible search providers failed"), { code: "SEARCH_FAILED", statusCode: 502 });
        return { results: rank(deduplicate(results), providersUsed).slice(0, options.limit), providers_used: providersUsed, research_mode: true };
    }
    getStatus() {
        this._refreshMonth();
        const names = [...new Set([...this.config.providerOrder, ...Object.keys(this.state.providers)])];
        return {
            enabled: this.config.enabled, strategy: this.config.strategy, month_utc: this.state.month,
            total: { requests: this.state.requests, successful_searches: this.state.successes, errors: this.state.failures, known_credits: this.state.credits },
            providers: names.map(name => {
                const provider = this.providers[name];
                const state = this._providerState(name);
                const eligible = provider ? this._eligible(provider) : false;
                return { name, configured: Boolean(provider?.configured), eligible, requests: state.requests,
                    successful_searches: state.successes, errors: state.failures, known_credits: state.credits,
                    average_latency_ms: state.averageLatencyMs == null ? null : Math.round(state.averageLatencyMs),
                    last_success_at: state.lastSuccessAt, last_error_at: state.lastErrorAt,
                    rate_limit_events: state.rateLimitEvents, circuit_breaker: state.circuit,
                    rate_limited_until: state.rateLimitedUntil, soft_limit: this.config.providerSoftLimits[name] || null };
            })
        };
    }
}

const defaultRouter = new SearchRouter();
async function defaultOpenWebpage(...args) {
    if (!defaultRouter.config.enabled) {
        throw Object.assign(new Error("Web search is disabled"), { code: "SEARCH_DISABLED", statusCode: 503 });
    }
    return openWebpage(...args);
}
module.exports = {
    SearchRouter,
    web_search: (...args) => defaultRouter.web_search(...args),
    open_webpage: (...args) => defaultOpenWebpage(...args),
    searchTools,
    formatUntrustedToolOutput,
    getStatus: () => defaultRouter.getStatus(),
    readConfig,
    canonicalUrl,
    deduplicate,
    rank
};
