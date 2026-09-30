"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function median(values) {
    if (!values.length) return 0;
    const copy = [...values].sort((a, b) => a - b);
    const mid = Math.floor(copy.length / 2);
    return copy.length % 2
        ? copy[mid]
        : (copy[mid - 1] + copy[mid]) / 2;
}

function mad(values, center = median(values)) {
    return median(values.map(v => Math.abs(v - center)));
}

function mean(values) {
    return values.length
        ? values.reduce((a, b) => a + b, 0) / values.length
        : 0;
}

function std(values) {
    if (!values.length) return 0;
    const m = mean(values);
    return Math.sqrt(mean(values.map(v => (v - m) ** 2)));
}

function rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;

    let h = 0;

    if (d !== 0) {
        if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * (((b - r) / d) + 2);
        else h = 60 * (((r - g) / d) + 4);
    }

    if (h < 0) h += 360;

    return {
        h,
        s: max === 0 ? 0 : d / max,
        v: max
    };
}

function localPeaks(values, threshold, minGapFrames = 2) {
    const peaks = [];
    let last = -Infinity;

    for (let i = 1; i < values.length - 1; i++) {
        if (
            values[i] >= threshold &&
            values[i] >= values[i - 1] &&
            values[i] >= values[i + 1] &&
            i - last >= minGapFrames
        ) {
            peaks.push(i);
            last = i;
        }
    }

    return peaks;
}

function nearestDistance(value, sorted) {
    if (!sorted.length) return Infinity;
    let best = Infinity;
    for (const candidate of sorted) {
        best = Math.min(best, Math.abs(candidate - value));
        if (candidate > value && candidate - value > best) break;
    }
    return best;
}

async function frameFeatures(file) {
    const { data, info } =
        await sharp(file)
            .resize(96, 54, { fit: "fill" })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

    const pixels = info.width * info.height;
    const gray = new Float32Array(pixels);
    const lumas = new Array(pixels);
    let saturationSum = 0;
    let hueX = 0;
    let hueY = 0;

    for (let i = 0, p = 0; i < data.length; i += 3, p++) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

        gray[p] = y;
        lumas[p] = y;

        const hsv = rgbToHsv(r, g, b);
        saturationSum += hsv.s;
        const rad = hsv.h * Math.PI / 180;
        hueX += Math.cos(rad) * hsv.s;
        hueY += Math.sin(rad) * hsv.s;
    }

    let edgeSum = 0;
    let edgeCount = 0;

    for (let y = 0; y < info.height - 1; y++) {
        for (let x = 0; x < info.width - 1; x++) {
            const i = y * info.width + x;
            edgeSum += Math.abs(gray[i] - gray[i + 1]);
            edgeSum += Math.abs(gray[i] - gray[i + info.width]);
            edgeCount += 2;
        }
    }

    const hash = new Float32Array(64);
    const blockW = info.width / 8;
    const blockH = info.height / 8;

    for (let by = 0; by < 8; by++) {
        for (let bx = 0; bx < 8; bx++) {
            let sum = 0;
            let count = 0;

            const x0 = Math.floor(bx * blockW);
            const x1 = Math.floor((bx + 1) * blockW);
            const y0 = Math.floor(by * blockH);
            const y1 = Math.floor((by + 1) * blockH);

            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    sum += gray[y * info.width + x];
                    count++;
                }
            }

            hash[by * 8 + bx] = count ? sum / count : 0;
        }
    }

    const hue =
        Math.atan2(hueY, hueX) * 180 / Math.PI;

    return {
        gray,
        hash,
        brightness: mean(lumas),
        contrast: std(lumas),
        saturation: saturationSum / pixels,
        hue: hue < 0 ? hue + 360 : hue,
        sharpness: edgeCount ? edgeSum / edgeCount : 0
    };
}

function frameDiff(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let total = 0;
    for (let i = 0; i < a.length; i++) {
        total += Math.abs(a[i] - b[i]);
    }
    return total / a.length;
}

function hashDistance(a, b) {
    let total = 0;
    for (let i = 0; i < a.length; i++) {
        total += Math.abs(a[i] - b[i]);
    }
    return total / a.length;
}

