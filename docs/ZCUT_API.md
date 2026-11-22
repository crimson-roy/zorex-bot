# Z_Cut editor + AI API

Z_Cut is the browser video editor at **`/zcut`** on the Ari website. Outside AIs (ChatGPT, Claude, scripts) and the `zcut` command line tool can drive it.

## How it works
The editing happens in the browser tab. The website only relays:

```
AI / CLI  ──HTTP──▶  website /api/zcut/*  ◀──long-poll──  open Z_Cut tab (runs the job, sends the result back)
```

So **the Z_Cut tab must stay open** while an AI edits. Each tab has a secret **link key** (in **Menu → AI Link**). Callers send it as `Authorization: Bearer <key>`. **New key** in that panel cuts off everyone who had the old one.

## Files
| File | What it is |
|---|---|
| `dev/zcut.html` | The editor (single file) |
| `dev/zcutBridge.js` | Serves `/zcut` and the `/api/zcut/*` relay. Also runs on its own: `node dev/zcutBridge.js` → http://127.0.0.1:4180/zcut |
| `dev/ari-chat-server.js` | One `require` and one line hook the bridge into the site |
| `tools/zcut.js` | The CLI (Node 18+, no installs) |

## Endpoints
| Method | Path | Does |
|---|---|---|
| GET | `/api/zcut/status` | Is the editor tab connected? |
| GET | `/api/zcut/help` | Full guide for the AI: commands, properties, effects, presets, current layers (Markdown). **Read first.** |
| GET | `/api/zcut/state` | Project JSON (layer ids, timing, effects, keyframes, media) |
| POST | `/api/zcut/run` | `{"command","args"}` or `{"commands":[…]}` or `{"script":"…js…"}` |
| POST | `/api/zcut/upload?name=clip.mp4` | Raw file body → imported and added to the timeline (`&add=0` only imports, `&at=3` places it) |
| POST | `/api/zcut/import` | `{"url": "https://…/clip.mp4"}` |
| POST | `/api/zcut/snapshot` | `{"time": 1.5}` → PNG link of that frame |
| POST | `/api/zcut/render` | Exports the work area to MP4 in the tab → download link |
| GET | `/api/zcut/openapi.json` | OpenAPI 3.1 for ChatGPT custom GPT Actions |
| GET | `/api/zcut/guide` | Short public guide |

Errors return `{"ok": false, "error": "reason"}`. `409` means no editor tab is connected with that key.

## Use it with ChatGPT (custom GPT)
1. ChatGPT → **Explore GPTs → Create** → **Configure** → **Create new action**.
2. **Import from URL**: `https://YOUR-SITE/api/zcut/openapi.json`
3. **Authentication** → **API Key** → **Bearer** → paste the link key from Z_Cut's AI Link panel.
4. Instructions for the GPT: *"Call getHelp first. Use layer ids from getState. Check your work with snapshotFrame."*
5. Keep the Z_Cut tab open, then chat: *"Put a skew transition at 2s and glitch the last second."*

ChatGPT Actions need the site on public **HTTPS**.

## Use it with any AI that can run commands (Claude, Codex, etc.)
In Z_Cut, tap **AI Link → Copy prompt for ChatGPT** and paste it to the AI. It has the base URL, the key, and the steps.

## CLI
```bash
node tools/zcut.js link https://YOUR-SITE <key>     # or AI Link → Copy CLI setup
node tools/zcut.js status
node tools/zcut.js help > zcut-guide.md
node tools/zcut.js upload clip.mp4
node tools/zcut.js state
node tools/zcut.js run applyPreset preset="Skew Transition In" layer=<id>
node tools/zcut.js run '[{"command":"addEffect","args":{"effect":"glitchify"}}]'
node tools/zcut.js script edit.js
node tools/zcut.js snapshot --time 1.5 --out check.png
node tools/zcut.js render --out final.mp4
```
The key is saved in `~/.zcutrc.json`. `ZCUT_SERVER` / `ZCUT_KEY` env vars override it.

## Limits and notes
- Uploads up to 1 GB. Uploaded files and renders are kept 12 hours (in the OS temp folder), then deleted.
- Rendering uses the tab's browser (Chrome or Edge). It can take minutes for long videos.
- `import` by URL is fetched by the browser tab, so the other site must allow it (CORS). If it fails, use `upload`.
- Anyone with a link key can edit that tab's project and read its files. Share it only with AIs you use.
