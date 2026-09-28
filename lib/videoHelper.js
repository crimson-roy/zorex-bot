// videoHelper.js
// Converts arbitrary MP4s (landscape, square, weird aspect ratios) into a
// WhatsApp-friendly 720x1280 (9:16) vertical MP4 using FFmpeg, with
// intelligent scale+crop so footage fills the frame instead of stretching
// or letterboxing. Converted files are cached on disk and reused on
// subsequent calls for the same source file.
//
// -----------------------------------------------------------------------
// ADDED: shared plumbing for the new .upscale / .fps / .bitrate commands
// -----------------------------------------------------------------------
// getQuotedVideo(), saveVideoBufferToTemp(), buildVideoOutputPath(),
// cleanupTempFile(), and reencodeVideo() below are NOT part of the
// original vertical-crop conversion feature — they're shared plumbing
// for commands/videoUpscale.js, added the same way lib/imageHelpers.js
// grew shared plumbing once more than one image command needed it.
// prepareVideo() and CACHE_DIR above are untouched; these new exports
// use their own separate TEMP_DIR since their outputs are one-off per
// command call, not meant to be content-hash-cached and reused the way
// prepareVideo()'s vertical conversions are.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache', 'videos');

const TARGET_WIDTH = 720;
const TARGET_HEIGHT = 1280;

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

// Cache key is derived from the resolved input path plus its size + mtime,
// so if the source file at that path is ever replaced with different
// content, it gets reconverted instead of silently reusing a stale cache.
function cacheKeyFor(inputPath) {
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);
  const fingerprint = `${resolved}:${stat.size}:${stat.mtimeMs}`;
  return crypto.createHash('sha1').update(fingerprint).digest('hex');
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    proc.on('error', err => {
      // e.g. ffmpeg not found in PATH
      reject(err);
    });

    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
}

/**
 * Converts inputPath to a 720x1280 vertical MP4, cached in
 * data/cache/videos/. Reuses the cached file if it already exists for this
 * exact source (same path, size, and modified time).
 *
 * @param {string} inputPath - path to the source MP4
 * @returns {Promise<string>} absolute path to the converted, ready-to-send MP4
 */
async function prepareVideo(inputPath) {
  ensureCacheDir();

  const resolvedInput = path.resolve(inputPath);
  if (!fs.existsSync(resolvedInput)) {
    throw new Error(`prepareVideo: input file not found: ${resolvedInput}`);
  }

  const key = cacheKeyFor(resolvedInput);
  const outputPath = path.join(CACHE_DIR, `${key}.mp4`);

  if (fs.existsSync(outputPath)) {
    return outputPath;
  }

  // scale up (or down) so the shorter dimension fills the target frame
  // without distortion, then crop the overflow off the center — this is
  // what turns a landscape source into a proper portrait clip instead of
  // squishing it or leaving black bars.
  const scaleCropFilter =
    `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase,` +
    `crop=${TARGET_WIDTH}:${TARGET_HEIGHT}`;

  const tmpOutputPath = `${outputPath}.tmp.mp4`;

  const args = [
    '-y',
    '-i', resolvedInput,
    '-vf', scaleCropFilter,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-loglevel', 'error',
    tmpOutputPath,
  ];

  try {
    await runFFmpeg(args);
    fs.renameSync(tmpOutputPath, outputPath); // atomic-ish: avoids a half-written file being "reused" by a concurrent call
    return outputPath;
  } catch (err) {
    // clean up any partial output so a failed run never gets mistaken for a valid cache hit
    if (fs.existsSync(tmpOutputPath)) {
      try { fs.unlinkSync(tmpOutputPath); } catch (_) {}
    }
    throw err;
  }
}

// -----------------------------------------------------------------------
// ADDED below this line — see header comment.
// -----------------------------------------------------------------------

const TEMP_DIR = path.join(os.tmpdir(), 'zorex-video-commands');

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

