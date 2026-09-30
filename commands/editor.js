"use strict";

const fs = require("fs");
const path = require("path");
const {
    getJob,
    listJobs,
    cancelJob,
    JOBS_DIR
} = require("../lib/editorJobs");

function statusIcon(status) {
    switch (status) {
        case "completed": return "✅";
        case "processing": return "⚙️";
        case "failed": return "❌";
        case "cancelled": return "🚫";
        default: return "⏳";
    }
}

function progressBar(progress) {
    const pct = Math.max(0, Math.min(100, Number(progress || 0)));
    const filled = Math.round(pct / 10);
    return "█".repeat(filled) + "░".repeat(10 - filled);
}

async function editorCommand(sock, msg, text) {
    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const trimmed = String(text || "").trim();

    if (/^\.queue\s*$/i.test(trimmed)) {
        const jobs = listJobs({ ownerId: sender, limit: 10 });

        if (!jobs.length) {
            return sock.sendMessage(
                chatId,
                { text: "🎬 You don't have any Zorex Editor jobs yet." },
                { quoted: msg }
            );
        }

        const lines = jobs.map(job =>
            `${statusIcon(job.status)} *${job.id}* — ${job.type}\n` +
            `   ${progressBar(job.progress)} ${Math.round(Number(job.progress || 0))}% • ${job.stage || job.status}`
        );

        return sock.sendMessage(
            chatId,
            { text: "🎬 *Zorex Editor Queue*\n\n" + lines.join("\n\n") },
            { quoted: msg }
        );
    }

    const cancelMatch =
        trimmed.match(
            /^\.queue\s+cancel\s+(ZRX-[A-F0-9]+)$/i
        );
    if (cancelMatch) {
        const result = cancelJob(cancelMatch[1], sender);

        if (result === false) {
            return sock.sendMessage(
                chatId,
                { text: "❌ That editor job doesn't belong to you." },
                { quoted: msg }
            );
        }

        if (!result) {
            return sock.sendMessage(
                chatId,
                { text: "⚠️ Editor job not found." },
                { quoted: msg }
            );
        }

        return sock.sendMessage(
            chatId,
            { text: `🚫 *${result.id}* cancelled.` },
            { quoted: msg }
        );
    }

    const jobMatch =
        trimmed.match(
            /^\.queue\s+(ZRX-[A-F0-9]+)$/i
        );
    if (!jobMatch) {
        return sock.sendMessage(
            chatId,
            {
                text:
`⚠️ Zorex Editor commands:

.queue
.queue ZRX-ABC123
.queue cancel ZRX-ABC123`
            },
            { quoted: msg }
        );
    }

    const job = getJob(jobMatch[1]);

    if (!job || job.ownerId !== String(sender)) {
        return sock.sendMessage(
            chatId,
            { text: "⚠️ Editor job not found." },
            { quoted: msg }
        );
    }

    const summary =
`${statusIcon(job.status)} *${job.id}*
Task: ${job.type}
Status: ${job.status}
${progressBar(job.progress)} ${Math.round(Number(job.progress || 0))}%
Stage: ${job.stage || "-"}
Worker: ${job.workerId || "waiting"}
Created: ${job.createdAt}
${job.error ? `Error: ${job.error}` : ""}`;

    await sock.sendMessage(
        chatId,
        { text: summary },
        { quoted: msg }
    );

    if (job.status === "completed" && job.outputName) {
        const outputPath = path.join(JOBS_DIR, job.id, job.outputName);

        if (fs.existsSync(outputPath)) {

            if (
                String(
                    job.outputMimeType ||
                    ""
                )
                    .toLowerCase()
                    .includes(
                        "json"
                    )
            ) {
                try {
                    const result =
                        JSON.parse(
                            fs.readFileSync(
                                outputPath,
                                "utf8"
                            )
                        );

                    const styles =
                        Array.isArray(
                            result.styleFamilies
                        ) &&
                        result.styleFamilies.length
                            ? result.styleFamilies
                                .join(", ")
                            : "No confident style family yet";

                    const fingerprintId =
                        job.analysisFingerprintId ||
                        job.checkpoint
                            ?.fingerprintId ||
                        "saved";

                    await sock.sendMessage(
                        chatId,
                        {
                            text:
                                "🧠 *Zorex Reference Analysis*\n\n" +
                                "Fingerprint: *" +
                                fingerprintId +
                                "*\n" +
                                "Styles: " +
                                styles +
                                "\n\n" +
                                String(
                                    result.summary ||
                                    "Analysis completed."
                                ) +
                                "\n\n" +
                                "Beat sync: " +
                                Math.round(
                                    Number(
                                        result.metrics
                                            ?.beatSyncRatio ||
                                        0
                                    ) *
                                    100
                                ) +
                                "%\n" +
                                "Cut candidates: " +
                                Number(
                                    result.evidence
                                        ?.cutTimes
                                        ?.length ||
                                    0
                                ) +
                                "\n" +
                                "Motion peaks: " +
                                Number(
                                    result.evidence
                                        ?.visualPeakTimes
                                        ?.length ||
                                    0
                                ) +
                                "\n" +
                                "Possible reverse regions: " +
                                Number(
                                    result.evidence
                                        ?.reverseCandidates
                                        ?.length ||
                                    0
                                )
                        },
                        {
                            quoted:
                                msg
                        }
                    );

                } catch (err) {
                    console.error(
                        "[.queue] failed to read JSON editor result:",
                        err.message
                    );
                }

            } else {

                await sock.sendMessage(
                    chatId,
                    {
                        video: { url: outputPath },
                        mimetype: job.outputMimeType || "video/mp4",
                        caption: `🎬 *${job.id}* result`
                    },
                    { quoted: msg }
                );

            }
        }
    }
}

module.exports = {
    editorCommand
};
