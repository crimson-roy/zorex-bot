"use strict";

const {
    getGraphPreset,
    normalizeGraphName
} = require("./editorGraphs");

/**
 * Zorex Editor timeline_v1
 *
 * This module is deliberately renderer-agnostic. It validates and normalizes
 * edit intent so WhatsApp/.ai/UI clients can describe an edit once and workers
 * can render it with FFmpeg, AI models, After Effects, or other backends.
 */

const TIMELINE_VERSION = "timeline_v1";

const TRACK_TYPES = new Set([
    "video",
    "audio",
    "text",
    "overlay",
    "adjustment"
]);

const EFFECT_TYPES = new Set([
    "blur",
    "brightness",
    "contrast",
    "saturation",
    "hue",
    "opacity",
    "depth_mist",
    "depth_map",
    "upscale",
    "denoise",
    "sharpen",
    "glow",
    "vignette",
    "motion_blur",
    "aftereffects_preset"
]);

const EASINGS = new Set([
    "linear",
    "hold",
    "ease",
    "ease_in",
    "ease_out",
    "ease_in_out",
    "bezier"
]);

function finite(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function cleanId(value, fallback) {
    const s = String(value || "").trim();
    return s ? s.slice(0, 80) : fallback;
}

function normalizeKeyframe(raw, index = 0) {
    if (!raw || typeof raw !== "object") {
        throw new Error("Keyframe must be an object.");
    }

    const time = finite(raw.time, NaN);
    if (!Number.isFinite(time) || time < 0) {
        throw new Error("Keyframe time must be a non-negative number.");
    }

    const requestedGraph =
        raw.graph
            ? getGraphPreset(
                normalizeGraphName(
                    raw.graph
                )
            )
            : null;

    const defaultGraph =
        !raw.easing &&
        !raw.graph
            ? getGraphPreset(
                "z_ease"
            )
            : null;

    const graphPreset =
        requestedGraph ||
        defaultGraph;

    const easing =
        String(
            graphPreset?.easing ||
            raw.easing ||
            "linear"
        )
            .toLowerCase();

    if (!EASINGS.has(easing)) {
        throw new Error(`Unsupported keyframe easing "${easing}".`);
    }

    const result = {
        id: cleanId(raw.id, `kf-${index + 1}`),
        time,
        value: raw.value,
        graph:
            graphPreset?.name ||
            (
                raw.graph
                    ? normalizeGraphName(
                        raw.graph
                    )
                    : null
            ),
        easing
    };

    if (easing === "bezier") {
        const curve =
            Array.isArray(raw.curve)
                ? raw.curve.map(Number)
                : Array.isArray(graphPreset?.curve)
                    ? graphPreset.curve.map(Number)
                    : [];
        if (
            curve.length !== 4 ||
            curve.some(value => !Number.isFinite(value))
        ) {
            throw new Error("Bezier keyframes require curve: [x1,y1,x2,y2].");
        }
        result.curve = curve.map(value => clamp(value, -10, 10));
    }

    return result;
}

function normalizeKeyframes(list) {
    const out = (Array.isArray(list) ? list : [])
        .map(normalizeKeyframe)
        .sort((a, b) => a.time - b.time);

    for (let i = 1; i < out.length; i++) {
        if (out[i].time === out[i - 1].time) {
            throw new Error("Two keyframes on the same property cannot share a time.");
        }
    }

    return out;
}

function normalizeTransform(raw = {}) {
    const numeric = (value, fallback) => finite(value, fallback);

    return {
        x: numeric(raw.x, 0),
        y: numeric(raw.y, 0),
        scaleX: numeric(raw.scaleX, raw.scale ?? 1),
        scaleY: numeric(raw.scaleY, raw.scale ?? 1),
        rotation: numeric(raw.rotation, 0),
        anchorX: numeric(raw.anchorX, 0.5),
        anchorY: numeric(raw.anchorY, 0.5),
        opacity: clamp(numeric(raw.opacity, 1), 0, 1),
        keyframes: {
            x: normalizeKeyframes(raw.keyframes?.x),
            y: normalizeKeyframes(raw.keyframes?.y),
            scaleX: normalizeKeyframes(raw.keyframes?.scaleX || raw.keyframes?.scale),
            scaleY: normalizeKeyframes(raw.keyframes?.scaleY || raw.keyframes?.scale),
            rotation: normalizeKeyframes(raw.keyframes?.rotation),
            opacity: normalizeKeyframes(raw.keyframes?.opacity)
        }
    };
}

function normalizeTimeRemap(raw = {}) {
    const enabled = Boolean(raw.enabled);
    const keyframes = normalizeKeyframes(raw.keyframes);

    for (const keyframe of keyframes) {
        const sourceTime = finite(keyframe.value, NaN);
        if (!Number.isFinite(sourceTime) || sourceTime < 0) {
            throw new Error("Time-remap keyframe values must be source times in seconds.");
        }
        keyframe.value = sourceTime;
    }

    return {
        enabled,
        mode: String(raw.mode || "source_time"),
        keyframes
    };
}

function normalizeMask(raw, index = 0) {
    if (!raw || typeof raw !== "object") {
        throw new Error("Mask must be an object.");
    }

    const type = String(raw.type || "polygon").toLowerCase();
    if (!["rectangle", "ellipse", "polygon", "subject"].includes(type)) {
        throw new Error(`Unsupported mask type "${type}".`);
    }

    const result = {
        id: cleanId(raw.id, `mask-${index + 1}`),
        type,
        mode: ["add", "subtract", "intersect"].includes(String(raw.mode).toLowerCase())
            ? String(raw.mode).toLowerCase()
            : "add",
        feather: Math.max(0, finite(raw.feather, 0)),
        expansion: finite(raw.expansion, 0),
        invert: Boolean(raw.invert),
        opacity: clamp(finite(raw.opacity, 1), 0, 1),
        keyframes: normalizeKeyframes(raw.keyframes)
    };

    if (type === "rectangle") {
        result.x = finite(raw.x, 0.15);
        result.y = finite(raw.y, 0.15);
        result.width = Math.max(0, finite(raw.width, 0.7));
        result.height = Math.max(0, finite(raw.height, 0.7));
    }

    if (type === "ellipse") {
        result.cx = finite(raw.cx, 0.5);
        result.cy = finite(raw.cy, 0.5);
        result.rx = Math.max(0, finite(raw.rx, 0.35));
        result.ry = Math.max(0, finite(raw.ry, 0.35));
    }

    if (type === "polygon") {
        const points = Array.isArray(raw.points) ? raw.points : [];
        if (points.length < 3) {
            throw new Error("Polygon masks require at least 3 points.");
        }
        result.points = points.map(point => ({
            x: finite(point?.x, 0),
            y: finite(point?.y, 0)
        }));
    }

    if (type === "subject") {
        result.subject = {
            method: String(raw.subject?.method || "auto"),
            track: raw.subject?.track !== false
        };
    }

    return result;
}

function normalizeEffect(raw, index = 0) {
    if (!raw || typeof raw !== "object") {
        throw new Error("Effect must be an object.");
    }

    const type = String(raw.type || "").toLowerCase();
    if (!EFFECT_TYPES.has(type)) {
        throw new Error(`Unsupported effect type "${type}".`);
    }

    const result = {
        id: cleanId(raw.id, `fx-${index + 1}`),
        type,
        enabled: raw.enabled !== false,
        mix: clamp(finite(raw.mix, 1), 0, 1),
        params: raw.params && typeof raw.params === "object"
            ? JSON.parse(JSON.stringify(raw.params))
            : {},
        keyframes: {}
    };

    if (raw.keyframes && typeof raw.keyframes === "object") {
        for (const [name, frames] of Object.entries(raw.keyframes)) {
            result.keyframes[String(name)] = normalizeKeyframes(frames);
        }
    }

    if (type === "aftereffects_preset") {
        result.params.preset = String(result.params.preset || "").trim();
        if (!result.params.preset) {
            throw new Error("aftereffects_preset requires params.preset.");
        }
        result.params.requiredPlugins = Array.isArray(result.params.requiredPlugins)
            ? result.params.requiredPlugins.map(String)
            : [];
    }

    return result;
}

function normalizeFreeze(raw, index = 0) {
    if (!raw || typeof raw !== "object") {
        throw new Error("Freeze segment must be an object.");
    }

    const at = finite(raw.at, NaN);
    const duration = finite(raw.duration, NaN);

    if (!Number.isFinite(at) || at < 0 || !Number.isFinite(duration) || duration <= 0) {
        throw new Error("Freeze requires non-negative at and positive duration.");
    }

    return {
        id: cleanId(raw.id, `freeze-${index + 1}`),
        at,
        duration
    };
}

function normalizeClip(raw, index = 0) {
    if (!raw || typeof raw !== "object") {
        throw new Error("Clip must be an object.");
    }

    const start = finite(raw.start, 0);
    const duration = finite(raw.duration, NaN);
    const trimStart = Math.max(0, finite(raw.trimStart, 0));

    if (start < 0) {
        throw new Error("Clip start cannot be negative.");
    }

    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("Clip duration must be a positive number.");
    }

    return {
        id: cleanId(raw.id, `clip-${index + 1}`),
        source: String(raw.source || "reply"),
        sourceType: String(raw.sourceType || "video"),
        start,
        duration,
        trimStart,
        trimEnd: raw.trimEnd == null ? null : Math.max(trimStart, finite(raw.trimEnd, trimStart)),
        enabled: raw.enabled !== false,
        transform: normalizeTransform(raw.transform),
        timeRemap: normalizeTimeRemap(raw.timeRemap),
        freezes: (Array.isArray(raw.freezes) ? raw.freezes : []).map(normalizeFreeze),
        masks: (Array.isArray(raw.masks) ? raw.masks : []).map(normalizeMask),
        effects: (Array.isArray(raw.effects) ? raw.effects : []).map(normalizeEffect),
        metadata: raw.metadata && typeof raw.metadata === "object"
            ? JSON.parse(JSON.stringify(raw.metadata))
            : {}
    };
}

