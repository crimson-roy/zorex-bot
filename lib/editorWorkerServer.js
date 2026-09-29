"use strict";

const http = require("http");
const fs = require("fs");
const {
    getJob,
    updateJob,
    claimNextJob,
    inputPathFor,
    outputPathFor,
    recoverInterruptedJobs
} = require("./editorJobs");

let server = null;

function json(res, status, value) {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": body.length
    });
    res.end(body);
}

function unauthorized(res) {
    return json(res, 401, { error: "unauthorized" });
}

function tokenOk(req) {
    const expected = String(process.env.EDITOR_WORKER_TOKEN || "").trim();
    if (!expected) return false;

    const auth = String(req.headers.authorization || "");
    return auth === "Bearer " + expected;
}

async function readJson(req, maxBytes = 1024 * 1024) {
    const chunks = [];
    let size = 0;

    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) {
            throw new Error("request body too large");
        }
        chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? JSON.parse(raw) : {};
}

function publicJob(job) {
    if (!job) return null;
    return {
        id: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
        stage: job.stage,
        checkpoint: job.checkpoint,
        options: job.options,
        requirements: job.requirements,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt
    };
}

async function streamRequestToFile(req, filePath) {
    const out = fs.createWriteStream(filePath, { flags: "w" });

    try {
        for await (const chunk of req) {
            if (!out.write(chunk)) {
                await new Promise(resolve => out.once("drain", resolve));
            }
        }

        await new Promise((resolve, reject) => {
            out.end(resolve);
            out.on("error", reject);
        });
    } catch (err) {
        out.destroy();
        try { fs.unlinkSync(filePath); } catch (_) {}
        throw err;
    }
}

function startEditorWorkerServer() {
    if (server) return server;

    // Recover jobs independently of whether remote workers are enabled.
    // A bot restart must never leave an old "processing" job stuck forever.
    recoverInterruptedJobs();

    const token = String(process.env.EDITOR_WORKER_TOKEN || "").trim();

    if (!token) {
        console.log("[EDITOR WORKER API] disabled — set EDITOR_WORKER_TOKEN to enable remote workers");
        return null;
    }

    const port = Number(process.env.EDITOR_WORKER_PORT || 3210);
    const host = String(process.env.EDITOR_WORKER_HOST || "127.0.0.1");

    server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://worker.local");

            if (req.method === "GET" && url.pathname === "/health") {
                return json(res, 200, { ok: true, service: "zorex-editor-worker-api" });
            }

            if (!tokenOk(req)) {
                return unauthorized(res);
            }

            if (req.method === "POST" && url.pathname === "/api/jobs/claim") {
                const worker = await readJson(req);
                const job = claimNextJob(worker);

                return json(res, 200, {
                    job: publicJob(job)
                });
            }

            const inputMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/input$/);
            if (req.method === "GET" && inputMatch) {
                const job = getJob(inputMatch[1]);
                if (!job) return json(res, 404, { error: "job_not_found" });

                const inputPath = inputPathFor(job);
                if (!fs.existsSync(inputPath)) {
                    return json(res, 404, { error: "input_missing" });
                }

                const stat = fs.statSync(inputPath);
                res.writeHead(200, {
                    "Content-Type": job.mimeType || "application/octet-stream",
                    "Content-Length": stat.size
                });
                return fs.createReadStream(inputPath).pipe(res);
            }

            const progressMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/progress$/);
            if (req.method === "POST" && progressMatch) {
                const patch = await readJson(req);
                const job = getJob(progressMatch[1]);
                if (!job) return json(res, 404, { error: "job_not_found" });

                if (
                    job.workerId &&
                    patch.workerId &&
                    job.workerId !== String(patch.workerId)
                ) {
                    return json(res, 409, { error: "worker_mismatch" });
                }

                const progress = Math.max(
                    0,
                    Math.min(100, Number(patch.progress || 0))
                );

                const updated = updateJob(job.id, {
                    progress,
                    stage: String(patch.stage || job.stage || "processing"),
                    checkpoint:
                        patch.checkpoint === undefined
                            ? job.checkpoint
                            : patch.checkpoint
                });

                return json(res, 200, { job: publicJob(updated) });
            }

            const outputMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/output$/);
            if (req.method === "PUT" && outputMatch) {
                const job = getJob(outputMatch[1]);
                if (!job) return json(res, 404, { error: "job_not_found" });

                const mimeType = String(req.headers["content-type"] || "video/mp4");
                const output = outputPathFor(job, mimeType);

                await streamRequestToFile(req, output.path);

                const updated = updateJob(job.id, {
                    status: "completed",
                    progress: 100,
                    stage: "completed",
                    completedAt: new Date().toISOString(),
                    outputName: output.name,
                    outputMimeType: mimeType
                });

                console.log("[EDITOR WORKER API] job completed", {
                    id: job.id,
                    workerId: job.workerId
                });

                return json(res, 200, { job: publicJob(updated) });
            }

            const failMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/fail$/);
            if (req.method === "POST" && failMatch) {
                const body = await readJson(req);
                const job = getJob(failMatch[1]);
                if (!job) return json(res, 404, { error: "job_not_found" });

                const updated = updateJob(job.id, {
                    status: body.requeue ? "queued" : "failed",
                    stage: body.requeue ? "worker-requeued" : "failed",
                    workerId: body.requeue ? null : job.workerId,
                    error: String(body.error || "worker reported failure").slice(0, 2000)
                });

                return json(res, 200, { job: publicJob(updated) });
            }

            return json(res, 404, { error: "not_found" });
        } catch (err) {
            console.error("[EDITOR WORKER API] request failed:", err.message);
            return json(res, 500, { error: "internal_error", message: err.message });
        }
    });

    server.listen(port, host, () => {
        console.log("[EDITOR WORKER API] listening", { host, port });
    });

    return server;
}

module.exports = {
    startEditorWorkerServer
};
