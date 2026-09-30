"use strict";

const {
    keyframe,
    normalizeGraphName
} = require("./editorGraphs");

const STYLE_NAMES = new Set([
    "celestial_velocity",
    "forward_reverse_70_30",
    "zoom_out_hold_in"
]);

const ALIASES = {
    celestial: "celestial_velocity",
    celestialvelocity: "celestial_velocity",
    celestial_velocity: "celestial_velocity",
    reverse7030: "forward_reverse_70_30",
    forwardreverse7030: "forward_reverse_70_30",
    forward_reverse_70_30: "forward_reverse_70_30",
    zoomoutholdin: "zoom_out_hold_in",
    zoom_out_hold_in: "zoom_out_hold_in"
};

function normalizeStyleName(value) {
    const raw = String(value || "").trim().toLowerCase().replace(/[\\s-]+/g, "_");
    return ALIASES[raw] || raw;
}

function listEditStyles() {
    return [
        {
            name: "celestial_velocity",
            description:
                "Zorex velocity style: accelerated forward section, reverse tail, staged zoom, subtle rotation and motion blur."
        },
        {
            name: "forward_reverse_70_30",
            description:
                "Uses the first 70% of output for forward motion and the final 30% for a reverse return."
        },
        {
            name: "zoom_out_hold_in",
            description:
                "Zooms out for 50%, stays stable for 30%, then zooms in for the final 20%."
        }
    ];
}

function makeBaseClip(duration) {
    return {
        id: "clip-1",
        source: "reply",
        sourceType: "video",
        start: 0,
        duration,
        trimStart: 0,
        transform: {},
        timeRemap: {
            enabled: false,
            keyframes: []
        },
        freezes: [],
        masks: [],
        effects: [],
        metadata: {}
    };
}

function buildForwardReverse7030(clip, duration, graph) {
    const split = duration * 0.70;

    clip.timeRemap = {
        enabled: true,
        mode: "source_time",
        keyframes: [
            keyframe(0, 0, graph),
            keyframe(split, duration, graph),
            keyframe(duration, duration * 0.70, graph)
        ]
    };

    clip.metadata.velocityRecipe = {
        forwardOutputPercent: 70,
        reverseOutputPercent: 30
    };

    return clip;
}

function buildZoomOutHoldIn(clip, duration, graph) {
    const outEnd = duration * 0.50;
    const holdEnd = duration * 0.80;

    clip.transform = {
        ...(clip.transform || {}),
        keyframes: {
            ...(clip.transform?.keyframes || {}),
            scale: [
                keyframe(0, 1.18, graph),
                keyframe(outEnd, 1.00, graph),
                keyframe(holdEnd, 1.00, "straight"),
                keyframe(duration, 1.16, graph)
            ]
        }
    };

    clip.metadata.zoomRecipe = {
        zoomOutPercent: 50,
        stablePercent: 30,
        zoomInPercent: 20
    };

    return clip;
}

function buildCelestialVelocity(clip, duration, graph) {
    const g = normalizeGraphName(graph || "z_ease");

    const t1 = duration * 0.18;
    const t2 = duration * 0.42;
    const t3 = duration * 0.70;

    clip.timeRemap = {
        enabled: true,
        mode: "source_time",
        keyframes: [
            keyframe(0, 0, g),
            keyframe(t1, duration * 0.10, "l_graph"),
            keyframe(t2, duration * 0.52, "punch"),
            keyframe(t3, duration, g),
            keyframe(duration, duration * 0.70, "u_graph")
        ]
    };

    buildZoomOutHoldIn(
        clip,
        duration,
        g
    );

    clip.transform.keyframes.rotation = [
        keyframe(0, 0, g),
        keyframe(duration, -5, "soft_ease")
    ];

    clip.transform.keyframes.x = [
        keyframe(0, 0, "soft_ease"),
        keyframe(t2, 0, "straight"),
        keyframe(t3, 18, "l_graph"),
        keyframe(duration, -10, "u_graph")
    ];

    clip.effects.push(
        {
            type: "motion_blur",
            params: {
                amount: 0.18,
                direction: "horizontal"
            },
            keyframes: {
                amount: [
                    keyframe(0, 0.12, "straight"),
                    keyframe(t1, 0.28, "l_graph"),
                    keyframe(t2, 0.52, "punch"),
                    keyframe(t3, 0.38, "z_ease"),
                    keyframe(duration, 0.22, "u_graph")
                ]
            }
        },
        {
            type: "contrast",
            params: {
                amount: 1.04
            }
        },
        {
            type: "saturation",
            params: {
                amount: 1.03
            }
        }
    );

    clip.metadata.velocityStyle = "celestial_velocity";
    clip.metadata.defaultGraph = g;

    return clip;
}

function buildStyleClip(styleName, {
    duration,
    graph = "z_ease"
}) {
    const style = normalizeStyleName(styleName);

    if (!STYLE_NAMES.has(style)) {
        throw new Error("Unknown edit style " + styleName + ".");
    }

    const d = Number(duration);

    if (!Number.isFinite(d) || d <= 0) {
        throw new Error("A positive clip duration is required.");
    }

    const clip = makeBaseClip(d);

    if (style === "forward_reverse_70_30") {
        return buildForwardReverse7030(
            clip,
            d,
            normalizeGraphName(graph)
        );
    }

    if (style === "zoom_out_hold_in") {
        return buildZoomOutHoldIn(
            clip,
            d,
            normalizeGraphName(graph)
        );
    }

    return buildCelestialVelocity(
        clip,
        d,
        graph
    );
}

module.exports = {
    STYLE_NAMES,
    normalizeStyleName,
    listEditStyles,
    buildStyleClip
};
