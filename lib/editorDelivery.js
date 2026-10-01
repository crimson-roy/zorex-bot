"use strict";

const fs = require("fs");
const path = require("path");

const {
    listJobs,
    updateJob,
    JOBS_DIR
} = require("./editorJobs");

let timer = null;
let activeSock = null;
let startedAt = 0;
let running = false;

function outputKind(job) {
    const mime =
        String(job.outputMimeType || "")
            .toLowerCase();

    if (mime.startsWith("image/")) {
        return "image";
    }

    if (mime.startsWith("video/")) {
        return "video";
    }

    return null;
}

async function deliverJob(sock, job) {
    if (!job.chatId || !job.outputName) {
        return false;
    }

    const kind = outputKind(job);
    if (!kind) {
        return false;
    }

    const outputPath =
        path.join(
            JOBS_DIR,
            job.id,
            job.outputName
        );

    if (!fs.existsSync(outputPath)) {
        return false;
    }

    const caption =
        kind === "video"
            ? "🎬 *Zorex edit finished*\n\nJob: *" + job.id + "*"
            : "✨ *Zorex image finished*\n\nJob: *" + job.id + "*";

    if (kind === "video") {
        await sock.sendMessage(
            job.chatId,
            {
                video: { url: outputPath },
                mimetype: job.outputMimeType || "video/mp4",
                caption
            }
        );
    } else {
        await sock.sendMessage(
            job.chatId,
            {
                image: { url: outputPath },
                mimetype: job.outputMimeType || "image/png",
                caption
            }
        );
    }

    updateJob(
        job.id,
        {
            autoDeliveredAt:
                new Date().toISOString()
        }
    );

    return true;
}

async function sweep() {
    if (running || !activeSock) {
        return;
    }

    running = true;

    try {
        const jobs =
            listJobs({
                limit: 50
            });

        for (const job of jobs) {
            if (
                job.status !== "completed" ||
                job.autoDeliveredAt ||
                !job.completedAt
            ) {
                continue;
            }

            if (
                new Date(job.completedAt).getTime() <
                startedAt
            ) {
                continue;
            }

            try {
                await deliverJob(
                    activeSock,
                    job
                );
            } catch (err) {
                console.error(
                    "[EDITOR DELIVERY] failed",
                    job.id,
                    err.message
                );
            }
        }
    } finally {
        running = false;
    }
}

function startEditorDeliverySweeper(sock) {
    activeSock = sock;

    if (!startedAt) {
        startedAt = Date.now();
    }

    if (timer) {
        return timer;
    }

    timer =
        setInterval(
            () => {
                sweep().catch(
                    err =>
                        console.error(
                            "[EDITOR DELIVERY] sweep failed:",
                            err.message
                        )
                );
            },
            Math.max(
                1500,
                Number(
                    process.env.EDITOR_DELIVERY_POLL_MS ||
                    3000
                )
            )
        );

    if (typeof timer.unref === "function") {
        timer.unref();
    }

    sweep().catch(() => {});
    return timer;
}

module.exports = {
    startEditorDeliverySweeper
};
