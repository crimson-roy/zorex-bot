"use strict";

const BUILTIN_ANIMATIONS = {
    zoom_in: {
        description: "Smooth push-in zoom.",
        build({ duration }) {
            return {
                transform: {
                    keyframes: {
                        scale: [
                            { time: 0, value: 1, easing: "ease_in_out" },
                            { time: duration, value: 1.22, easing: "ease_out" }
                        ]
                    }
                }
            };
        }
    },

    zoom_out: {
        description: "Smooth pull-back zoom.",
        build({ duration }) {
            return {
                transform: {
                    keyframes: {
                        scale: [
                            { time: 0, value: 1.22, easing: "ease_in_out" },
                            { time: duration, value: 1, easing: "ease_out" }
                        ]
                    }
                }
            };
        }
    },

    punch_zoom: {
        description: "Fast impact zoom with settle.",
        build({ duration }) {
            const a = Math.min(duration * 0.22, 0.18);
            const b = Math.min(duration * 0.48, 0.42);
            return {
                transform: {
                    keyframes: {
                        scale: [
                            { time: 0, value: 1, easing: "ease_out" },
                            { time: a, value: 1.32, easing: "ease_out" },
                            { time: b, value: 1.12, easing: "ease_in_out" },
                            { time: duration, value: 1.16, easing: "ease_out" }
                        ]
                    }
                },
                effects: [
                    {
                        type: "motion_blur",
                        params: { amount: 0.28, samples: 5 }
                    }
                ]
            };
        }
    },

    pan_left: {
        description: "Camera-like pan from right to left.",
        build({ duration, width }) {
            const shift = Math.round(width * 0.12);
            return {
                transform: {
                    scale: 1.15,
                    keyframes: {
                        x: [
                            { time: 0, value: shift, easing: "ease_in_out" },
                            { time: duration, value: -shift, easing: "ease_in_out" }
                        ]
                    }
                }
            };
        }
    },

    pan_right: {
        description: "Camera-like pan from left to right.",
        build({ duration, width }) {
            const shift = Math.round(width * 0.12);
            return {
                transform: {
                    scale: 1.15,
                    keyframes: {
                        x: [
                            { time: 0, value: -shift, easing: "ease_in_out" },
                            { time: duration, value: shift, easing: "ease_in_out" }
                        ]
                    }
                }
            };
        }
    },

    pan_up: {
        description: "Camera-like upward pan.",
        build({ duration, height }) {
            const shift = Math.round(height * 0.10);
            return {
                transform: {
                    scale: 1.15,
                    keyframes: {
                        y: [
                            { time: 0, value: shift, easing: "ease_in_out" },
                            { time: duration, value: -shift, easing: "ease_in_out" }
                        ]
                    }
                }
            };
        }
    },

    pan_down: {
        description: "Camera-like downward pan.",
        build({ duration, height }) {
            const shift = Math.round(height * 0.10);
            return {
                transform: {
                    scale: 1.15,
                    keyframes: {
                        y: [
                            { time: 0, value: -shift, easing: "ease_in_out" },
                            { time: duration, value: shift, easing: "ease_in_out" }
                        ]
                    }
                }
            };
        }
    },

    bounce_zoom: {
        description: "Elastic zoom with a soft rebound.",
        build({ duration }) {
            const a = duration * 0.35;
            const b = duration * 0.62;
            return {
                transform: {
                    keyframes: {
                        scale: [
                            { time: 0, value: 1, easing: "ease_out" },
                            { time: a, value: 1.24, easing: "ease_out" },
                            { time: b, value: 1.09, easing: "ease_in_out" },
                            { time: duration, value: 1.15, easing: "ease_out" }
                        ]
                    }
                }
            };
        }
    },

    bend_zoom: {
        description: "Original Zorex curved zoom: push, tilt, drift and settle.",
        build({ duration, width }) {
            const drift = Math.round(width * 0.045);
            const a = duration * 0.28;
            const b = duration * 0.68;
            return {
                transform: {
                    keyframes: {
                        scale: [
                            { time: 0, value: 1, easing: "ease_in_out" },
                            { time: a, value: 1.28, easing: "ease_out" },
                            { time: b, value: 1.14, easing: "ease_in_out" },
                            { time: duration, value: 1.2, easing: "ease_out" }
                        ],
                        rotation: [
                            { time: 0, value: -1.2, easing: "ease_in_out" },
                            { time: a, value: 1.7, easing: "ease_out" },
                            { time: b, value: -0.6, easing: "ease_in_out" },
                            { time: duration, value: 0, easing: "ease_out" }
                        ],
                        x: [
                            { time: 0, value: -drift, easing: "ease_in_out" },
                            { time: a, value: drift, easing: "ease_out" },
                            { time: duration, value: 0, easing: "ease_out" }
                        ]
                    }
                },
                effects: [
                    {
                        type: "motion_blur",
                        params: { amount: 0.32, samples: 7 }
                    }
                ]
            };
        }
    },

    whip_left: {
        description: "Fast lateral whip with motion blur.",
        build({ duration, width }) {
            const shift = Math.round(width * 0.42);
            const t = Math.min(duration, 0.5);
            return {
                transform: {
                    scale: 1.12,
                    keyframes: {
                        x: [
                            { time: 0, value: shift, easing: "ease_out" },
                            { time: t, value: 0, easing: "ease_out" }
                        ]
                    }
                },
                effects: [
                    {
                        type: "motion_blur",
                        params: { amount: 0.5, samples: 9, direction: "horizontal" }
                    }
                ]
            };
        }
    },

    whip_right: {
        description: "Fast lateral whip from the opposite side.",
        build({ duration, width }) {
            const shift = Math.round(width * 0.42);
            const t = Math.min(duration, 0.5);
            return {
                transform: {
                    scale: 1.12,
                    keyframes: {
                        x: [
                            { time: 0, value: -shift, easing: "ease_out" },
                            { time: t, value: 0, easing: "ease_out" }
                        ]
                    }
                },
                effects: [
                    {
                        type: "motion_blur",
                        params: { amount: 0.5, samples: 9, direction: "horizontal" }
                    }
                ]
            };
        }
    },

    soft_shake: {
        description: "Small handheld-style shake.",
        build({ duration, width, height }) {
            const x = Math.max(2, Math.round(width * 0.008));
            const y = Math.max(2, Math.round(height * 0.006));
            const steps = Math.max(4, Math.min(16, Math.round(duration * 8)));
            const xFrames = [];
            const yFrames = [];
            const rFrames = [];

            for (let i = 0; i <= steps; i++) {
                const time = duration * (i / steps);
                const sign = i % 2 === 0 ? 1 : -1;
                xFrames.push({ time, value: sign * x * (i % 3 === 0 ? 1 : 0.55), easing: "ease_in_out" });
                yFrames.push({ time, value: -sign * y * (i % 4 === 0 ? 1 : 0.45), easing: "ease_in_out" });
                rFrames.push({ time, value: sign * 0.35, easing: "ease_in_out" });
            }

            return {
                transform: {
                    scale: 1.04,
                    keyframes: {
                        x: xFrames,
                        y: yFrames,
                        rotation: rFrames
                    }
                }
            };
        }
    },

    cinematic_push: {
        description: "Slow cinematic push with native Zorex CC.",
        build({ duration }) {
            return {
                transform: {
                    keyframes: {
                        scale: [
                            { time: 0, value: 1.02, easing: "ease_in_out" },
                            { time: duration, value: 1.16, easing: "ease_in_out" }
                        ]
                    }
                },
                effects: [
                    { type: "contrast", params: { amount: 1.06 } },
                    { type: "saturation", params: { amount: 1.04 } },
                    { type: "vignette", params: { amount: 0.16 } }
                ]
            };
        }
    }
};

