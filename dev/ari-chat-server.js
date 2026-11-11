"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { evaluateMathPrompt } = require("../lib/localMath");
const { WordNetDictionary } = require("../lib/wordNet");
const { respondToLocalLanguage } = require("../lib/localLanguage");
const { createAriGpuClient, AriGpuClientError, REMOTE_TIERS } = require("./ariGpuClient");
const { createAriDeveloperAccess, createAriDeveloperUsage } = require("./ariDeveloperAccess");
const { createAriWorkspaceStore } = require("./ariWorkspaceStore");
const { respondAriSelfKnowledge } = require("./ariSelfKnowledge");

const wordNet = new WordNetDictionary();

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const MODEL_HOST = "127.0.0.1";
const MODEL_PORT = 4174;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const HTML_PATH = path.join(__dirname, "ari-chat.html");
const FAVICON_PATH = path.join(__dirname, "ari-favicon.png");
const INFERENCE_SCRIPT = path.join(__dirname, "..", "training", "ari0", "serve.py");
const ROOT = path.resolve(__dirname, "..");

function sendJson(response, statusCode, payload) {
    response.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    response.end(JSON.stringify(payload));
}

function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        let settled = false;

        request.on("data", chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > maxBytes) {
                settled = true;
                reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
                request.resume();
                return;
            }
            chunks.push(chunk);
        });

        request.on("end", () => {
            if (settled) return;
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (_) {
                reject(Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 }));
            }
        });

        request.on("error", error => {
            if (!settled) reject(error);
        });
    });
}

function sendAuthJson(response, statusCode, payload, headers = {}) {
    response.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        ...headers
    });
    response.end(JSON.stringify(payload));
}

function developerUsageSettings(env = process.env) {
    const positiveInteger = (value, fallback) => {
        if (value === undefined || value === "") return fallback;
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    };
    const dailyLimit = positiveInteger(env.ARI_DAILY_MESSAGE_LIMIT, 100);
    const perMinuteLimit = positiveInteger(env.ARI_MESSAGES_PER_MINUTE, 10);
    if (!dailyLimit || !perMinuteLimit) throw new Error("ARI_DAILY_MESSAGE_LIMIT and ARI_MESSAGES_PER_MINUTE must be positive integers.");
    return { dailyLimit, perMinuteLimit };
}

function normalizeMessages(body) {
    const supplied = Array.isArray(body.messages)
        ? body.messages.slice(-8)
        : [{ role: "user", content: body.message }];

    if (!supplied.length) {
        throw Object.assign(new Error("At least one chat message is required."), { statusCode: 400 });
    }

    let totalCharacters = 0;
    const messages = supplied.map(message => {
        if (!message || !["user", "assistant"].includes(message.role)) {
            throw Object.assign(new Error("Chat history contains an invalid message role."), { statusCode: 400 });
        }
        const content = typeof message.content === "string" ? message.content : "";
        if (!content.trim() || content.length > 2000) {
            throw Object.assign(new Error("Each chat message must contain 1–2,000 characters."), { statusCode: 400 });
        }
        totalCharacters += content.length;
        return { role: message.role, content };
    });

    if (totalCharacters > 12000) {
        throw Object.assign(new Error("Recent chat history is too long."), { statusCode: 400 });
    }
    if (messages[messages.length - 1].role !== "user") {
        throw Object.assign(new Error("The latest chat message must be from the user."), { statusCode: 400 });
    }
    return messages;
}

