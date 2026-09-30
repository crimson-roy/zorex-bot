"use strict";

const {
    saveVideoBufferToTemp,
    cleanupTempFile,
    getVideoMetadata
} = require("./videoHelper");

const {
    normalizeTimeline
} = require("./editorTimeline");

const {
    buildStyleClip,
    normalizeStyleName,
    listEditStyles
} = require("./editorStyles");

const {
    normalizeGraphName,
    getGraphPreset
} = require("./editorGraphs");

const {
    createJob
} = require("./editorJobs");

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

function ensureStyle(style) {
    const normalized =
        normalizeStyleName(
            style
        );

    const exists =
        listEditStyles()
            .some(item =>
                item.name ===
                normalized
            );

    if (!exists) {
        throw new Error(
            "Unknown edit style " +
            style +
            "."
        );
    }

    return normalized;
}

function ensureGraph(graph) {
    const normalized =
        normalizeGraphName(
            graph ||
            "z_ease"
        );

    if (!getGraphPreset(normalized)) {
        throw new Error(
            "Unknown graph preset " +
            graph +
            "."
        );
    }

    return normalized;
}

async function queueStyleEdit({
    media,
    style,
    graph = "z_ease",
    ownerId,
    chatId,
    sourceMessageId = null
}) {
    if (
        !media ||
        !Buffer.isBuffer(
            media.buffer
        )
    ) {
        throw new Error(
            "queueStyleEdit requires video media."
        );
    }

    const normalizedStyle =
        ensureStyle(
            style
        );

    const normalizedGraph =
        ensureGraph(
            graph
        );

    const tempPath =
        saveVideoBufferToTemp(
            media.buffer,
            media.mimeType ||
            "video/mp4"
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

        const canvas =
            targetCanvas(
                source.width,
                source.height
            );

        const clip =
            buildStyleClip(
                normalizedStyle,
                {
                    duration:
                        source.duration,
                    graph:
                        normalizedGraph
                }
            );

        const timeline =
            normalizeTimeline({
                version:
                    "timeline_v1",
                name:
                    normalizedStyle,
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
                        "zorex-ai-style",
                    style:
                        normalizedStyle,
                    graph:
                        normalizedGraph,
                    sourceWidth:
                        source.width,
                    sourceHeight:
                        source.height,
                    sourceFps:
                        source.fps
                }
            });

        return createJob({
            type:
                "timeline_render",
            ownerId,
            chatId,
            inputBuffer:
                media.buffer,
            mimeType:
                media.mimeType ||
                "video/mp4",
            sourceMessageId,
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

    } finally {

        cleanupTempFile(
            tempPath
        );

    }
}

module.exports = {
    queueStyleEdit
};
