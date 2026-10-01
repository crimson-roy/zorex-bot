"use strict";

const {
    getQuotedVideo,
    saveVideoBufferToTemp,
    cleanupTempFile,
    getVideoMetadata
} = require("../lib/videoHelper");

const {
    normalizeTimeline
} = require("../lib/editorTimeline");

const {
    listAnimations,
    mergeAnimationIntoClip,
    normalizeName
} = require("../lib/editorAnimations");

const {
    createJob
} = require("../lib/editorJobs");

const {
    normalizeGraphName,
    getGraphPreset,
    applyGraph
} = require("../lib/editorGraphs");

const MAX_NATIVE_DURATION =
    Number(
        process.env.NATIVE_EDIT_MAX_DURATION ||
        30
    );

function targetCanvas(width, height) {
    if (width > height * 1.15) {
        return {
            width: 1280,
            height: 720
        };
    }

    if (height > width * 1.15) {
        return {
            width: 720,
            height: 1280
        };
    }

    return {
        width: 960,
        height: 960
    };
}

function animationHelp() {
    const lines =
        listAnimations()
            .map(
                item =>
                    "• " +
                    item.name +
                    " — " +
                    item.description
            )
            .join("\n");

    return (
        "🎬 *Zorex Native Animations*\n\n" +
        lines +
        "\n\nReply to a video with:\n" +
        ".edit <animation>\n\n" +
        "Example:\n" +
        ".edit bend_zoom"
    );
}

function applyAnimationControls(
    clip,
    {
        graph = null,
        maxZoomPercent = null
    } = {}
) {
    const normalizedGraph =
        graph
            ? normalizeGraphName(graph)
            : null;

    if (
        normalizedGraph &&
        getGraphPreset(normalizedGraph)
    ) {
        const keyframes =
            clip.transform?.keyframes ||
            {};

        for (const key of Object.keys(keyframes)) {
            if (Array.isArray(keyframes[key])) {
                keyframes[key] =
                    applyGraph(
                        keyframes[key],
                        normalizedGraph
                    );
            }
        }

        clip.metadata = {
            ...(clip.metadata || {}),
            graphPreset:
                normalizedGraph
        };
    }

    const requestedMax =
        Number(maxZoomPercent);

    if (
        Number.isFinite(requestedMax) &&
        requestedMax >= 100 &&
        requestedMax <= 400 &&
        Array.isArray(
            clip.transform
                ?.keyframes
                ?.scale
        )
    ) {
        const frames =
            clip.transform
                .keyframes
                .scale;

        const target =
            requestedMax / 100;

        const currentMax =
            Math.max(
                ...frames.map(
                    frame =>
                        Number(frame.value || 1)
                )
            );

        if (currentMax > 1) {
            const factor =
                (target - 1) /
                (currentMax - 1);

            for (const frame of frames) {
                const value =
                    Number(frame.value || 1);

                frame.value =
                    1 +
                    (value - 1) *
                    factor;
            }
        }

        clip.metadata = {
            ...(clip.metadata || {}),
            maxZoomPercent:
                requestedMax
        };
    }

    return clip;
}

