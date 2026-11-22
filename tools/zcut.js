#!/usr/bin/env node
"use strict";
// zcut: command line tool for the Z_Cut editor on the Ari website. Node 18+, no installs needed.
//   zcut link https://your-site.com <key>      save the website and the link key from the editor's AI Link panel
//   zcut status | help | state                  check the connection, read the command guide, read the project
//   zcut run split layer=<id> time=2.5          run one command (args as key=value or one JSON object)
//   zcut run '[{"command":"split","args":{}}]'  run a list of commands
//   zcut script edit.js                         run a JavaScript or JSON script file ("-" reads stdin)
//   zcut upload clip.mp4 [--at 3] [--no-add]    send a file from this computer into the editor
//   zcut import https://…/clip.mp4              import from a direct link
//   zcut snapshot [--time 1.5] [--out f.png]    save a picture of a frame
//   zcut render [--out edit.mp4]                export the video and download it
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const RC = path.join(os.homedir(), ".zcutrc.json");
const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const k = a.slice(2); if (k.startsWith("no-")) flags[k.slice(3)] = false; else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[k] = argv[++i]; else flags[k] = true; } else pos.push(a); }

const loadRc = () => { try { return JSON.parse(fs.readFileSync(RC, "utf8")); } catch { return {}; } };
const cfg = { ...loadRc(), ...(process.env.ZCUT_SERVER ? { server: process.env.ZCUT_SERVER } : {}), ...(process.env.ZCUT_KEY ? { key: process.env.ZCUT_KEY } : {}), ...(flags.server ? { server: flags.server } : {}), ...(flags.key ? { key: flags.key } : {}) };
const die = (msg, code = 1) => { console.error("zcut: " + msg); process.exit(code); };
const out = x => console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));

function parseValue(v) { if (v === "true") return true; if (v === "false") return false; if (v !== "" && !isNaN(+v)) return +v; if (/^[[{]/.test(v)) { try { return JSON.parse(v); } catch {} } return v; }
function parseArgs(list) { if (list.length === 1 && /^\s*[{[]/.test(list[0])) return JSON.parse(list[0]); const o = {}; for (const a of list) { const i = a.indexOf("="); if (i < 1) die(`argument "${a}" should look like key=value`); o[a.slice(0, i)] = parseValue(a.slice(i + 1)); } return o; }

async function api(method, route, body, extraHeaders = {}) {
  if (!cfg.server || !cfg.key) die("not linked yet. Open Z_Cut on the website, tap AI Link → Copy CLI setup, and paste it here (zcut link <website> <key>).");
  const headers = { Authorization: "Bearer " + cfg.key, ...extraHeaders };
  let payload = body;
  if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== "string") { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  let r; try { r = await fetch(cfg.server.replace(/\/$/, "") + route, { method, headers, body: payload }); } catch (err) { die("can't reach " + cfg.server + " (" + (err.cause && err.cause.code || err.message) + ")"); }
  const type = r.headers.get("content-type") || ""; const data = type.includes("json") ? await r.json() : await r.text();
  if (!r.ok || (data && data.ok === false)) die((data && data.error) || (typeof data === "string" ? data : "HTTP " + r.status));
  return data;
}
async function download(url, file) { const r = await fetch(url); if (!r.ok) die("download failed (" + r.status + ")"); fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); return file; }
const result = r => (r && "result" in r ? r.result : r);

(async () => {
  const cmd = pos.shift();
  switch (cmd) {
    case "link": {
      const [server, key] = pos; if (!server || !key) die("usage: zcut link <website url> <key>");
      if (!/^https?:\/\//.test(server)) die("the website must start with http:// or https://");
      fs.writeFileSync(RC, JSON.stringify({ server: server.replace(/\/$/, ""), key }, null, 2), { mode: 0o600 });
      cfg.server = server; cfg.key = key; const st = await api("GET", "/api/zcut/status");
      return out(st.connected ? "Linked ✓ The editor tab is connected." : "Saved. The editor isn't connected right now — open Z_Cut on the website and keep the tab open.");
    }
    case "status": return out(await api("GET", "/api/zcut/status"));
    case "help": return out(await api("GET", "/api/zcut/help"));
    case "guide": return out(await api("GET", "/api/zcut/guide"));
    case "state": return out(result(await api("GET", "/api/zcut/state")));
    case "run": {
      if (!pos.length) die("usage: zcut run <command> [key=value …]   or   zcut run '<json list>'");
      if (/^\s*\[/.test(pos[0])) return out(result(await api("POST", "/api/zcut/run", { commands: JSON.parse(pos[0]).map(s => ({ command: s.command || s.cmd, args: s.args || {} })) })));
      const name = pos.shift(); return out(result(await api("POST", "/api/zcut/run", { command: name, args: parseArgs(pos) })));
    }
    case "script": {
      const f = pos[0]; if (!f) die("usage: zcut script <file.js | file.json | ->");
      const code = f === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(f, "utf8");
      const r = await api("POST", "/api/zcut/run", { script: code }); if (r.log && r.log.length) console.log(r.log.join("\n")); return out(r.result ?? "done");
    }
    case "upload": {
      const f = pos[0]; if (!f || !fs.existsSync(f)) die("usage: zcut upload <file> [--at seconds] [--no-add]");
      const q = new URLSearchParams({ name: path.basename(f) }); if (flags.at !== undefined) q.set("at", flags.at); if (flags.add === false) q.set("add", "0");
      const size = fs.statSync(f).size; process.stderr.write(`Uploading ${path.basename(f)} (${(size / 1048576).toFixed(1)} MB)…\n`);
      return out(result(await api("POST", "/api/zcut/upload?" + q, new Uint8Array(fs.readFileSync(f)), { "Content-Type": "application/octet-stream" })));
    }
    case "import": { if (!pos[0]) die("usage: zcut import <url>"); return out(result(await api("POST", "/api/zcut/import", { url: pos[0], ...(flags.at !== undefined ? { at: parseValue(flags.at) } : {}), add: flags.add !== false }))); }
    case "snapshot": {
      const r = result(await api("POST", "/api/zcut/snapshot", flags.time !== undefined ? { time: parseValue(flags.time) } : {}));
      const file = flags.out || `frame-${String(r.timecode || "").replace(/:/g, "-")}.png`; await download(r.url, file); return out(`Saved ${file} (${r.timecode})`);
    }
    case "render": {
      process.stderr.write("Rendering in the editor tab… (keep it open)\n");
      const r = result(await api("POST", "/api/zcut/render", flags.comp ? { comp: flags.comp } : {}));
      const file = flags.out || r.file || "zcut.mp4"; await download(r.url, file); return out(`Saved ${file} · ${r.format}`);
    }
    case undefined: case "-h": case "--help":
      return out(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 14).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
    default: die(`unknown command "${cmd}". Run zcut --help`);
  }
})().catch(err => die(err.message));