function normalizeTrack(raw, index = 0) {
    if (!raw || typeof raw !== "object") {
        throw new Error("Track must be an object.");
    }

    const type = String(raw.type || "video").toLowerCase();
    if (!TRACK_TYPES.has(type)) {
        throw new Error(`Unsupported track type "${type}".`);
    }

    return {
        id: cleanId(raw.id, `track-${index + 1}`),
        type,
        name: String(raw.name || `${type} ${index + 1}`).slice(0, 120),
        enabled: raw.enabled !== false,
        locked: Boolean(raw.locked),
        clips: (Array.isArray(raw.clips) ? raw.clips : []).map(normalizeClip)
    };
}

function inferDuration(tracks) {
    let max = 0;
    for (const track of tracks) {
        for (const clip of track.clips) {
            max = Math.max(max, clip.start + clip.duration);
        }
    }
    return max;
}

function collectRequirements(timeline) {
    const capabilities = new Set(["ffmpeg"]);
    let gpu = false;
    let minVramGb = 0;

    for (const track of timeline.tracks) {
        for (const clip of track.clips) {
            for (const mask of clip.masks) {
                if (mask.type === "subject") {
                    capabilities.add("segmentation");
                    gpu = true;
                    minVramGb = Math.max(minVramGb, 2);
                }
            }

            for (const effect of clip.effects) {
                if (effect.type === "upscale") {
                    capabilities.add("realesrgan");
                    gpu = true;
                    minVramGb = Math.max(minVramGb, Number(effect.params.minVramGb || 1));
                }

                if (effect.type === "depth_map" || effect.type === "depth_mist") {
                    capabilities.add("depth");
                    gpu = true;
                    minVramGb = Math.max(minVramGb, Number(effect.params.minVramGb || 2));
                }

                if (effect.type === "aftereffects_preset") {
                    capabilities.add("aftereffects");
                    for (const plugin of effect.params.requiredPlugins || []) {
                        capabilities.add(`ae-plugin:${String(plugin).toLowerCase()}`);
                    }
                }
            }
        }
    }

    return {
        gpu,
        minVramGb,
        capabilities: [...capabilities]
    };
}

