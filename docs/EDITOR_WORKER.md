# Zorex Editor Worker — Phase 1

Zorex's WhatsApp process is now the control plane. Heavy AI video work is stored as persistent jobs and claimed by a separate GPU worker.

## VPS environment

Set these in the Zorex VPS .env:

```env
EDITOR_WORKER_TOKEN=replace-with-a-long-random-secret
EDITOR_WORKER_HOST=0.0.0.0
EDITOR_WORKER_PORT=3210
```

Use a firewall/reverse proxy/VPN so port 3210 is not exposed openly to the internet. Every private API endpoint also requires the bearer token.

After changing .env:

```bash
pm2 restart zorex-bot --update-env
```

Health check:

```bash
curl http://127.0.0.1:3210/health
```

## GPU machine environment

The GPU worker requires Node 20+, FFmpeg/FFprobe, and the Real-ESRGAN NCNN Vulkan executable/models.

Set:

```env
EDITOR_SERVER_URL=http://YOUR_VPS_HOST:3210
EDITOR_WORKER_TOKEN=the-same-secret
EDITOR_WORKER_ID=daniel-pc
REAL_ESRGAN_BIN=/path/to/realesrgan-ncnn-vulkan
GPU_VRAM_GB=8
```

Then:

```bash
node workers/editorWorker.js
```

## WhatsApp flow

Reply to a video with:

```
.upscale 4
```

Zorex saves the source under the persistent DATA_DIR editor folder and returns a job id.

Check:

```
.jobs
.job ZRX-ABC123
```

Cancel:

```
.canceljob ZRX-ABC123
```

When a compatible worker is online it claims the queued job, downloads the video, runs Real-ESRGAN, rebuilds the video with its original audio, and uploads the final MP4 to the VPS.

Once complete, running `.job ZRX-ABC123` sends the resulting video back into WhatsApp.

## Restart behavior in Phase 1

- Zorex bot restart: source + job survive.
- VPS process restart while job is marked processing: job returns to queued.
- GPU worker offline: job waits safely.
- GPU worker disappears during a render: job is eventually requeued when the VPS restarts or when the worker reports failure.

Chunk-level render checkpoints are Phase 2. They will allow a different worker to continue from completed chunks instead of redoing the current render.
