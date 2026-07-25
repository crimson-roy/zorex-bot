// videoHelper.js
// Converts arbitrary MP4s (landscape, square, weird aspect ratios) into a
// WhatsApp-friendly 720x1280 (9:16) vertical MP4 using FFmpeg, with
// intelligent scale+crop so footage fills the frame instead of stretching
// or letterboxing. Converted files are cached on disk and reused on
// subsequent calls for the same source file.

const fs = require('fs');
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

module.exports = { prepareVideo };