function detectReverseCandidates(frames, analysisFps) {
    const matches = [];
    const maxLookback = Math.round(analysisFps * 8);

    for (let i = 2; i < frames.length; i++) {
        let bestIndex = -1;
        let bestDistance = Infinity;
        const start = Math.max(0, i - maxLookback);

        for (let j = start; j < i - 2; j++) {
            const d = hashDistance(frames[i].hash, frames[j].hash);
            if (d < bestDistance) {
                bestDistance = d;
                bestIndex = j;
            }
        }

        matches.push({
            frame: i,
            match: bestIndex,
            distance: bestDistance
        });
    }

    const regions = [];
    let run = [];

    for (let i = 1; i < matches.length; i++) {
        const prev = matches[i - 1];
        const cur = matches[i];

        const descending =
            cur.distance < 0.055 &&
            prev.distance < 0.055 &&
            cur.match === prev.match - 1;

        if (descending) {
            if (!run.length) run.push(prev);
            run.push(cur);
        } else if (run.length) {
            if (run.length >= 3) regions.push(run);
            run = [];
        }
    }

    if (run.length >= 3) regions.push(run);

    return regions.map(region => ({
        start: region[0].frame / analysisFps,
        end: region[region.length - 1].frame / analysisFps,
        confidence: clamp(
            1 - mean(region.map(x => x.distance)) / 0.055,
            0,
            1
        )
    }));
}

function analyzeAudioPcm(buffer, sampleRate = 1000) {
    if (!buffer || buffer.length < 4) {
        return {
            beatTimes: [],
            envelope: []
        };
    }

    const samples = new Int16Array(
        buffer.buffer,
        buffer.byteOffset,
        Math.floor(buffer.byteLength / 2)
    );

    const windowSamples = Math.max(1, Math.round(sampleRate * 0.05));
    const envelope = [];

    for (let i = 0; i < samples.length; i += windowSamples) {
        let sumSq = 0;
        let count = 0;

        for (
            let j = i;
            j < Math.min(i + windowSamples, samples.length);
            j++
        ) {
            const v = samples[j] / 32768;
            sumSq += v * v;
            count++;
        }

        envelope.push(count ? Math.sqrt(sumSq / count) : 0);
    }

    const center = median(envelope);
    const spread = mad(envelope, center);
    const threshold = center + Math.max(0.015, spread * 2.5);
    const peakFrames = localPeaks(envelope, threshold, 2);

    return {
        envelope,
        beatTimes: peakFrames.map(i => i * 0.05)
    };
}

