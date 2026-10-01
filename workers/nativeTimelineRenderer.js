"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function cubicBezierCoord(t, p1, p2) {
    const u = 1 - t;

    return (
        3 * u * u * t * p1 +
        3 * u * t * t * p2 +
        t * t * t
    );
}

function cubicBezierEase(t, curve) {
    const points =
        Array.isArray(curve) &&
        curve.length === 4
            ? curve.map(Number)
            : [0.25, 0.1, 0.25, 1];

    const [
        x1,
        y1,
        x2,
        y2
    ] = points;

    let lo = 0;
    let hi = 1;
    let s = clamp(t, 0, 1);

    for (let i = 0; i < 18; i++) {
        s = (lo + hi) / 2;

        const x =
            cubicBezierCoord(
                s,
                x1,
                x2
            );

        if (x < t) {
            lo = s;
        } else {
            hi = s;
        }
    }

    return cubicBezierCoord(
        s,
        y1,
        y2
    );
}

function ease(t, mode, curve) {
    const x = clamp(t, 0, 1);

    switch (mode) {
        case "hold":
            return 0;
        case "ease_in":
            return x * x * x;
        case "ease_out":
            return 1 - Math.pow(1 - x, 3);
        case "ease":
        case "ease_in_out":
            return x < 0.5
                ? 4 * x * x * x
                : 1 - Math.pow(-2 * x + 2, 3) / 2;
        case "bezier":
            return cubicBezierEase(
                x,
                curve
            );
        default:
            return x;
    }
}

function evaluate(frames, time, fallback) {
    if (!Array.isArray(frames) || !frames.length) {
        return fallback;
    }

    if (time <= frames[0].time) {
        return num(frames[0].value, fallback);
    }

    const last = frames[frames.length - 1];

    if (time >= last.time) {
        return num(last.value, fallback);
    }

    for (let i = 0; i < frames.length - 1; i++) {
        const a = frames[i];
        const b = frames[i + 1];

        if (time < a.time || time > b.time) {
            continue;
        }

        if (a.easing === "hold") {
            return num(a.value, fallback);
        }

        const span = Math.max(0.000001, b.time - a.time);
        const t = ease(
            (time - a.time) / span,
            a.easing || "linear",
            a.curve
        );

        return lerp(
            num(a.value, fallback),
            num(b.value, fallback),
            t
        );
    }

    return fallback;
}

function transformAt(transform, time) {
    const k = transform?.keyframes || {};

    return {
        x: evaluate(k.x, time, num(transform?.x, 0)),
        y: evaluate(k.y, time, num(transform?.y, 0)),
        scaleX: evaluate(k.scaleX, time, num(transform?.scaleX, 1)),
        scaleY: evaluate(k.scaleY, time, num(transform?.scaleY, 1)),
        rotation: evaluate(k.rotation, time, num(transform?.rotation, 0)),
        opacity: clamp(
            evaluate(k.opacity, time, num(transform?.opacity, 1)),
            0,
            1
        )
    };
}

function sourceTimeAt(clip, localTime) {
    const trimStart = num(clip.trimStart, 0);

    if (
        clip.timeRemap?.enabled &&
        Array.isArray(clip.timeRemap.keyframes) &&
        clip.timeRemap.keyframes.length
    ) {
        return evaluate(
            clip.timeRemap.keyframes,
            localTime,
            trimStart + localTime
        );
    }

    let adjusted = localTime;

    for (const freeze of clip.freezes || []) {
        const at = num(freeze.at, 0);
        const duration = num(freeze.duration, 0);

        if (localTime >= at && localTime < at + duration) {
            return trimStart + at;
        }

        if (localTime >= at + duration) {
            adjusted -= duration;
        }
    }

    return Math.max(trimStart, trimStart + adjusted);
}

function activeClips(timeline, time) {
    const result = [];

    for (const track of timeline.tracks || []) {
        if (!track.enabled || track.type !== "video") continue;

        for (const clip of track.clips || []) {
            if (!clip.enabled) continue;

            if (
                time >= clip.start &&
                time < clip.start + clip.duration
            ) {
                result.push({
                    clip,
                    localTime: time - clip.start
                });
            }
        }
    }

    return result;
}

function effectValue(effect, key, time, fallback) {
    return evaluate(
        effect?.keyframes?.[key],
        time,
        num(effect?.params?.[key], fallback)
    );
}

function motionKernel(amount, direction) {
    const raw = clamp(Math.round(3 + amount * 26), 3, 31);
    const size = raw % 2 === 0 ? raw + 1 : raw;
    const kernel = Array(size).fill(1 / size);

    if (String(direction || "").toLowerCase() === "vertical") {
        return {
            width: 1,
            height: size,
            kernel
        };
    }

    return {
        width: size,
        height: 1,
        kernel
    };
}