function normalizeTimeline(raw) {
    if (!raw || typeof raw !== "object") {
        throw new Error("Timeline must be an object.");
    }

    const version = String(raw.version || TIMELINE_VERSION);
    if (version !== TIMELINE_VERSION) {
        throw new Error(`Unsupported timeline version "${version}".`);
    }

    const tracks = (Array.isArray(raw.tracks) ? raw.tracks : []).map(normalizeTrack);
    if (!tracks.length) {
        throw new Error("Timeline requires at least one track.");
    }

    const inferred = inferDuration(tracks);
    const requestedDuration = raw.duration == null ? inferred : finite(raw.duration, NaN);

    if (!Number.isFinite(requestedDuration) || requestedDuration <= 0) {
        throw new Error("Timeline duration must be positive.");
    }

    if (requestedDuration + 1e-6 < inferred) {
        throw new Error("Timeline duration cannot end before its last clip.");
    }

    const timeline = {
        version: TIMELINE_VERSION,
        name: String(raw.name || "Untitled edit").slice(0, 160),
        width: Math.max(16, Math.round(finite(raw.width, 1080))),
        height: Math.max(16, Math.round(finite(raw.height, 1920))),
        fps: clamp(finite(raw.fps, 30), 1, 240),
        duration: requestedDuration,
        background: String(raw.background || "#000000"),
        tracks,
        metadata: raw.metadata && typeof raw.metadata === "object"
            ? JSON.parse(JSON.stringify(raw.metadata))
            : {}
    };

    timeline.requirements = collectRequirements(timeline);
    return timeline;
}

function cloneTimeline(timeline) {
    return JSON.parse(JSON.stringify(normalizeTimeline(timeline)));
}

module.exports = {
    TIMELINE_VERSION,
    TRACK_TYPES,
    EFFECT_TYPES,
    EASINGS,
    normalizeTimeline,
    normalizeTrack,
    normalizeClip,
    normalizeEffect,
    normalizeMask,
    normalizeKeyframes,
    collectRequirements,
    cloneTimeline
};