function normalizeGpuOptions(options) {
    if (options === undefined) options = {};
    if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw Object.assign(new Error("Options must be an object."), { statusCode: 400 });
    }
    const allowed = new Set(["thinking", "max_new_tokens", "temperature", "top_p", "top_k"]);
    if (Object.keys(options).some(key => !allowed.has(key))) {
        throw Object.assign(new Error("Unsupported generation option."), { statusCode: 400 });
    }
    const normalized = {
        thinking: options.thinking === undefined ? false : options.thinking,
        max_new_tokens: options.max_new_tokens === undefined ? 512 : options.max_new_tokens
    };
    if (typeof normalized.thinking !== "boolean") {
        throw Object.assign(new Error("thinking must be true or false."), { statusCode: 400 });
    }
    if (!Number.isInteger(normalized.max_new_tokens) || normalized.max_new_tokens < 1 || normalized.max_new_tokens > 1024) {
        throw Object.assign(new Error("max_new_tokens must be an integer from 1 to 1,024."), { statusCode: 400 });
    }
    for (const [key, min, max, exclusiveMin] of [["temperature", 0, 2, false], ["top_p", 0, 1, true]]) {
        if (options[key] === undefined) continue;
        if (typeof options[key] !== "number" || !Number.isFinite(options[key]) || options[key] < min || options[key] > max || (exclusiveMin && options[key] === min)) {
            throw Object.assign(new Error(key + " is outside its supported range."), { statusCode: 400 });
        }
        normalized[key] = options[key];
    }
    if (options.top_k !== undefined) {
        if (!Number.isInteger(options.top_k) || options.top_k < 1 || options.top_k > 200) {
            throw Object.assign(new Error("top_k must be an integer from 1 to 200."), { statusCode: 400 });
        }
        normalized.top_k = options.top_k;
    }
    return normalized;
}

function normalizeImagePayload(image) {
    if (image == null) return null;
    if (!image || typeof image !== "object" || Array.isArray(image) ||
        Object.keys(image).some(key => !["mime_type", "data_base64"].includes(key))) {
        throw Object.assign(new Error("Image must contain a MIME type and base64 data."), { statusCode: 400 });
    }
    if (!ALLOWED_IMAGE_MIME.has(image.mime_type) || typeof image.data_base64 !== "string" || !image.data_base64) {
        throw Object.assign(new Error("Image must be a JPEG, PNG or WebP file with valid base64 data."), { statusCode: 400 });
    }
    if (image.data_base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) {
        throw Object.assign(new Error("Images must be 8 MiB or smaller."), { statusCode: 413 });
    }
    const bytes = Buffer.from(image.data_base64, "base64");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== image.data_base64) {
        throw Object.assign(new Error(bytes.length > MAX_IMAGE_BYTES ? "Images must be 8 MiB or smaller." : "Image data is not valid base64."), {
            statusCode: bytes.length > MAX_IMAGE_BYTES ? 413 : 400
        });
    }
    return { mime_type: image.mime_type, data_base64: image.data_base64 };
}

async function respondWithGpuModel(message, messages, options = {}) {
    const prompt = String(message || "").trim();
    const calculation = evaluateMathPrompt(prompt);
    if (calculation.matched) {
        return { reply: calculation.error ? "⚠️ " + calculation.error : calculation.display, mode: "Local arithmetic · no AI API" };
    }
    const localLanguage = options.image ? null : respondToLocalLanguage(prompt, { dictionary: options.dictionary || wordNet });
    const mode = String(localLanguage?.mode || "");
    const completedLocalTool = /^(?:WordNet (?:word search|dictionary)|Local character analysis|Local capability summary)/.test(mode);
    if (completedLocalTool) return localLanguage;
    if (!options.gpuClient) {
        throw new AriGpuClientError("Kaggle GPU inference is unavailable. Configure ARI_GPU_BASE_URL and ARI_GPU_API_KEY on the local Ari server.", {
            statusCode: 503, code: "GPU_NOT_CONFIGURED"
        });
    }
    const generated = await options.gpuClient.chat({
        tier: options.tier,
        messages,
        image: options.image || null,
        options: options.generationOptions || { thinking: false, max_new_tokens: 512 }
    });
    return {
        reply: generated.reply,
        mode: options.tier.charAt(0).toUpperCase() + options.tier.slice(1)
    };
}

function friendlyGpuError(error) {
    const status = error && error.statusCode;
    if (status === 400) return "That message or option could not be processed. Please check it and try again.";
    if (status === 413) return "That image or message is too large. Try a smaller image or shorter message.";
    if (status === 429) return "Ari is answering another request right now. Please try again shortly.";
    if (status === 502) return "Ari couldn't complete that answer. Please try again.";
    if (status === 503) return "Ari is temporarily unavailable for that model. Please check back shortly.";
    return "Ari couldn't answer just now. Please try again.";
}

