"use strict";

const GRAPH_PRESETS = {
    straight: { description: "Constant-rate linear motion.", easing: "linear" },
    z_ease: { description: "Zorex default smooth acceleration/deceleration curve.", easing: "bezier", curve: [0.16, 1.0, 0.30, 1.0] },
    u_graph: { description: "Soft start, fast middle, soft finish; useful for smooth zooms and pans.", easing: "bezier", curve: [0.42, 0.0, 0.58, 1.0] },
    l_graph: { description: "Fast initial hit that settles gradually; useful for impact zooms and shakes.", easing: "bezier", curve: [0.08, 0.82, 0.18, 1.0] },
    reverse_l: { description: "Slow build followed by a strong finish.", easing: "bezier", curve: [0.72, 0.0, 0.92, 0.24] },
    soft_ease: { description: "Gentle general-purpose cinematic easing.", easing: "bezier", curve: [0.40, 0.0, 0.20, 1.0] },
    punch: { description: "Aggressive response for beat hits and velocity peaks.", easing: "bezier", curve: [0.06, 0.92, 0.16, 1.0] },
    float: { description: "Slow floating motion with a long soft settle.", easing: "bezier", curve: [0.22, 0.75, 0.28, 1.0] }
};

const ALIASES = {
    z: "z_ease",
    zease: "z_ease",
    z_ease: "z_ease",
    u: "u_graph",
    ugraph: "u_graph",
    u_graph: "u_graph",
    l: "l_graph",
    lgraph: "l_graph",
    l_graph: "l_graph",
    linear: "straight",
    straight_graph: "straight",
    smooth: "soft_ease"
};

function normalizeGraphName(value) {
    const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    return ALIASES[raw] || raw;
}

function getGraphPreset(name) {
    const key = normalizeGraphName(name);
    const preset = GRAPH_PRESETS[key];
    if (!preset) return null;
    return { name: key, ...JSON.parse(JSON.stringify(preset)) };
}

function listGraphPresets() {
    return Object.entries(GRAPH_PRESETS).map(([name, value]) => ({
        name,
        description: value.description,
        easing: value.easing,
        curve: value.curve || null
    }));
}

function keyframe(time, value, graph = "z_ease", extra = {}) {
    const preset = getGraphPreset(graph);
    if (!preset) throw new Error("Unknown graph preset " + graph + ".");
    return {
        time: Number(time),
        value,
        graph: preset.name,
        easing: preset.easing,
        ...(preset.curve ? { curve: preset.curve } : {}),
        ...extra
    };
}

function applyGraph(frames, graphName) {
    const preset = getGraphPreset(graphName);
    if (!preset) throw new Error("Unknown graph preset " + graphName + ".");

    return (Array.isArray(frames) ? frames : []).map(frame => {
        const out = {
            ...frame,
            graph: preset.name,
            easing: preset.easing
        };

        if (preset.curve) {
            out.curve = [...preset.curve];
        } else {
            delete out.curve;
        }

        return out;
    });
}

module.exports = {
    GRAPH_PRESETS,
    normalizeGraphName,
    getGraphPreset,
    listGraphPresets,
    keyframe,
    applyGraph
};