const VIDEO_EXT_BY_MIME = {
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'video/quicktime': '.mov',
};

/**
 * Removes a temp file if it exists, swallowing any error — cleanup
 * should never mask the real result of a command. Same contract as
 * lib/imageHelpers.js's cleanupTempFile.
 *
 * @param {string|undefined} filePath
 * @returns {void}
 */
function cleanupTempFile(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {
    /* best-effort cleanup; ignore errors */
  });
}

function createVideoTempDir(label = 'frames') {
  ensureTempDir();

  const dirPath = path.join(
    TEMP_DIR,
    `${crypto.randomBytes(6).toString('hex')}-${label}`
  );

  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function cleanupTempDir(dirPath) {
  if (!dirPath) return;

  try {
    fs.rmSync(dirPath, {
      recursive: true,
      force: true,
    });
  } catch (_) {}
}

function runFFprobe(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    proc.on('error', reject);

    proc.on('close', code => {
      if (code === 0) {
        return resolve(stdout.trim());
      }

      reject(
        new Error(
          `ffprobe exited with code ${code}: ${stderr.slice(-1800)}`
        )
      );
    });
  });
}

async function getVideoDuration(inputPath) {
  const output = await runFFprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path.resolve(inputPath),
  ]);

  const duration = Number(output);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Could not determine video duration.');
  }

  return duration;
}

async function extractVideoFrames(
  inputPath,
  {
    fps = 3,
    maxDuration = 5,
    maxWidth = 480,
  } = {}
) {
  const framesDir = createVideoTempDir('depth-frames');
  const pattern = path.join(framesDir, 'frame-%05d.png');

  const sourceDuration = await getVideoDuration(inputPath);
  const duration = Math.min(sourceDuration, maxDuration);

  const scaleFilter =
    `fps=${fps},scale=min(iw\\,${maxWidth}):-2`;

  await runFFmpeg([
    '-y',
    '-t', String(duration),
    '-i', path.resolve(inputPath),
    '-vf', scaleFilter,
    '-vsync', '0',
    pattern,
  ]);

  const framePaths = fs.readdirSync(framesDir)
    .filter(name => /^frame-\d+\.png$/i.test(name))
    .sort()
    .map(name => path.join(framesDir, name));

  if (!framePaths.length) {
    cleanupTempDir(framesDir);
    throw new Error('No video frames were extracted.');
  }

  return {
    framesDir,
    framePaths,
    fps,
    duration,
    sourceDuration,
  };
}

async function buildVideoFromFrames(
  framesDir,
  sourceVideoPath,
  {
    inputFps = 3,
    outputFps = 12,
    duration = 5,
    pattern = 'depth-%05d.png',
  } = {}
) {
  const outputPath = buildVideoOutputPath('depth-video');
  const inputPattern = path.join(framesDir, pattern);

  const args = [
    '-y',
    '-framerate', String(inputFps),
    '-i', inputPattern,
    '-i', path.resolve(sourceVideoPath),
    '-map', '0:v:0',
    '-map', '1:a?',
    '-vf', `minterpolate=fps=${outputFps}:mi_mode=blend`,
    '-t', String(duration),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest',
    '-movflags', '+faststart',
    outputPath,
  ];

  try {
    await runFFmpeg(args);
    return outputPath;
  } catch (err) {
    cleanupTempFile(outputPath);
    throw err;
  }
}

/**
 * Pulls the quoted message's video out of a reply. Returns null if the
 * reply isn't to a video, or isn't a reply at all. Mirrors
 * lib/imageHelpers.js's getQuotedImage(), but for videoMessage instead
 * of imageMessage.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @returns {Promise<{ buffer: Buffer, mimeType: string }|null>}
 */