async function analyzeReference({
    inputPath,
    workDir,
    ffmpegBin,
    run,
    captureBuffer,
    sourceMetadata,
    reportProgress,
    analysisFps = 8,
    maxDuration = 60
}) {
    const framesDir = path.join(workDir, "analysis-frames");
    fs.mkdirSync(framesDir, { recursive: true });

    const duration = Math.min(
        Number(sourceMetadata.duration || maxDuration),
        maxDuration
    );

    await reportProgress(8, "extracting-analysis-frames");

    await run(
        ffmpegBin,
        [
            "-y",
            "-t",
            String(duration),
            "-i",
            inputPath,
            "-vf",
            "fps=" + analysisFps + ",scale=320:-2",
            "-vsync",
            "0",
            path.join(framesDir, "frame-%06d.png")
        ]
    );

    const files = fs.readdirSync(framesDir)
        .filter(name => /^frame-\d+\.png$/i.test(name))
        .sort()
        .map(name => path.join(framesDir, name));

    if (!files.length) {
        throw new Error("Reference analyzer extracted no frames.");
    }

    await reportProgress(22, "measuring-visual-features");

    const frames = [];
    for (let i = 0; i < files.length; i++) {
        frames.push(await frameFeatures(files[i]));

        if (i % Math.max(1, Math.round(files.length / 10)) === 0) {
            await reportProgress(
                22 + Math.round((i / files.length) * 35),
                "measuring-visual-features"
            );
        }
    }

    const diffs = [0];
    const brightnessDelta = [0];
    const sharpnessDelta = [0];

    for (let i = 1; i < frames.length; i++) {
        diffs.push(frameDiff(frames[i - 1].gray, frames[i].gray));
        brightnessDelta.push(
            Math.abs(frames[i].brightness - frames[i - 1].brightness)
        );
        sharpnessDelta.push(
            Math.abs(frames[i].sharpness - frames[i - 1].sharpness)
        );
    }

    const diffMedian = median(diffs.slice(1));
    const diffMad = mad(diffs.slice(1), diffMedian);

    const cutThreshold =
        Math.max(
            0.18,
            diffMedian + diffMad * 4.5
        );

    const motionThreshold =
        Math.max(
            0.08,
            diffMedian + diffMad * 2.2
        );

    const cutFrames = localPeaks(diffs, cutThreshold, Math.round(analysisFps * 0.15));
    const visualPeakFrames = localPeaks(diffs, motionThreshold, Math.round(analysisFps * 0.10));

    const flashThreshold =
        Math.max(
            0.12,
            median(brightnessDelta) +
            mad(brightnessDelta) * 4
        );

    const flashFrames = localPeaks(
        brightnessDelta,
        flashThreshold,
        Math.round(analysisFps * 0.10)
    );

    await reportProgress(62, "analyzing-audio");

    let audioBuffer = Buffer.alloc(0);

    try {
        audioBuffer =
            await captureBuffer(
                ffmpegBin,
                [
                    "-v",
                    "error",
                    "-t",
                    String(duration),
                    "-i",
                    inputPath,
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "1000",
                    "-f",
                    "s16le",
                    "pipe:1"
                ],
                8 * 1024 * 1024
            );
    } catch (_) {
        audioBuffer = Buffer.alloc(0);
    }

    const audio = analyzeAudioPcm(audioBuffer, 1000);

    const cutTimes = cutFrames.map(i => i / analysisFps);
    const visualPeakTimes = visualPeakFrames.map(i => i / analysisFps);
    const flashTimes = flashFrames.map(i => i / analysisFps);

    const nonCutMotionTimes =
        visualPeakTimes.filter(
            time =>
                nearestDistance(time, cutTimes) > 0.16
        );

    const alignedMotion =
        nonCutMotionTimes.filter(
            time =>
                nearestDistance(time, audio.beatTimes) <= 0.12
        );

    const reverseCandidates =
        detectReverseCandidates(
            frames,
            analysisFps
        );

    const styleFamilies = [];
    const tags = [];

    const beatSyncRatio =
        nonCutMotionTimes.length
            ? alignedMotion.length / nonCutMotionTimes.length
            : 0;

    if (
        beatSyncRatio >= 0.45 &&
        nonCutMotionTimes.length >= 3
    ) {
        styleFamilies.push("beat_synced_motion");
        tags.push("velocity", "impact");
    }

    if (
        cutTimes.length / Math.max(duration, 1) >= 0.35
    ) {
        styleFamilies.push("fast_cut_montage");
        tags.push("montage");
    }

    if (
        flashTimes.length >= 2
    ) {
        styleFamilies.push("flash_accented");
        tags.push("flash");
    }

    if (
        reverseCandidates.length
    ) {
        styleFamilies.push("reverse_motion");
        tags.push("reverse");
    }

    const meanSharpness = mean(frames.map(f => f.sharpness));
    const sharpnessVariation =
        std(frames.map(f => f.sharpness));

    const summaryParts = [];

    if (styleFamilies.length) {
        summaryParts.push(
            "Detected " +
            styleFamilies.join(", ") +
            "."
        );
    }

    summaryParts.push(
        cutTimes.length +
        " cut candidates, " +
        nonCutMotionTimes.length +
        " non-cut visual peaks, " +
        audio.beatTimes.length +
        " audio beat candidates."
    );

    if (reverseCandidates.length) {
        summaryParts.push(
            reverseCandidates.length +
            " possible reverse region(s)."
        );
    }

    await reportProgress(82, "building-style-fingerprint");

    return {
        version: 1,
        analyzer: "zorex_reference_v1",
        durationAnalyzed: duration,
        source: {
            width: Number(sourceMetadata.width || 0),
            height: Number(sourceMetadata.height || 0),
            fps: Number(sourceMetadata.fps || 0)
        },
        evidence: {
            cutTimes: cutTimes.slice(0, 200),
            visualPeakTimes: nonCutMotionTimes.slice(0, 300),
            flashTimes: flashTimes.slice(0, 200),
            beatTimes: audio.beatTimes.slice(0, 500),
            reverseCandidates: reverseCandidates.slice(0, 50)
        },
        metrics: {
            cutRatePerSecond:
                cutTimes.length / Math.max(duration, 1),
            visualPeakRatePerSecond:
                nonCutMotionTimes.length / Math.max(duration, 1),
            beatSyncRatio,
            averageBrightness:
                mean(frames.map(f => f.brightness)),
            brightnessVariation:
                std(frames.map(f => f.brightness)),
            averageContrast:
                mean(frames.map(f => f.contrast)),
            averageSaturation:
                mean(frames.map(f => f.saturation)),
            averageHue:
                mean(frames.map(f => f.hue)),
            averageSharpness:
                meanSharpness,
            sharpnessVariation,
            averageFrameDifference:
                mean(diffs.slice(1)),
            peakFrameDifference:
                Math.max(...diffs)
        },
        styleFamilies,
        tags: [...new Set(tags)],
        summary: summaryParts.join(" "),
        confidence: {
            cuts:
                clamp(
                    diffMad > 0
                        ? 0.75
                        : 0.45,
                    0,
                    1
                ),
            beatSync:
                audio.beatTimes.length
                    ? clamp(
                        0.45 +
                        beatSyncRatio * 0.5,
                        0,
                        0.95
                    )
                    : 0,
            reverse:
                reverseCandidates.length
                    ? mean(
                        reverseCandidates.map(
                            x => x.confidence
                        )
                    )
                    : 0
        },
        limitations: [
            "v1 visual peaks are frame-difference based, not optical-flow vectors",
            "zoom/pan/rotation are not yet directly estimated",
            "reverse detection is similarity-based and may confuse repeated footage",
            "effect names are inferred only when supported by measurable evidence"
        ]
    };
}

module.exports = {
    analyzeReference
};