const ALIASES = {
    panin: "zoom_in",
    panout: "zoom_out",
    zoomin: "zoom_in",
    zoomout: "zoom_out",
    bendzoom: "bend_zoom",
    bounce: "bounce_zoom",
    shake: "soft_shake",
    push: "cinematic_push"
};

function normalizeName(name) {
    const key = String(name || "")
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");

    return ALIASES[key] || key;
}

function listAnimations() {
    return Object.entries(BUILTIN_ANIMATIONS).map(([name, item]) => ({
        name,
        description: item.description
    }));
}

function mergeAnimationIntoClip(clip, animationName, context = {}) {
    const name = normalizeName(animationName);
    const entry = BUILTIN_ANIMATIONS[name];

    if (!entry) {
        throw new Error(`Unknown animation preset "${animationName}".`);
    }

    const duration = Number(context.duration || clip.duration || 1);
    const width = Number(context.width || 1080);
    const height = Number(context.height || 1920);
    const patch = entry.build({ duration, width, height });

    clip.transform = {
        ...(clip.transform || {}),
        ...(patch.transform || {}),
        keyframes: {
            ...(clip.transform?.keyframes || {}),
            ...(patch.transform?.keyframes || {})
        }
    };

    if (Array.isArray(patch.effects) && patch.effects.length) {
        clip.effects = [
            ...(Array.isArray(clip.effects) ? clip.effects : []),
            ...patch.effects
        ];
    }

    clip.metadata = {
        ...(clip.metadata || {}),
        animationPreset: name
    };

    return clip;
}

module.exports = {
    BUILTIN_ANIMATIONS,
    listAnimations,
    mergeAnimationIntoClip,
    normalizeName
};