async function getQuotedVideo(sock, msg) {

  const context = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = context?.quotedMessage;

  if (!quoted || !quoted.videoMessage) return null;

  const fakeMsg = {
    key: {
      remoteJid: msg.key.remoteJid,
      id: context.stanzaId,
      participant: context.participant,
      fromMe: false,
    },
    message: quoted,
  };

  // Lazy dynamic import — Baileys is ESM-only. Same reasoning as
  // lib/imageHelpers.js's getQuotedImage(): this must stay inside the
  // async function that needs it, never a top-level require() or a
  // top-level await.
  const { downloadMediaMessage } = await import('@whiskeysockets/baileys');

  const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {});
  const mimeType = quoted.videoMessage.mimetype || 'video/mp4';

  return { buffer, mimeType };

}

/**
 * Writes a downloaded video buffer to a temp file with an extension
 * matching its real mimetype, returning the local path.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {string} absolute local file path
 */
function saveVideoBufferToTemp(buffer, mimeType) {
  ensureTempDir();
  const ext = VIDEO_EXT_BY_MIME[mimeType] || '.mp4';
  const filePath = path.join(TEMP_DIR, `${crypto.randomBytes(6).toString('hex')}-in${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Builds a fresh output path in the shared temp dir for a command to
 * write its result to.
 *
 * @param {string} [suffix] - short label for debugging, e.g. "reencoded"
 * @returns {string} absolute local file path ending in .mp4
 */
function buildVideoOutputPath(suffix = 'out') {
  ensureTempDir();
  return path.join(TEMP_DIR, `${crypto.randomBytes(6).toString('hex')}-${suffix}.mp4`);
}

/**
 * Re-encodes an existing video file with an optionally-changed frame
 * rate and/or bitrate. Either option can be omitted to leave that
 * property as the source has it — this is NOT the same pipeline as
 * prepareVideo() above: it does not force a 720x1280 vertical
 * crop/scale, it only touches fps/bitrate.
 *
 * When bitrateKbps is given, -crf is dropped in favor of an explicit
 * -b:v (they're two different rate-control modes and don't mix
 * meaningfully on libx264) — a maxrate/bufsize pair is added for
 * encoder stability, standard ffmpeg practice for target-bitrate mode.
 * When only fps is given, -crf 18 is used instead (quality-targeted,
 * higher quality than prepareVideo()'s crf 23 since this sits behind
 * an explicit "enhance" command, not the default send pipeline).
 *
 * @param {string} inputPath
 * @param {{ fps?: number, bitrateKbps?: number }} options
 * @returns {Promise<string>} absolute path to the re-encoded .mp4
 */
async function reencodeVideo(inputPath, { fps, bitrateKbps } = {}) {

  if (!fps && !bitrateKbps) {
    throw new Error('reencodeVideo: at least one of fps or bitrateKbps must be given');
  }

  const outputPath = buildVideoOutputPath('reencoded');

  const args = ['-y', '-i', path.resolve(inputPath)];

  if (fps) {
    args.push('-r', String(fps));
  }

  args.push('-c:v', 'libx264', '-preset', 'medium');

  if (bitrateKbps) {
    const maxrate = Math.round(bitrateKbps * 1.5);
    const bufsize = bitrateKbps * 2;
    args.push(
      '-b:v', `${bitrateKbps}k`,
      '-maxrate', `${maxrate}k`,
      '-bufsize', `${bufsize}k`,
    );
  } else {
    args.push('-crf', '18');
  }

  args.push(
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-loglevel', 'error',
    outputPath,
  );

  try {
    await runFFmpeg(args);
    return outputPath;
  } catch (err) {
    if (fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch (_) {}
    }
    throw err;
  }

}

module.exports = {
  prepareVideo,
  getQuotedVideo,
  saveVideoBufferToTemp,
  buildVideoOutputPath,
  cleanupTempFile,
  createVideoTempDir,
  cleanupTempDir,
  getVideoDuration,
  extractVideoFrames,
  buildVideoFromFrames,
  runFFmpeg,
  reencodeVideo,
};