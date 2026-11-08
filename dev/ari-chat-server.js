"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { evaluateMathPrompt } = require("../lib/localMath");
const { WordNetDictionary } = require("../lib/wordNet");
const { respondToLocalLanguage } = require("../lib/localLanguage");

const wordNet = new WordNetDictionary();

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const MODEL_HOST = "127.0.0.1";
const MODEL_PORT = 4174;
const MAX_BODY_BYTES = 32768;
const HTML_PATH = path.join(__dirname, "ari-chat.html");
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

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        let settled = false;

        request.on("data", chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
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
        reply: "I don't know how to answer that yet using my local tools. Try a greeting, a calculation, ask me to define a word, or request a word list. My local language model is not connected yet.",
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
                const step = Number.isInteger(generated.step) ? " · step " + generated.step : "";
                return {
                    reply: generated.reply,
                    mode: (generated.model || "Ari-0 local model") + step + " · local inference"
                };
            }
            throw new Error("Ari-0 returned an empty response.");
        } catch (error) {
            console.error("[Ari playground] Local model request failed:", error.message);
            if (!localLanguage) {
                return {
                    reply: "I couldn't get a response from Ari-0. Check that the local model bridge is running and that its checkpoint is available.",
                    mode: "Ari-0 · local inference unavailable"
                };
            }
        }
    }

    if (localLanguage) return localLanguage;
    return {
        reply: "I don't know how to answer that yet using my local tools. The Ari-0 model is not connected.",
        mode: "Local runtime · language model not connected"
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
    return http.createServer(async (request, response) => {
        const url = new URL(request.url, "http://" + HOST);

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

        if (request.method === "GET" && url.pathname === "/api/health") {
            const modelHealth = options.modelClient
                ? await options.modelClient.health()
                : { connected: false, model: null, step: null };
            sendJson(response, 200, {
                ok: true,
                mode: "local",
                aiModelConnected: modelHealth.connected === true,
                model: modelHealth.model || null,
                checkpointStep: modelHealth.step ?? null,
                wordNetAvailable: wordNet.isAvailable()
            });
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/chat") {
            try {
                const body = await readJsonBody(request);
                if (typeof body?.message !== "string" || !body.message.trim()) {
                    sendJson(response, 400, { error: "Message must be a non-empty string." });
                    return;
                }
                if (body.message.length > 2000) {
                    sendJson(response, 400, { error: "Message is too long (maximum 2,000 characters)." });
                    return;
                }

                const messages = normalizeMessages(body);
                const result = await respondWithModel(body.message, messages, {
                    dictionary: wordNet,
                    modelClient: options.modelClient
                });
                sendJson(response, 200, result);
            } catch (error) {
                if (!response.headersSent && !response.destroyed) {
                    sendJson(response, error.statusCode || 400, {
                        error: error.message || "Could not process the message."
                    });
                }
            }
            return;
        }

        sendJson(response, 404, { error: "Not found." });
    });
}

if (require.main === module) {
    const port = Number.parseInt(process.env.ARI_DEV_PORT || String(DEFAULT_PORT), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error("ARI_DEV_PORT must be a valid TCP port.");
        process.exitCode = 1;
    } else {
        const modelProcess = startInferenceBridge();
        const app = createServer({ modelClient: createLocalModelClient() });
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
    HOST,
    DEFAULT_PORT,
    MODEL_HOST,
    MODEL_PORT
};
