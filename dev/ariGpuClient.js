"use strict";

const REMOTE_TIERS = new Set(["medium", "max", "ultra"]);
const MAX_RESPONSE_BYTES = 1024 * 1024;

class AriGpuClientError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = "AriGpuClientError";
        this.statusCode = options.statusCode || 503;
        this.code = options.code || "GPU_API_UNAVAILABLE";
        this.retryable = Boolean(options.retryable);
    }
}

function normalizeBaseUrl(value, allowLocalHttp = false) {
    if (typeof value !== "string" || !value.trim()) return null;
    let url;
    try {
        url = new URL(value.trim());
    } catch {
        throw new AriGpuClientError("ARI_GPU_BASE_URL must be a valid HTTPS URL.", { code: "GPU_CONFIG_INVALID" });
    }
    const localHttp = allowLocalHttp && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
        throw new AriGpuClientError("ARI_GPU_BASE_URL must be HTTPS and must not contain credentials or query parameters.", { code: "GPU_CONFIG_INVALID" });
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
}

class AriGpuClient {
    constructor(options = {}) {
        this.env = options.env || process.env;
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        this.timeoutMs = options.timeoutMs || 180000;
        this.healthTimeoutMs = options.healthTimeoutMs || 7000;
        this.baseUrl = normalizeBaseUrl(this.env.ARI_GPU_BASE_URL || "", options.allowLocalHttp === true);
        this.apiKey = String(this.env.ARI_GPU_API_KEY || "");
        if (typeof this.fetchImpl !== "function") {
            throw new AriGpuClientError("This Node.js runtime does not provide fetch().", { code: "GPU_RUNTIME_UNSUPPORTED" });
        }
    }

    get configured() {
        return Boolean(this.baseUrl && this.apiKey);
    }

    availability() {
        if (!this.baseUrl) return { configured: false, connected: false, error: "ARI_GPU_BASE_URL is not configured." };
        if (!this.apiKey) return { configured: false, connected: false, error: "ARI_GPU_API_KEY is not configured." };
        return { configured: true, connected: false, error: null };
    }

    async _request(pathname, payload, timeoutMs) {
        if (!this.baseUrl || !this.apiKey) {
            throw new AriGpuClientError("Kaggle GPU inference is not configured. Set ARI_GPU_BASE_URL and ARI_GPU_API_KEY on the Ari Node.js server.", {
                statusCode: 503,
                code: "GPU_NOT_CONFIGURED"
            });
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            let response;
            try {
                response = await this.fetchImpl(this.baseUrl + pathname, {
                    method: payload === undefined ? "GET" : "POST",
                    headers: {
                        Authorization: "Bearer " + this.apiKey,
                        ...(payload === undefined ? {} : { "Content-Type": "application/json" })
                    },
                    body: payload === undefined ? undefined : JSON.stringify(payload),
                    signal: controller.signal
                });
            } catch (error) {
                const timedOut = error && (error.name === "AbortError" || controller.signal.aborted);
                throw new AriGpuClientError(
                    timedOut ? "The Kaggle GPU request timed out." : "The Kaggle GPU tunnel is disconnected or unreachable.",
                    { statusCode: 503, code: timedOut ? "GPU_TIMEOUT" : "GPU_DISCONNECTED", retryable: true }
                );
            }

            let text = "";
            try {
                text = await response.text();
            } catch {
                throw new AriGpuClientError("The Kaggle GPU response could not be read.", { statusCode: 502, code: "GPU_BAD_RESPONSE" });
            }
            if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
                throw new AriGpuClientError("The Kaggle GPU response exceeded the allowed size.", { statusCode: 502, code: "GPU_BAD_RESPONSE" });
            }
            let data;
            try {
                data = text ? JSON.parse(text) : {};
            } catch {
                data = {};
            }
            if (!response.ok) {
                const messages = {
                    401: "Kaggle rejected the GPU API key. Check ARI_GPU_API_KEY on both systems.",
                    413: "The image or request is too large for the Kaggle GPU API.",
                    429: "The Kaggle GPUs are handling another request. Retry shortly.",
                    500: "Kaggle GPU inference failed. Check the notebook output.",
                    503: typeof data.error === "string" ? data.error : "The requested model is unavailable in Kaggle."
                };
                const statusCode = response.status === 401 ? 503 : response.status === 413 ? 413 : response.status === 429 ? 429 : response.status === 500 ? 502 : 503;
                throw new AriGpuClientError(messages[response.status] || "Kaggle GPU API returned HTTP " + response.status + ".", {
                    statusCode,
                    code: "GPU_HTTP_" + response.status,
                    retryable: response.status === 429 || response.status >= 500
                });
            }
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    async health() {
        const configured = this.availability();
        if (!configured.configured) return { ...configured, models: {}, tiers: {}, gpus: [] };
        try {
            const data = await this._request("/health", undefined, this.healthTimeoutMs);
            if (!data || (data.status !== "ok" && data.ok !== true) ||
                typeof data.models !== "object" || typeof data.tiers !== "object") {
                return { configured: true, connected: false, error: "Kaggle returned an invalid health response.", models: {}, tiers: {}, gpus: [] };
            }
            return { configured: true, connected: true, ...data, error: null };
        } catch (error) {
            return { configured: true, connected: false, error: error.message, models: {}, tiers: {}, gpus: [] };
        }
    }

    async chat(request) {
        if (!request || !REMOTE_TIERS.has(request.tier)) {
            throw new AriGpuClientError("Select Medium, Max, or Ultra for Kaggle GPU inference.", { statusCode: 400, code: "GPU_TIER_INVALID" });
        }
        const data = await this._request("/v1/chat", request, this.timeoutMs);
        const answer = data && [data.answer, data.reply, data.text, data.content]
            .find(value => typeof value === "string" && value.trim());
        if (!data || typeof data !== "object" || Array.isArray(data) ||
            typeof answer !== "string" || (data.tier !== undefined && data.tier !== request.tier)) {
            throw new AriGpuClientError("Kaggle returned an empty or invalid model response.", { statusCode: 502, code: "GPU_BAD_RESPONSE" });
        }
        return { ...data, reply: answer };
    }
}

function createAriGpuClient(options) {
    return new AriGpuClient(options);
}

module.exports = { AriGpuClient, AriGpuClientError, createAriGpuClient, REMOTE_TIERS, normalizeBaseUrl };