async function editCommand(
    sock,
    msg,
    text,
    mediaOverride = null,
    editOptions = {}
) {

    const chatId =
        msg.key.remoteJid;

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const body =
        String(text || "")
            .replace(/^\.edit\b/i, "")
            .trim();

    if (
        !body ||
        /^(?:animations?|list|help)$/i.test(body)
    ) {
        return await sock.sendMessage(
            chatId,
            {
                text:
                    animationHelp()
            },
            {
                quoted:
                    msg
            }
        );
    }

    const requested =
        normalizeName(
            body.split(/\s+/)[0]
        );

    if (
        !listAnimations()
            .some(
                item =>
                    item.name ===
                    requested
            )
    ) {
        return await sock.sendMessage(
            chatId,
            {
                text:
                    "⚠️ Unknown native animation: " +
                    requested +
                    "\n\n" +
                    animationHelp()
            },
            {
                quoted:
                    msg
            }
        );
    }

    let media =
        mediaOverride &&
        Buffer.isBuffer(
            mediaOverride.buffer
        )
            ? {
                buffer:
                    mediaOverride.buffer,
                mimeType:
                    mediaOverride.mimeType ||
                    "video/mp4"
            }
            : null;

    try {
        if (!media) {
            media =
                await getQuotedVideo(
                    sock,
                    msg
                );
        }
    } catch (err) {
        console.error(
            "[.edit] quoted video failed:",
            err.message
        );
    }

    if (!media) {
        return await sock.sendMessage(
            chatId,
            {
                text:
                    "⚠️ Reply to a video with .edit " +
                    requested
            },
            {
                quoted:
                    msg
            }
        );
    }

    const tempPath =
        saveVideoBufferToTemp(
            media.buffer,
            media.mimeType
        );

    try {

        const source =
            await getVideoMetadata(
                tempPath
            );

        if (
            !source.duration ||
            !source.width ||
            !source.height
        ) {
            throw new Error(
                "Could not read source video metadata."
            );
        }

        if (
            source.duration >
            MAX_NATIVE_DURATION
        ) {
            return await sock.sendMessage(
                chatId,
                {
                    text:
                        "⚠️ Native timeline test is currently limited to " +
                        MAX_NATIVE_DURATION +
                        " seconds per clip.\n\n" +
                        "The source is " +
                        source.duration.toFixed(1) +
                        "s. Trim/split support will let longer videos be edited in sections."
                },
                {
                    quoted:
                        msg
                }
            );
        }

        const canvas =
            targetCanvas(
                source.width,
                source.height
            );

        const clip = {
            id:
                "clip-1",
            source:
                "reply",
            sourceType:
                "video",
            start:
                0,
            duration:
                source.duration,
            trimStart:
                0,
            transform: {},
            timeRemap: {
                enabled:
                    false,
                keyframes:
                    []
            },
            freezes:
                [],
            masks:
                [],
            effects:
                [],
            metadata: {}
        };

        mergeAnimationIntoClip(
            clip,
            requested,
            {
                duration:
                    source.duration,
                width:
                    canvas.width,
                height:
                    canvas.height
            }
        );

        applyAnimationControls(
            clip,
            editOptions
        );

        const timeline =
            normalizeTimeline({
                version:
                    "timeline_v1",
                name:
                    "Native " +
                    requested,
                width:
                    canvas.width,
                height:
                    canvas.height,
                fps:
                    Math.min(
                        30,
                        Math.max(
                            12,
                            source.fps
                        )
                    ),
                duration:
                    source.duration,
                tracks: [
                    {
                        id:
                            "video-1",
                        type:
                            "video",
                        name:
                            "Main video",
                        clips: [
                            clip
                        ]
                    }
                ],
                metadata: {
                    createdBy:
                        ".edit",
                    animation:
                        requested,
                    sourceWidth:
                        source.width,
                    sourceHeight:
                        source.height,
                    sourceFps:
                        source.fps,
                    graph:
                        clip.metadata
                            ?.graphPreset ||
                        null,
                    maxZoomPercent:
                        clip.metadata
                            ?.maxZoomPercent ||
                        null
                }
            });

        const job =
            createJob({
                type:
                    "timeline_render",
                ownerId:
                    sender,
                chatId,
                inputBuffer:
                    media.buffer,
                mimeType:
                    media.mimeType,
                sourceMessageId:
                    msg.key.id ||
                    null,
                options: {
                    timeline
                },
                requirements: {
                    gpu:
                        false,
                    minVramGb:
                        0,
                    capabilities: [
                        "timeline_v1",
                        "ffmpeg",
                        "native-cc",
                        "native-animation"
                    ]
                }
            });

        return await sock.sendMessage(
            chatId,
            {
                text:
                    "🎬 *Native Zorex edit queued*\n\n" +
                    "Job: *" +
                    job.id +
                    "*\n" +
                    "Animation: " +
                    requested +
                    "\n" +
                    (
                        clip.metadata
                            ?.graphPreset
                            ? "Graph: " +
                              clip.metadata.graphPreset +
                              "\n"
                            : ""
                    ) +
                    (
                        clip.metadata
                            ?.maxZoomPercent
                            ? "Max zoom: " +
                              clip.metadata.maxZoomPercent +
                              "%\n"
                            : ""
                    ) +
                    "Canvas: " +
                    canvas.width +
                    "×" +
                    canvas.height +
                    "\n" +
                    "FPS: " +
                    timeline.fps +
                    "\n" +
                    "Renderer: Native timeline_v1\n\n" +
                    "Use:\n.queue " +
                    job.id
            },
            {
                quoted:
                    msg
            }
        );

    } catch (err) {

        console.error(
            "[.edit] failed:",
            err
        );

        return await sock.sendMessage(
            chatId,
            {
                text:
                    "❌ I couldn't create that native edit job."
            },
            {
                quoted:
                    msg
            }
        );

    } finally {

        cleanupTempFile(
            tempPath
        );

    }
}

module.exports = {
    editCommand
};
