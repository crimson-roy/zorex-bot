"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { evaluateMathPrompt } = require("../lib/localMath");
const { WordNetDictionary } = require("../lib/wordNet");
const { respondToLocalLanguage } = require("../lib/localLanguage");

const wordNet = new WordNetDictionary();

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const MAX_BODY_BYTES = 8192;
const HTML_PATH = path.join(__dirname, "ari-chat.html");

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

        request.on("data", chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });

        request.on("end", () => {
            if (size > MAX_BODY_BYTES) return;
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (_) {
                reject(Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 }));
            }
        });

        request.on("error", reject);
    });
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
        reply: "I don't know how to answer that yet using my local tools. Try a greeting, a calculation, or ask me to define a word. My local language model is not connected yet.",
        mode: "Local runtime · language model not connected"
    };
}

function createServer() {
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
            sendJson(response, 200, {
                ok: true,
                mode: "local",
                aiModelConnected: false,
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

                sendJson(response, 200, respondToMessage(body.message));
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
        const app = createServer();
        app.listen(port, HOST, () => {
            console.log("[Ari playground] Open http://" + HOST + ":" + port);
            console.log("[Ari playground] Local arithmetic and language rules enabled; no AI API is called.");
            console.log("[Ari playground] WordNet dictionary: " + (wordNet.isAvailable() ? "available" : "not found"));
        });
    }
}

module.exports = {
    createServer,
    respondToMessage,
    HOST,
    DEFAULT_PORT
};