function createLocalModelClient(options = {}) {
    const host = options.host || MODEL_HOST;
    const port = options.port || MODEL_PORT;
    const baseUrl = "http://" + host + ":" + port;

    async function request(pathname, payload, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(baseUrl + pathname, {
                method: payload ? "POST" : "GET",
                headers: payload ? { "Content-Type": "application/json" } : undefined,
                body: payload ? JSON.stringify(payload) : undefined,
                signal: controller.signal
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || "Local Ari-0 inference returned HTTP " + response.status + ".");
            }
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        async health() {
            try {
                const data = await request("/health", null, 1000);
                return {
                    connected: data.modelLoaded === true,
                    model: data.model || null,
                    mode: data.mode || null,
                    step: data.step ?? null,
                    parameters: data.parameters ?? null,
                    error: data.error || null
                };
            } catch (error) {
                return { connected: false, model: null, step: null, error: error.message };
            }
        },
        async generate(messages) {
            return request("/api/generate", { messages }, 120000);
        }
    };
}

function isDeterministicToolResult(result) {
    return Boolean(result && /WordNet|Local character analysis|Local capability summary/.test(result.mode || ""));
}

function respondToMessage(message, options = {}) {
    const prompt = String(message || "").trim();

    if (!prompt) {
        return {
            reply: "Send me a message to get started.",
            mode: "Local runtime"
        };
    }

    const calculation = evaluateMathPrompt(prompt);

    if (calculation.matched) {
        return {
            reply: calculation.error
                ? "⚠️ " + calculation.error
                : calculation.display,
            mode: "Local arithmetic · no AI API"
        };
    }

    const localLanguage = respondToLocalLanguage(prompt, {
        dictionary: options.dictionary || wordNet
    });

    if (localLanguage) return localLanguage;

    return {
        reply: "I’m still learning how to help with that. Try asking in another way or choose a different Ari model.",
        mode: "Local runtime · language model not connected"
    };
}

async function respondWithModel(message, messages, options = {}) {
    const prompt = String(message || "").trim();
    const calculation = evaluateMathPrompt(prompt);

    if (calculation.matched) {
        return {
            reply: calculation.error ? "⚠️ " + calculation.error : calculation.display,
            mode: "Local arithmetic · no AI API"
        };
    }

    const localLanguage = respondToLocalLanguage(prompt, {
        dictionary: options.dictionary || wordNet
    });
    if (isDeterministicToolResult(localLanguage)) return localLanguage;

    if (options.modelClient) {
        try {
            const generated = await options.modelClient.generate(messages);
            if (generated && typeof generated.reply === "string") {
                return {
                    reply: generated.reply,
                    mode: "Mini"
                };
            }
            throw new Error("Ari-0 returned an empty response.");
        } catch (error) {
            console.error("[Ari playground] Local model request failed.");
            if (!localLanguage) {
                return {
                    reply: "Ari couldn't answer right now. Please try again in a moment.",
                    mode: "Mini unavailable"
                };
            }
        }
    }

    if (localLanguage) return localLanguage;
    return {
        reply: "I'm not able to answer that right now. Please try again in a moment.",
        mode: "Mini unavailable"
    };
}

