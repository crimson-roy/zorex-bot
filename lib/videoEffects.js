"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const { spawn } = require("child_process");

const { runFFmpeg, buildVideoOutputPath, cleanupTempDir, cleanupTempFile } = require("./videoHelper");
const { generateLocalDepthMap } = require("../providers/localDepth");

function makeTempDir(label) {
    const dir = path.join(os.tmpdir(), "zorex-video-effects", `${Date.now()}-${crypto.randomBytes(5).toString("hex")}-${label}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function runFFprobe(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", c => { stdout += c.toString(); });
        proc.stderr.on("data", c => { stderr += c.toString(); });
        proc.on("error", reject);
        proc.on("close", code => code === 0
            ? resolve(stdout.trim())
            : reject(new Error(`ffprobe exited with code ${code}: ${stderr.slice(-1800)}`)));
    });
}

function parseRate(value) {
    const text = String(value || "");
    if (text.includes("/")) {
        const [a, b] = text.split("/").map(Number);
        if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) return a / b;
    }
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? n : 30;
}

async function getVideoInfo(inputPath) {
    const raw = await runFFprobe([
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=avg_frame_rate,width,height:format=duration",
        "-of", "json",
        path.resolve(inputPath)
    ]);
    const data = JSON.parse(raw);
    const stream = data.streams?.[0] || {};
    return {
        fps: parseRate(stream.avg_frame_rate),
        width: Number(stream.width) || 0,
        height: Number(stream.height) || 0,
        duration: Number(data.format?.duration) || 0
    };
}

const MIST_PRESETS = {
    none: { amount: 0, blur: 0 },
    soft: { amount: 0.38, blur: 22 },
    mist: { amount: 0.62, blur: 34 },
    heavy: { amount: 0.88, blur: 48 }
};

async function makeMistFrame(sourcePath, depthPath, outputPath, presetName) {
    const preset = MIST_PRESETS[presetName] || MIST_PRESETS.mist;
    const meta = await sharp(sourcePath).metadata();
    const width = meta.width;
    const height = meta.height;

    const alpha = await sharp(depthPath)
        .resize(width, height, { fit: "fill" })
        .grayscale()
        .normalize()
        .negate()
        .blur(preset.blur)
        .linear(preset.amount, 0)
        .png()
        .toBuffer();

    const fog = await sharp({
        create: {
            width,
            height,
            channels: 3,
            background: { r: 245, g: 247, b: 250 }
        }
    })
        .joinChannel(alpha)
        .png()
        .toBuffer();

    await sharp(sourcePath)
        .composite([{ input: fog, blend: "over" }])
        .png({ compressionLevel: 3 })
        .toFile(outputPath);
}

async function createDepthVideoEffect(inputPath, {
    mist = "none",
    quality = "max",
    progress = null
} = {}) {
    const info = await getVideoInfo(inputPath);
    const fps = Math.max(1, Math.min(info.fps || 30, 60));
    const framesDir = makeTempDir("depth-frames");
    const outputPattern = path.join(framesDir, "result-%07d.png");
    const sourcePattern = path.join(framesDir, "source-%07d.png");
    let outputPath;

    try {
        if (progress) await progress.update("🎞️ Extracting full-quality frames...");

        await runFFmpeg([
            "-y",
            "-i", path.resolve(inputPath),
            "-map", "0:v:0",
            "-vsync", "0",
            sourcePattern
        ]);

        const sourceFrames = fs.readdirSync(framesDir)
            .filter(n => /^source-\d+\.png$/i.test(n))
            .sort()
            .map(n => path.join(framesDir, n));

        if (!sourceFrames.length) throw new Error("No frames were extracted from the video.");

        const useMist = mist !== "none";
        for (let i = 0; i < sourceFrames.length; i++) {
            const source = sourceFrames[i];
            const target = path.join(framesDir, `result-${String(i + 1).padStart(7, "0")}.png`);
            let depthPath;

            try {
                depthPath = await generateLocalDepthMap(source);
                if (useMist) {
                    await makeMistFrame(source, depthPath, target, mist);
                } else {
                    const meta = await sharp(source).metadata();
                    await sharp(depthPath)
                        .resize(meta.width, meta.height, { fit: "fill" })
                        .grayscale()
                        .png({ compressionLevel: 3 })
                        .toFile(target);
                }
            } finally {
                cleanupTempFile(depthPath);
            }

            if (progress && (i === sourceFrames.length - 1 || i % 5 === 4)) {
                await progress.update(
                    useMist
                        ? `🌫️ Building depth mist... ${i + 1}/${sourceFrames.length}`
                        : `🌖 Estimating depth... ${i + 1}/${sourceFrames.length}`
                );
            }
        }

        if (progress) await progress.update("🎬 Encoding quality-first output...");

        outputPath = buildVideoOutputPath(useMist ? "depth-mist" : "depth-video");
        const preset = quality === "max" ? "veryslow" : "slow";
        const crf = quality === "max" ? "14" : "17";

        await runFFmpeg([
            "-y",
            "-framerate", String(fps),
            "-i", outputPattern,
            "-i", path.resolve(inputPath),
            "-map", "0:v:0",
            "-map", "1:a?",
            "-c:v", "libx264",
            "-preset", preset,
            "-crf", crf,
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
            outputPath
        ]);

        return { filePath: outputPath, fps, frameCount: sourceFrames.length, mist };
    } catch (err) {
        cleanupTempFile(outputPath);
        throw err;
    } finally {
        cleanupTempDir(framesDir);
    }
}

module.exports = {
    createDepthVideoEffect,
    getVideoInfo,
    MIST_PRESETS
};
