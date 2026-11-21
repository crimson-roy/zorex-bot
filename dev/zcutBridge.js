"use strict";
// Z_Cut bridge: serves the editor page and lets outside AIs (ChatGPT, Claude, scripts, the zcut CLI) drive an open editor tab.
// Flow: the editor tab long-polls this server for jobs → runs them in the browser → posts the result back → the caller gets it.
// Auth: every editor tab has a secret "link key". Callers send it as  Authorization: Bearer <key>.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const MAX_JSON = 2 * 1024 * 1024;
const MAX_UPLOAD = 1024 * 1024 * 1024;               // 1 GB per file
const FILE_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 500;
const POLL_WAIT_MS = 25000;
const ONLINE_MS = 40000;
const JOB_TIMEOUT = { render: 30 * 60 * 1000, import: 10 * 60 * 1000, default: 3 * 60 * 1000 };

const JOB_KINDS = new Set(["run", "commands", "script", "state", "help", "import", "render", "snapshot"]);

function createZcutBridge(options = {}) {
    const htmlPath = options.htmlPath || path.join(__dirname, "zcut.html");
    const filesDir = options.filesDir || path.join(os.tmpdir(), "zcut-files");
    const publicBase = options.publicBase || process.env.ZCUT_PUBLIC_URL || "";
    fs.mkdirSync(filesDir, { recursive: true });
    const sessions = new Map();                      // key -> { key, created, lastSeen, queue: [], waiters: [], pending: Map(jobId -> {resolve, timer}) }
    const files = new Map();                         // fileId -> { path, name, type, session, created }

    const now = () => Date.now();
    const rid = (n = 16) => crypto.randomBytes(n).toString("hex");
    const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...cors() }); res.end(JSON.stringify(body, null, 1)); };
    const cors = () => ({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Filename", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
    const baseUrl = req => publicBase.replace(/\/$/, "") || ((req.headers["x-forwarded-proto"] || "http").split(",")[0].trim() + "://" + (req.headers["x-forwarded-host"] || req.headers.host || "localhost"));

    function readBody(req, max, asText = true) {
        return new Promise((resolve, reject) => {
            let size = 0; const chunks = [];
            req.on("data", c => { size += c.length; if (size > max) { reject(Object.assign(new Error("Body too large"), { status: 413 })); req.destroy(); return; } chunks.push(c); });
            req.on("end", () => { const b = Buffer.concat(chunks); resolve(asText ? b.toString("utf8") : b); });
            req.on("error", reject);
        });
    }
    async function readJson(req) { const t = await readBody(req, MAX_JSON); if (!t.trim()) return {}; try { return JSON.parse(t); } catch { throw Object.assign(new Error("Body must be JSON"), { status: 400 }); } }

    function keyOf(req, url) {
        const h = req.headers.authorization || ""; const m = /^Bearer\s+(\S+)/i.exec(h);
        return (m && m[1]) || req.headers["x-zcut-key"] || url.searchParams.get("key") || "";
    }
    function session(key, create = false) {
        if (!/^[a-f0-9]{32,64}$/.test(key || "")) return null;
        let s = sessions.get(key);
        if (!s && create) {
            if (sessions.size >= MAX_SESSIONS) { const oldest = [...sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0]; if (oldest) dropSession(oldest.key); }
            s = { key, created: now(), lastSeen: 0, queue: [], waiters: [], pending: new Map() }; sessions.set(key, s);
        }
        return s || null;
    }
    function dropSession(key) { const s = sessions.get(key); if (!s) return; for (const w of s.waiters) { clearTimeout(w.timer); w.done(null); } for (const p of s.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: "The editor session ended." }); } sessions.delete(key); }
    const online = s => !!s && now() - s.lastSeen < ONLINE_MS;

    // caller → job → editor
    function enqueue(s, kind, payload) {
        const job = { id: rid(8), kind, ...payload, queued: now() };
        return new Promise(resolve => {
            const timer = setTimeout(() => { s.pending.delete(job.id); s.queue = s.queue.filter(j => j.id !== job.id); resolve({ ok: false, error: "Timed out waiting for the editor. Is the Z_Cut tab open with this link key?" }); }, JOB_TIMEOUT[kind] || JOB_TIMEOUT.default);
            s.pending.set(job.id, { resolve, timer });
            const w = s.waiters.shift();
            if (w) { clearTimeout(w.timer); w.done(job); } else s.queue.push(job);
        });
    }
    function nextJob(s, waitMs) {
        s.lastSeen = now();
        if (s.queue.length) return Promise.resolve(s.queue.shift());
        return new Promise(resolve => { const w = { done: resolve, timer: setTimeout(() => { s.waiters = s.waiters.filter(x => x !== w); resolve(null); }, waitMs) }; s.waiters.push(w); });
    }

    function saveFile(s, name, buf, type) {
        const id = rid(16), safe = String(name || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file", p = path.join(filesDir, id + "-" + safe);
        fs.writeFileSync(p, buf); files.set(id, { path: p, name: safe, type: type || guessType(safe), session: s.key, created: now(), size: buf.length });
        return id;
    }
    const guessType = n => ({ mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", json: "application/json" }[(n.split(".").pop() || "").toLowerCase()] || "application/octet-stream");
    const fileUrl = (req, id) => baseUrl(req) + "/api/zcut/files/" + id + "/" + encodeURIComponent(files.get(id).name);

    function cleanup() {
        const t = now();
        for (const [id, f] of files) if (t - f.created > FILE_TTL_MS) { try { fs.unlinkSync(f.path); } catch {} files.delete(id); }
        for (const [k, s] of sessions) if (!s.pending.size && t - Math.max(s.created, s.lastSeen) > SESSION_TTL_MS) dropSession(k);
    }
    const sweeper = setInterval(cleanup, 10 * 60 * 1000); sweeper.unref && sweeper.unref();

    function serveFile(res, req, f) {
        const st = fs.statSync(f.path), range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
        const head = { "Content-Type": f.type, "Accept-Ranges": "bytes", "Content-Disposition": `inline; filename="${f.name}"`, "Cache-Control": "private, max-age=3600", ...cors() };
        if (range) { const a = range[1] ? +range[1] : 0, b = range[2] ? +range[2] : st.size - 1; res.writeHead(206, { ...head, "Content-Range": `bytes ${a}-${b}/${st.size}`, "Content-Length": b - a + 1 }); fs.createReadStream(f.path, { start: a, end: b }).pipe(res); }
        else { res.writeHead(200, { ...head, "Content-Length": st.size }); fs.createReadStream(f.path).pipe(res); }
    }

    // turn the editor's raw reply into what the caller gets (render/snapshot files become download links)
    function shapeReply(req, s, reply) {
        if (reply && reply.ok && reply.result && reply.result.__file) { const id = reply.result.__file; if (files.has(id)) { const r = { ...reply.result }; delete r.__file; r.url = fileUrl(req, id); reply = { ...reply, result: r }; } }
        return reply;
    }

    async function handle(req, res, url) {
        const p = url.pathname;
        if (!(p === "/zcut" || p === "/zcut/" || p === "/editor" || p.startsWith("/api/zcut"))) return false;
        try {
            if (req.method === "OPTIONS") { res.writeHead(204, cors()); res.end(); return true; }
            if (req.method === "GET" && (p === "/zcut" || p === "/zcut/" || p === "/editor")) {
                const html = fs.readFileSync(htmlPath);
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }); res.end(html); return true;
            }
            if (p === "/api/zcut/ping") { json(res, 200, { ok: true, service: "zcut", version: 1 }); return true; }
            if (req.method === "GET" && p === "/api/zcut/openapi.json") { json(res, 200, openapi(baseUrl(req))); return true; }
            if (req.method === "GET" && p === "/api/zcut/guide") { res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", ...cors() }); res.end(GUIDE(baseUrl(req))); return true; }
            const fm = /^\/api\/zcut\/files\/([a-f0-9]{32})(?:\/.*)?$/.exec(p);
            if (req.method === "GET" && fm) { const f = files.get(fm[1]); if (!f || !fs.existsSync(f.path)) { json(res, 404, { error: "File not found or expired" }); return true; } serveFile(res, req, f); return true; }

            // the editor tab: new key, poll for jobs, post results, upload renders
            if (req.method === "POST" && p === "/api/zcut/link") { const key = rid(16); session(key, true); json(res, 200, { key }); return true; }
            const key = keyOf(req, url), s = session(key, p === "/api/zcut/editor/next");
            if (!s) { json(res, 401, { error: "Missing or unknown link key. Open the Z_Cut editor, tap AI Link, and send the key as 'Authorization: Bearer <key>'." }); return true; }

            if (req.method === "GET" && p === "/api/zcut/editor/next") { const job = await nextJob(s, Math.min(POLL_WAIT_MS, +(url.searchParams.get("wait") || 25) * 1000)); if (res.writableEnded) return true; json(res, 200, { job }); return true; }
            if (req.method === "POST" && p === "/api/zcut/editor/done") { const b = await readJson(req), pend = s.pending.get(b.id); if (pend) { clearTimeout(pend.timer); s.pending.delete(b.id); pend.resolve({ ok: !!b.ok, result: b.result, error: b.error, log: b.log }); } s.lastSeen = now(); json(res, 200, { ok: true }); return true; }
            if (req.method === "POST" && (p === "/api/zcut/editor/file" || p === "/api/zcut/upload")) {
                const name = url.searchParams.get("name") || req.headers["x-filename"] || "upload.bin", buf = await readBody(req, MAX_UPLOAD, false);
                if (!buf.length) { json(res, 400, { error: "Empty upload" }); return true; }
                const id = saveFile(s, name, buf, req.headers["content-type"] && !/json|form|octet-stream/.test(req.headers["content-type"]) ? req.headers["content-type"] : undefined);
                if (p === "/api/zcut/editor/file") { json(res, 200, { file: id, url: fileUrl(req, id) }); return true; }
                // a caller uploaded media: hand it to the editor to import
                if (url.searchParams.get("import") === "0") { json(res, 200, { ok: true, url: fileUrl(req, id) }); return true; }
                if (!online(s)) { json(res, 409, { error: "Uploaded, but no editor is connected with this key, so it can't be imported yet.", url: fileUrl(req, id) }); return true; }
                json(res, 200, shapeReply(req, s, await enqueue(s, "import", { url: fileUrl(req, id), name: files.get(id).name, at: url.searchParams.get("at") || undefined, add: url.searchParams.get("add") !== "0" }))); return true;
            }

            // callers (AI / CLI)
            if (req.method === "GET" && p === "/api/zcut/status") { json(res, 200, { connected: online(s), lastSeenSecondsAgo: s.lastSeen ? Math.round((now() - s.lastSeen) / 1000) : null, queued: s.queue.length, running: s.pending.size }); return true; }
            const needEditor = () => { if (online(s)) return false; json(res, 409, { error: "No Z_Cut editor is connected with this key. Open the editor on the website (/zcut) and keep the tab open." }); return true; };
            if (req.method === "GET" && (p === "/api/zcut/state" || p === "/api/zcut/help")) { if (needEditor()) return true; const r = await enqueue(s, p.endsWith("state") ? "state" : "help", {}); if (p.endsWith("help") && r.ok && url.searchParams.get("format") !== "json") { res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", ...cors() }); res.end(String(r.result)); return true; } json(res, r.ok ? 200 : 422, r); return true; }
            if (req.method === "POST" && p === "/api/zcut/run") {
                const b = await readJson(req); if (needEditor()) return true;
                let r;
                if (typeof b.script === "string") r = await enqueue(s, "script", { code: b.script });
                else if (Array.isArray(b.commands)) r = await enqueue(s, "commands", { commands: b.commands });
                else if (typeof b.command === "string" || typeof b.cmd === "string") r = await enqueue(s, "run", { cmd: b.command || b.cmd, args: b.args || {} });
                else { json(res, 400, { error: "Send { command, args }, { commands: [{ command, args }, …] } or { script }" }); return true; }
                json(res, r.ok ? 200 : 422, r); return true;
            }
            if (req.method === "POST" && p === "/api/zcut/import") { const b = await readJson(req); if (!b.url) { json(res, 400, { error: "Send { url } (a direct link to a video, image or audio file). To send a file from your computer use POST /api/zcut/upload." }); return true; } if (needEditor()) return true; const r = await enqueue(s, "import", { url: String(b.url), name: b.name, at: b.at, add: b.add !== false }); json(res, r.ok ? 200 : 422, shapeReply(req, s, r)); return true; }
            if (req.method === "POST" && p === "/api/zcut/render") { const b = await readJson(req); if (needEditor()) return true; const r = await enqueue(s, "render", { comp: b.comp }); json(res, r.ok ? 200 : 422, shapeReply(req, s, r)); return true; }
            if (req.method === "POST" && p === "/api/zcut/snapshot") { const b = await readJson(req); if (needEditor()) return true; const r = await enqueue(s, "snapshot", { time: b.time }); json(res, r.ok ? 200 : 422, shapeReply(req, s, r)); return true; }
            json(res, 404, { error: "Unknown Z_Cut API route. See " + baseUrl(req) + "/api/zcut/guide" }); return true;
        } catch (err) {
            if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : "Z_Cut bridge error: " + err.message });
            return true;
        }
    }
    return { handle, sessions, files, close: () => clearInterval(sweeper) };
}

function GUIDE(base) {
    return `# Z_Cut API (for AI assistants and scripts)

Z_Cut is a browser video editor on this site (${base}/zcut). This API drives an **open editor tab**.
The user opens the editor, taps **AI Link**, and gives you a link key. Send it on every request:

    Authorization: Bearer <link key>

## Endpoints
- \`GET  /api/zcut/status\` — is the editor tab connected?
- \`GET  /api/zcut/help\` — full command guide for this project (commands, properties, effects, presets, current layers). **Read this first.**
- \`GET  /api/zcut/state\` — the project as JSON (layers with ids, media, effects, keyframes).
- \`POST /api/zcut/run\` — run one command \`{"command":"split","args":{"layer":"<id>","time":2.5}}\`, several \`{"commands":[{"command":"…","args":{}}]}\`, or a JavaScript script \`{"script":"const s = zcut.state(); …"}\`.
- \`POST /api/zcut/import\` — \`{"url":"https://…/clip.mp4"}\` imports media from a link (the server must allow it).
- \`POST /api/zcut/upload?name=clip.mp4\` — raw file body; imports it and adds it to the timeline (\`&add=0\` to only import).
- \`POST /api/zcut/snapshot\` — \`{"time":1.5}\` → a PNG link of that frame, so you can look at the edit.
- \`POST /api/zcut/render\` — exports the work area to MP4 in the browser → a download link.
- \`GET  /api/zcut/openapi.json\` — OpenAPI 3.1 spec (for ChatGPT custom GPT Actions).

## Rules
- Always use layer and media ids from \`/state\`; never guess them. Leave out \`layer\` to use the selected layer(s).
- Times: seconds (2.5), "hh:mm:ss:ff" timecode, or frames "45f".
- Errors come back as \`{"ok":false,"error":"…"}\` with a reason — read it and fix the call.
`;
}

function openapi(base) {
    const auth = [{ linkKey: [] }];
    const okResp = { "200": { description: "Result from the editor", content: { "application/json": { schema: { $ref: "#/components/schemas/Reply" } } } }, "409": { description: "No editor tab is connected with this key" }, "422": { description: "The editor reported an error (see error)" } };
    return {
        openapi: "3.1.0",
        info: { title: "Z_Cut editor API", version: "1.0.0", description: "Drive the Z_Cut browser video editor. The user opens " + base + "/zcut, taps AI Link and gives you the link key. Call getHelp first to learn the commands, effects and the current layers." },
        servers: [{ url: base }],
        components: {
            securitySchemes: { linkKey: { type: "http", scheme: "bearer", description: "The link key shown in the editor under AI Link" } },
            schemas: {
                Reply: { type: "object", properties: { ok: { type: "boolean" }, result: { description: "Command result (any JSON). For render/snapshot it holds a url." }, error: { type: "string" }, log: { type: "array", items: { type: "string" } } } },
                Step: { type: "object", required: ["command"], properties: { command: { type: "string", description: "Command name, e.g. split, addKey, addEffect, applyPreset" }, args: { type: "object", additionalProperties: true } } }
            }
        },
        security: auth,
        paths: {
            "/api/zcut/status": { get: { operationId: "getStatus", summary: "Check that the editor tab is connected", responses: { "200": { description: "Status", content: { "application/json": { schema: { type: "object", properties: { connected: { type: "boolean" } } } } } } } } },
            "/api/zcut/help": { get: { operationId: "getHelp", summary: "Full guide: commands, properties, effects, presets and the current project. Read before editing.", parameters: [{ name: "format", in: "query", schema: { type: "string", enum: ["json"] }, description: "Use json to get the guide wrapped in a Reply" }], responses: { "200": { description: "Markdown guide", content: { "text/markdown": { schema: { type: "string" } }, "application/json": { schema: { $ref: "#/components/schemas/Reply" } } } } } } },
            "/api/zcut/state": { get: { operationId: "getState", summary: "Project state as JSON: layers (ids, timing, effects, keyframes), media, comps, fps", responses: okResp } },
            "/api/zcut/run": { post: { operationId: "runCommands", summary: "Run one command, a list of commands, or a JavaScript script in the editor", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { command: { type: "string" }, args: { type: "object", additionalProperties: true }, commands: { type: "array", items: { $ref: "#/components/schemas/Step" } }, script: { type: "string", description: "JavaScript with zcut.run(), zcut.state(), log() and sleep()" } } } } } }, responses: okResp } },
            "/api/zcut/import": { post: { operationId: "importMedia", summary: "Import a video, image or audio file from a direct URL and add it to the timeline", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string" }, name: { type: "string" }, at: { description: "Timeline time to place it" }, add: { type: "boolean", default: true } } } } } }, responses: okResp } },
            "/api/zcut/snapshot": { post: { operationId: "snapshotFrame", summary: "Render one frame to a PNG and return its URL so you can see the edit", requestBody: { content: { "application/json": { schema: { type: "object", properties: { time: { description: "Seconds or timecode; default the playhead" } } } } } }, responses: okResp } },
            "/api/zcut/render": { post: { operationId: "renderVideo", summary: "Export the work area to MP4 in the browser and return a download URL (can take minutes)", requestBody: { content: { "application/json": { schema: { type: "object", properties: { comp: { type: "string" } } } } } }, responses: okResp } }
        }
    };
}

module.exports = { createZcutBridge };

// Run on its own for testing:  node dev/zcutBridge.js   → http://127.0.0.1:4180/zcut
if (require.main === module) {
    const bridge = createZcutBridge();
    const port = +(process.env.ZCUT_PORT || 4180), host = process.env.ZCUT_HOST || "127.0.0.1";
    http.createServer(async (req, res) => { const url = new URL(req.url, "http://localhost"); if (url.pathname === "/") { res.writeHead(302, { Location: "/zcut" }); res.end(); return; } if (!(await bridge.handle(req, res, url))) { res.writeHead(404); res.end("Not found"); } })
        .listen(port, host, () => console.log("[Z_Cut] Editor on http://" + host + ":" + port + "/zcut · API guide /api/zcut/guide"));
}
