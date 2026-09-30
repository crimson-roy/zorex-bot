"use strict";

const { createJob } = require("./editorJobs");

function queueReferenceAnalysis({
    media,
    ownerId,
    chatId,
    sourceMessageId = null,
    label = ""
}) {
    if (
        !media ||
        !Buffer.isBuffer(
            media.buffer
        )
    ) {
        throw new Error(
            "Reference analysis requires a video buffer."
        );
    }

    return createJob({
        type:
            "reference_analyze",
        ownerId,
        chatId,
        inputBuffer:
            media.buffer,
        mimeType:
            media.mimeType ||
            "video/mp4",
        sourceMessageId,
        options: {
            label:
                String(label || "")
                    .trim()
                    .slice(0, 160),
            discardSourceAfterAnalysis:
                true
        },
        requirements: {
            gpu:
                false,
            minVramGb:
                0,
            capabilities: [
                "ffmpeg",
                "reference-analysis"
            ]
        }
    });
}

module.exports = {
    queueReferenceAnalysis
};