function startInferenceBridge(options = {}) {
    const python = options.python || process.env.ARI_PYTHON || "python";
    const script = options.script || INFERENCE_SCRIPT;
    const child = spawn(python, [script], {
        cwd: ROOT,
        env: {
            ...process.env,
            ARI0_HOST: MODEL_HOST,
            ARI0_PORT: String(MODEL_PORT)
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
    });

    child.stdout.on("data", data => {
        process.stdout.write(data.toString());
    });
    child.stderr.on("data", data => {
        process.stderr.write(data.toString());
    });
    child.on("error", error => {
        console.error("[Ari playground] Could not start Python inference bridge:", error.message);
    });
    child.on("exit", (code, signal) => {
        if (code !== 0 && code !== null) {
            console.error("[Ari playground] Python inference bridge exited with code " + code + ".");
        } else if (signal) {
            console.log("[Ari playground] Python inference bridge stopped (" + signal + ").");
        }
    });
    return child;
}

function createServer(options = {}) {
    const auth = options.authService || createAriDeveloperAccess({ env: options.env || process.env, port: options.port || DEFAULT_PORT });
    const env = options.env || process.env;
    const limits = developerUsageSettings(env);
    const usage = options.usageStore || createAriDeveloperUsage({
        dataDir: env.ARI_DATA_DIR || env.DATA_DIR || path.join(ROOT, "data"),
        ...limits,
        ...(options.now ? { now: options.now } : {})
    });
    const workspace = options.workspaceStore || createAriWorkspaceStore({
        dataDir: env.ARI_DATA_DIR || env.DATA_DIR || path.join(ROOT, "data"),
        ...(options.now ? { now: options.now } : {})
    });
    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, "http://" + HOST);

        if (request.method === "GET" && url.pathname === "/ari-favicon.png") {
            try {
                const favicon = fs.readFileSync(FAVICON_PATH);
                response.writeHead(200, {
                    "Content-Type": "image/png",
                    "Content-Length": favicon.length,
                    "Cache-Control": "public, max-age=86400",
                    "X-Content-Type-Options": "nosniff"
                });
                response.end(favicon);
            } catch (error) {
                console.error("[Ari playground] Could not read the Ari favicon.");
                sendJson(response, 500, { error: "The Ari site icon could not be loaded." });
            }
            return;
        }

        if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
            try {
                const html = fs.readFileSync(HTML_PATH);
                response.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                    "Referrer-Policy": "no-referrer"
                });
                response.end(html);
            } catch (error) {
                console.error("[Ari playground] Could not read chat page:", error.message);
                sendJson(response, 500, { error: "The Ari chat page could not be loaded." });
            }
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/auth/config") {
            sendAuthJson(response, 200, auth.config());
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/auth/csrf") {
            sendAuthJson(response, 200, auth.issueCsrf(request, response));
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/auth/me") {
            const session = auth.requireSession(request);
            sendAuthJson(response, 200, {
                authenticated: Boolean(session),
                user: session ? auth.publicUser(session) : null,
                configured: auth.config().configured
            });
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/workspace/chats") {
            const session = auth.requireSession(request);
            if (!session) {
                sendAuthJson(response, 401, { error: "Sign in to access your conversations." });
                return;
            }
            try {
                sendAuthJson(response, 200, { chats: workspace.getChats(session.sub) });
            } catch (error) {
                sendAuthJson(response, error.statusCode || 500, {
                    error: error.message || "Ari could not load your saved conversations."
                });
            }
            return;
        }

        if (request.method === "PUT" && url.pathname === "/api/workspace/chats") {
            try {
                const session = auth.requireSession(request);
                if (!session) {
                    sendAuthJson(response, 401, { error: "Sign in to save your conversations." });
                    return;
                }
                auth.assertOriginAndCsrf(request);
                const body = await readJsonBody(request, 4 * 1024 * 1024);
                const chats = await workspace.replaceChats(session.sub, body?.chats);
                sendAuthJson(response, 200, { saved: true, chats });
            } catch (error) {
                sendAuthJson(response, error.statusCode || 500, {
                    error: error.message || "Ari could not save your conversations."
                });
            }
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/auth/google") {
            try {
                auth.assertOriginAndCsrf(request);
                const body = await readJsonBody(request, 16 * 1024);
                const result = await auth.authenticateCredential(request, response, body);
                sendAuthJson(response, 200, result);
            } catch (error) {
                const status = Number.isInteger(error.statusCode) ? error.statusCode : 401;
                sendAuthJson(response, status, { error: error.message || "Google sign-in could not be verified." });
            }
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/auth/logout") {
            try {
                sendAuthJson(response, 200, auth.logout(request, response));
            } catch (error) {
                sendAuthJson(response, Number.isInteger(error.statusCode) ? error.statusCode : 403, {
                    error: error.message || "This request could not be verified."
                });
            }
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/health") {
            const session = auth.requireSession(request);
            if (!session) {
                sendAuthJson(response, 401, { error: "Sign in to view Ari's private status." });
                return;
            }
            const modelHealth = options.modelClient
                ? await options.modelClient.health()
                : { connected: false, model: null, step: null };
            const gpuHealth = options.gpuClient
                ? await options.gpuClient.health()
                : { configured: false, connected: false, error: "Kaggle GPU client is not configured.", models: {}, tiers: {}, gpus: [] };
            sendJson(response, 200, {
                ok: true,
                aiModelConnected: modelHealth.connected === true,
                gpu: {
                    configured: gpuHealth.configured === true,
                    connected: gpuHealth.connected === true,
                    ready: Boolean(Object.values(gpuHealth.tiers || {}).some(state => state && (state.ready === true || state.text_ready === true || state.image_ready === true)))
                }
            });
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/chat") {
            try {
                const session = auth.requireSession(request);
                if (!session) {
                    sendAuthJson(response, 401, { error: "Sign in with Google to use Ari." });
                    return;
                }
                auth.assertOriginAndCsrf(request);
                const body = await readJsonBody(request, MAX_BODY_BYTES);
                if (typeof body?.message !== "string" || !body.message.trim()) {
                    sendJson(response, 400, { error: "Message must be a non-empty string." });
                    return;
                }
                if (body.message.length > 2000) {
                    sendJson(response, 400, { error: "Message is too long (maximum 2,000 characters)." });
                    return;
                }

                const tier = body.tier === undefined ? "mini" : body.tier;
                if (tier !== "mini" && !REMOTE_TIERS.has(tier)) {
                    sendJson(response, 400, { error: "tier must be mini, medium, max, or ultra." });
                    return;
                }
                const messages = normalizeMessages(body);
                let result;
                let image = null;
                let generationOptions = null;
                if (tier === "mini") {
                    if (body.image != null) {
                        sendJson(response, 400, { error: "Image input requires Medium, Max, or Ultra." });
                        return;
                    }
                } else {
                    image = normalizeImagePayload(body.image);
                    generationOptions = normalizeGpuOptions(body.options);
                }
                const quota = await usage.consumeAcceptedMessage(session.sub);
                if (!quota.allowed) {
                    const retryAfter = quota.reason === "daily" ? quota.dayResetSeconds : quota.retryAfterSeconds;
                    sendAuthJson(response, 429, { error: "Ari's usage limit has been reached. Please try again later." }, {
                        "Retry-After": String(retryAfter)
                    });
                    return;
                }
                const selfKnowledgeReply = respondAriSelfKnowledge(body.message);
                if (selfKnowledgeReply) {
                    sendJson(response, 200, { reply: selfKnowledgeReply, mode: "Ari information" });
                    return;
                }
                if (tier === "mini") {
                    result = await respondWithModel(body.message, messages, {
                        dictionary: wordNet,
                        modelClient: options.modelClient
                    });
                } else {
                    result = await respondWithGpuModel(body.message, messages, {
                        dictionary: wordNet,
                        gpuClient: options.gpuClient,
                        tier,
                        image,
                        generationOptions
                    });
                }
                sendJson(response, 200, result);
            } catch (error) {
                if (!response.headersSent && !response.destroyed) {
                    const remoteRequest = typeof error.code === "string" && error.code.startsWith("GPU_");
                    if (remoteRequest) {
                        console.error("[Ari playground] GPU inference failed:", {
                            code: error.code || "GPU_REQUEST_FAILED",
                            statusCode: error.statusCode || 500
                        });
                    }
                    sendAuthJson(response, error.statusCode || 500, {
                        error: remoteRequest ? friendlyGpuError(error) : error.message || "Could not process the message."
                    });
                }
            }
            return;
        }

        sendJson(response, 404, { error: "Not found." });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    return server;
}