async function applyNativeEffects(buffer, effects, time, width, height) {
    let current = buffer;

    for (const effect of effects || []) {
        if (effect.enabled === false || num(effect.mix, 1) <= 0) continue;

        const image = sharp(current);

        switch (effect.type) {
            case "brightness": {
                const amount = Math.max(0.01, effectValue(effect, "amount", time, 1));
                current = await image.modulate({ brightness: amount }).toBuffer();
                break;
            }

            case "contrast": {
                const amount = effectValue(effect, "amount", time, 1);
                current = await image
                    .linear(amount, 128 * (1 - amount))
                    .toBuffer();
                break;
            }

            case "saturation": {
                const amount = Math.max(0, effectValue(effect, "amount", time, 1));
                current = await image.modulate({ saturation: amount }).toBuffer();
                break;
            }

            case "hue": {
                const amount = effectValue(effect, "amount", time, 0);
                current = await image.modulate({ hue: amount }).toBuffer();
                break;
            }

            case "blur": {
                const sigma = clamp(effectValue(effect, "sigma", time, 2), 0.3, 100);
                current = await image.blur(sigma).toBuffer();
                break;
            }

            case "denoise": {
                let size = clamp(
                    Math.round(effectValue(effect, "size", time, 3)),
                    1,
                    9
                );

                if (size % 2 === 0) size += 1;

                current = await image.median(size).toBuffer();
                break;
            }

            case "sharpen": {
                const sigma = clamp(effectValue(effect, "sigma", time, 1), 0.3, 10);
                current = await image.sharpen(sigma).toBuffer();
                break;
            }

            case "motion_blur": {
                const amount = clamp(
                    effectValue(effect, "amount", time, 0.25),
                    0,
                    1
                );

                current = await image
                    .convolve(
                        motionKernel(
                            amount,
                            effect.params?.direction
                        )
                    )
                    .toBuffer();
                break;
            }

            case "glow": {
                const radius = clamp(
                    effectValue(effect, "radius", time, 4),
                    0.3,
                    30
                );

                const glow = await image
                    .clone()
                    .blur(radius)
                    .toBuffer();

                current = await sharp(current)
                    .composite([
                        {
                            input: glow,
                            blend: "screen"
                        }
                    ])
                    .toBuffer();
                break;
            }

            case "vignette": {
                const amount = clamp(
                    effectValue(effect, "amount", time, 0.2),
                    0,
                    0.95
                );

                const svg = Buffer.from(
                    "<svg width=\"" + width + "\" height=\"" + height + "\" xmlns=\"http://www.w3.org/2000/svg\">" +
                    "<defs><radialGradient id=\"v\"><stop offset=\"45%\" stop-color=\"white\" stop-opacity=\"0\"/>" +
                    "<stop offset=\"100%\" stop-color=\"black\" stop-opacity=\"" + amount + "\"/></radialGradient></defs>" +
                    "<rect width=\"100%\" height=\"100%\" fill=\"url(#v)\"/></svg>"
                );

                current = await image
                    .composite([
                        {
                            input: svg,
                            blend: "multiply"
                        }
                    ])
                    .toBuffer();
                break;
            }

            default:
                break;
        }
    }

    return current;
}

function coord(value, size) {
    const n = num(value, 0);
    return Math.abs(n) <= 1
        ? n * size
        : n;
}

function buildMaskSvg(mask, width, height) {
    const opacity =
        clamp(
            num(mask.opacity, 1),
            0,
            1
        );

    const white =
        "rgba(255,255,255," +
        opacity +
        ")";

    let shape =
        "";

    if (mask.type === "rectangle") {
        shape =
            "<rect x=\"" +
            coord(mask.x, width) +
            "\" y=\"" +
            coord(mask.y, height) +
            "\" width=\"" +
            Math.abs(coord(mask.width, width)) +
            "\" height=\"" +
            Math.abs(coord(mask.height, height)) +
            "\" fill=\"" +
            white +
            "\"/>";
    } else if (mask.type === "ellipse") {
        shape =
            "<ellipse cx=\"" +
            coord(mask.cx, width) +
            "\" cy=\"" +
            coord(mask.cy, height) +
            "\" rx=\"" +
            Math.abs(coord(mask.rx, width)) +
            "\" ry=\"" +
            Math.abs(coord(mask.ry, height)) +
            "\" fill=\"" +
            white +
            "\"/>";
    } else if (mask.type === "polygon") {
        const points =
            (mask.points || [])
                .map(
                    point =>
                        coord(point.x, width) +
                        "," +
                        coord(point.y, height)
                )
                .join(" ");

        shape =
            "<polygon points=\"" +
            points +
            "\" fill=\"" +
            white +
            "\"/>";
    } else {
        return null;
    }

    return Buffer.from(
        "<svg width=\"" +
        width +
        "\" height=\"" +
        height +
        "\" xmlns=\"http://www.w3.org/2000/svg\">" +
        shape +
        "</svg>"
    );
}

