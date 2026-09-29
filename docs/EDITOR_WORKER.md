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
REAL_ESRGAN_MODELS=/path/to/models
GPU_VRAM_GB=8
EDITOR_WORKER_PRIORITY=100
```

Then:

```bash
npm run editor-worker
```

## WhatsApp flow

Reply to a video with:

```
.upscale 4
```

Zorex saves the source under the persistent DATA_DIR editor folder and returns a job id.

Check:

```
.queue
.queue ZRX-ABC123
```

Cancel:

```
.queue cancel ZRX-ABC123
```

When a compatible worker is online it claims the queued job, downloads the video, runs Real-ESRGAN, rebuilds the video with its original audio, and uploads the final MP4 to the VPS.

Once complete, running `.queue ZRX-ABC123` sends the resulting video back into WhatsApp.

## Restart behavior in Phase 1

- Zorex bot restart: source + job survive.
- VPS process restart while job is marked processing: job returns to queued.
- GPU worker offline: job waits safely.
- GPU worker disappears during a render: job is eventually requeued when the VPS restarts or when the worker reports failure.

Chunk-level render checkpoints are Phase 2. They will allow a different worker to continue from completed chunks instead of redoing the current render.


## Worker priority

Higher numbers win when multiple compatible workers are online.

Suggested values:

```env
# Fast cloud GPU
EDITOR_WORKER_PRIORITY=100

# Normal dedicated GPU machine
EDITOR_WORKER_PRIORITY=80

# Slow emergency fallback PC
EDITOR_WORKER_PRIORITY=10
```

Workers poll continuously and remain in the live registry for a short TTL. A lower-priority worker will not claim a job while a higher-priority compatible worker is alive. After a VPS restart, fallback workers wait through a short startup grace window so preferred workers can reconnect first.

## Windows fallback example

Create `.env.worker` in the repository root:

```env
EDITOR_SERVER_URL=http://YOUR_VPS_HOST:3210
EDITOR_WORKER_TOKEN=the-same-secret-as-the-vps
EDITOR_WORKER_ID=daniel-pc
EDITOR_WORKER_PRIORITY=10

REAL_ESRGAN_BIN=C:\\Users\\USER\\Desktop\\Zorex Bot\\tools\\realesrgan\\realesrgan-ncnn-vulkan.exe
REAL_ESRGAN_MODELS=C:\\Users\\USER\\Desktop\\Zorex Bot\\tools\\realesrgan\\models

FFMPEG_BIN=C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe
FFPROBE_BIN=C:\\ProgramData\\chocolatey\\bin\\ffprobe.exe

GPU_VRAM_GB=1
EDITOR_POLL_MS=5000
```

The worker automatically loads this file when started with:

```powershell
npm run editor-worker
```