if (require.main === module) {
    const port = Number.parseInt(process.env.ARI_DEV_PORT || String(DEFAULT_PORT), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error("ARI_DEV_PORT must be a valid TCP port.");
        process.exitCode = 1;
    } else {
        const modelProcess = startInferenceBridge();
        const app = createServer({
            modelClient: createLocalModelClient(),
            gpuClient: createAriGpuClient()
        });
        app.on("close", () => {
            if (modelProcess && !modelProcess.killed) modelProcess.kill();
        });
        app.listen(port, HOST, () => {
            console.log("[Ari playground] Open http://" + HOST + ":" + port);
            console.log("[Ari playground] Local model bridge starting on http://" + MODEL_HOST + ":" + MODEL_PORT);
            console.log("[Ari playground] Maths and WordNet tools remain available.");
        });

        const shutdown = () => app.close(() => process.exit(0));
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
    }
}

module.exports = {
    createServer,
    respondToMessage,
    respondWithModel,
    normalizeMessages,
    createLocalModelClient,
    startInferenceBridge,
    isDeterministicToolResult,
    normalizeGpuOptions,
    normalizeImagePayload,
    respondWithGpuModel,
    createAriGpuClient,
    HOST,
    DEFAULT_PORT,
    MODEL_HOST,
    MODEL_PORT,
    MAX_BODY_BYTES,
    MAX_IMAGE_BYTES
};