async function applyMasks(
    buffer,
    masks,
    width,
    height
) {
    let current =
        buffer;

    for (const mask of masks || []) {
        if (mask.type === "subject") {
            continue;
        }

        const svg =
            buildMaskSvg(
                mask,
                width,
                height
            );

        if (!svg) {
            continue;
        }

        let maskBuffer =
            svg;

        if (num(mask.feather, 0) > 0) {
            maskBuffer =
                await sharp(svg)
                    .blur(
                        clamp(
                            num(mask.feather, 0),
                            0.3,
                            100
                        )
                    )
                    .png()
                    .toBuffer();
        }

        const subtract =
            mask.mode === "subtract" ||
            mask.invert === true;

        current =
            await sharp(current)
                .ensureAlpha()
                .composite([
                    {
                        input:
                            maskBuffer,
                        blend:
                            subtract
                                ? "dest-out"
                                : "dest-in"
                    }
                ])
                .png()
                .toBuffer();
    }

    return current;
}

async function applyOpacity(
    buffer,
    opacity
) {
    const value =
        clamp(
            num(opacity, 1),
            0,
            1
        );

    if (value >= 0.999) {
        return buffer;
    }

    const meta =
        await sharp(buffer)
            .metadata();

    const svg =
        Buffer.from(
            "<svg width=\"" +
            meta.width +
            "\" height=\"" +
            meta.height +
            "\" xmlns=\"http://www.w3.org/2000/svg\">" +
            "<rect width=\"100%\" height=\"100%\" fill=\"rgba(255,255,255," +
            value +
            ")\"/></svg>"
        );

    return await sharp(buffer)
        .ensureAlpha()
        .composite([
            {
                input:
                    svg,
                blend:
                    "dest-in"
            }
        ])
        .png()
        .toBuffer();
}

async function renderLayer({
    sourceFrame,
    clip,
    localTime,
    width,
    height
}) {
    let buffer = await sharp(sourceFrame)
        .resize(width, height, {
            fit: "cover",
            position: "centre"
        })
        .png()
        .toBuffer();

    buffer = await applyNativeEffects(
        buffer,
        clip.effects,
        localTime,
        width,
        height
    );

    buffer = await applyMasks(
        buffer,
        clip.masks,
        width,
        height
    );

    const t = transformAt(clip.transform, localTime);

    const scaledWidth = Math.max(
        2,
        Math.round(width * Math.max(0.01, t.scaleX))
    );

    const scaledHeight = Math.max(
        2,
        Math.round(height * Math.max(0.01, t.scaleY))
    );

    buffer = await sharp(buffer)
        .resize(scaledWidth, scaledHeight, {
            fit: "fill"
        })
        .rotate(t.rotation, {
            background: {
                r: 0,
                g: 0,
                b: 0,
                alpha: 0
            }
        })
        .png()
        .toBuffer();

    buffer =
        await applyOpacity(
            buffer,
            t.opacity
        );

    const meta =
        await sharp(buffer)
            .metadata();

    const rawLeft =
        Math.round(
            (width - meta.width) /
                2 +
            t.x
        );

    const rawTop =
        Math.round(
            (height - meta.height) /
                2 +
            t.y
        );

    // sharp.composite() rejects overlays that are larger than the base
    // image. Zooms/rotations can legitimately make a transformed layer
    // exceed the timeline canvas, so clip the layer to the visible canvas
    // rectangle before compositing it.
    const cropLeft =
        Math.max(
            0,
            -rawLeft
        );

    const cropTop =
        Math.max(
            0,
            -rawTop
        );

    const visibleWidth =
        Math.min(
            meta.width -
                cropLeft,
            width -
                Math.max(
                    0,
                    rawLeft
                )
        );

    const visibleHeight =
        Math.min(
            meta.height -
                cropTop,
            height -
                Math.max(
                    0,
                    rawTop
                )
        );

    if (
        visibleWidth <=
            0 ||
        visibleHeight <=
            0
    ) {
        return null;
    }

    if (
        cropLeft >
            0 ||
        cropTop >
            0 ||
        visibleWidth <
            meta.width ||
        visibleHeight <
            meta.height
    ) {
        buffer =
            await sharp(
                buffer
            )
                .extract({
                    left:
                        cropLeft,
                    top:
                        cropTop,
                    width:
                        visibleWidth,
                    height:
                        visibleHeight
                })
                .png()
                .toBuffer();
    }

    return {
        input:
            buffer,
        left:
            Math.max(
                0,
                rawLeft
            ),
        top:
            Math.max(
                0,
                rawTop
            ),
        blend:
            "over"
    };
}

function timelineHasTimeWarp(timeline) {
    return (timeline.tracks || []).some(track =>
        (track.clips || []).some(clip =>
            Boolean(clip.timeRemap?.enabled) ||
            (clip.freezes || []).length > 0
        )
    );
}

async function renderNativeTimeline({
    timeline,
    inputPath,
    outputPath,
    workDir,
    sourceMetadata,
    ffmpegBin,
    run,
    reportProgress
}) {
    const sourceFramesDir = path.join(workDir, "timeline-source");
    const renderedDir = path.join(workDir, "timeline-rendered");

    fs.mkdirSync(sourceFramesDir, { recursive: true });
    fs.mkdirSync(renderedDir, { recursive: true });

    await reportProgress(8, "extracting-source-frames");

    await run(
        ffmpegBin,
        [
            "-y",
            "-i",
            inputPath,
            "-vsync",
            "0",
            path.join(sourceFramesDir, "frame-%08d.png")
        ]
    );

    const sourceFrames = fs
        .readdirSync(sourceFramesDir)
        .filter(name => /^frame-\d+\.png$/i.test(name))
        .sort()
        .map(name => path.join(sourceFramesDir, name));

    if (!sourceFrames.length) {
        throw new Error("Timeline renderer extracted no source frames.");
    }

    const sourceFps = Math.max(1, num(sourceMetadata?.fps, 30));
    const outputFps = Math.max(1, num(timeline.fps, sourceFps));
    const totalFrames = Math.max(
        1,
        Math.round(timeline.duration * outputFps)
    );

    await reportProgress(18, "rendering-native-timeline");

    for (let i = 0; i < totalFrames; i++) {
        const time = i / outputFps;
        const layers = [];

        for (const active of activeClips(timeline, time)) {
            const sourceTime = sourceTimeAt(
                active.clip,
                active.localTime
            );

            const sourceIndex = clamp(
                Math.round(sourceTime * sourceFps),
                0,
                sourceFrames.length - 1
            );

            const layer =
                await renderLayer({
                    sourceFrame:
                        sourceFrames[
                            sourceIndex
                        ],
                    clip:
                        active.clip,
                    localTime:
                        active.localTime,
                    width:
                        timeline.width,
                    height:
                        timeline.height
                });

            if (layer) {
                layers.push(
                    layer
                );
            }
        }

        let image = sharp({
            create: {
                width: timeline.width,
                height: timeline.height,
                channels: 4,
                background: timeline.background || "#000000"
            }
        });

        if (layers.length) {
            image = image.composite(layers);
        }

        const name =
            "frame-" +
            String(i + 1).padStart(8, "0") +
            ".png";

        await image
            .png()
            .toFile(
                path.join(
                    renderedDir,
                    name
                )
            );

        if (
            i % Math.max(
                1,
                Math.round(totalFrames / 20)
            ) === 0
        ) {
            await reportProgress(
                18 +
                    Math.round(
                        (i / totalFrames) *
                        62
                    ),
                "rendering-native-timeline"
            );
        }
    }

    await reportProgress(82, "encoding-native-timeline");

    const videoClips = (timeline.tracks || [])
        .filter(track => track.enabled && track.type === "video")
        .flatMap(track => (track.clips || []).filter(clip => clip.enabled));

    const preserveAudio =
        !timelineHasTimeWarp(timeline) &&
        videoClips.length === 1 &&
        num(videoClips[0].start, 0) === 0;

    const args = [
        "-y",
        "-framerate",
        String(outputFps),
        "-i",
        path.join(
            renderedDir,
            "frame-%08d.png"
        )
    ];

    if (preserveAudio) {
        args.push(
            "-i",
            inputPath,
            "-map",
            "0:v:0",
            "-map",
            "1:a?"
        );
    } else {
        args.push(
            "-map",
            "0:v:0"
        );
    }

    args.push(
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "16",
        "-pix_fmt",
        "yuv420p"
    );

    if (preserveAudio) {
        args.push(
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest"
        );
    }

    args.push(
        "-t",
        String(timeline.duration),
        "-movflags",
        "+faststart",
        outputPath
    );

    await run(
        ffmpegBin,
        args
    );

    await reportProgress(
        95,
        "native-timeline-rendered"
    );

    return {
        outputPath,
        outputFps,
        totalFrames,
        audioPreserved:
            preserveAudio
    };
}

module.exports = {
    renderNativeTimeline,
    evaluateKeyframes: evaluate,
    transformAt,
    sourceTimeAt
};
