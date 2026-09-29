"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dataPath = require("./dataPath");

const ROOT = dataPath("editor");
const JOBS_DIR = path.join(ROOT, "jobs");
const INDEX_FILE = path.join(ROOT, "jobs.json");

function ensureDirs() {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    if (!fs.existsSync(INDEX_FILE)) {
        atomicWriteJson(INDEX_FILE, { jobs: [] });
    }
}

function atomicWriteJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp-" + process.pid + "-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, filePath);
}

function loadIndex() {
    ensureDirs();
    try {
        const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
        return {
            jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
        };
    } catch (err) {
        console.error("[EDITOR JOBS] failed to read index:", err.message);
        return { jobs: [] };
    }
}

function saveIndex(index) {
    atomicWriteJson(INDEX_FILE, index);
}

function makeId() {
    return "ZRX-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

function jobDir(id) {
    return path.join(JOBS_DIR, id);
}

function extensionFromMime(mimeType) {
    const mime = String(mimeType || "").toLowerCase();
    if (mime.includes("webm")) return ".webm";
    if (mime.includes("quicktime")) return ".mov";
    if (mime.includes("matroska")) return ".mkv";
    return ".mp4";
}

function writeJobFile(job) {
    atomicWriteJson(path.join(jobDir(job.id), "job.json"), job);
}

function createJob({
    type,
    ownerId,
    chatId,
    inputBuffer,
    mimeType = "video/mp4",
    options = {},
    requirements = {},
    sourceMessageId = null
}) {
    if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
        throw new Error("createJob requires a non-empty inputBuffer");
    }

    ensureDirs();

    let id;
    do {
        id = makeId();
    } while (fs.existsSync(jobDir(id)));

    const dir = jobDir(id);
    fs.mkdirSync(dir, { recursive: true });

    const inputName = "input" + extensionFromMime(mimeType);
    const inputPath = path.join(dir, inputName);
    fs.writeFileSync(inputPath, inputBuffer);

    const now = new Date().toISOString();
    const job = {
        id,
        type: String(type),
        status: "queued",
        ownerId: String(ownerId || ""),
        chatId: String(chatId || ""),
        sourceMessageId: sourceMessageId || null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
        workerId: null,
        progress: 0,
        stage: "queued",
        checkpoint: null,
        error: null,
        mimeType,
        inputName,
        outputName: null,
        options,
        requirements: {
            gpu: Boolean(requirements.gpu),
            minVramGb: Number(requirements.minVramGb || 0),
            capabilities: Array.isArray(requirements.capabilities)
                ? requirements.capabilities.map(String)
                : []
        }
    };

    writeJobFile(job);

    const index = loadIndex();
    index.jobs.unshift({
        id: job.id,
        type: job.type,
        status: job.status,
        ownerId: job.ownerId,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt
    });
    saveIndex(index);

    console.log("[EDITOR JOBS] created", {
        id: job.id,
        type: job.type,
        requirements: job.requirements
    });

    return job;
}

function getJob(id) {
    if (!id) return null;
    const file = path.join(jobDir(String(id).toUpperCase()), "job.json");
    if (!fs.existsSync(file)) return null;

    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
        console.error("[EDITOR JOBS] failed to read job", id, err.message);
        return null;
    }
}

function updateIndexSummary(job) {
    const index = loadIndex();
    const row = index.jobs.find(item => item.id === job.id);
    if (row) {
        row.status = job.status;
        row.updatedAt = job.updatedAt;
    } else {
        index.jobs.unshift({
            id: job.id,
            type: job.type,
            status: job.status,
            ownerId: job.ownerId,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt
        });
    }
    saveIndex(index);
}

function updateJob(id, patch) {
    const job = getJob(id);
    if (!job) return null;

    Object.assign(job, patch || {});
    job.updatedAt = new Date().toISOString();

    writeJobFile(job);
    updateIndexSummary(job);
    return job;
}

function listJobs({ ownerId = null, limit = 10 } = {}) {
    const index = loadIndex();
    const rows = ownerId
        ? index.jobs.filter(row => row.ownerId === String(ownerId))
        : index.jobs;

    return rows
        .slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)))
        .map(row => getJob(row.id))
        .filter(Boolean);
}

function workerCanRun(job, worker = {}) {
    const caps = Array.isArray(worker.capabilities)
        ? worker.capabilities.map(value => String(value).toLowerCase())
        : [];

    if (job.requirements?.gpu && !worker.gpu) return false;

    if (
        Number(job.requirements?.minVramGb || 0) > 0 &&
        Number(worker.vramGb || 0) < Number(job.requirements.minVramGb)
    ) {
        return false;
    }

    const requiredCaps = Array.isArray(job.requirements?.capabilities)
        ? job.requirements.capabilities.map(value => String(value).toLowerCase())
        : [];

    return requiredCaps.every(cap => caps.includes(cap));
}

function claimNextJob(
    worker = {},
    {
        activeWorkers = [],
        startupGraceUntil = 0
    } = {}
) {
    const workerPriority =
        Number(worker.priority || 0);

    const jobs = listJobs({ limit: 50 })
        .filter(job => job.status === "queued")
        .reverse();

    const job = jobs.find(candidate => {
        if (!workerCanRun(candidate, worker)) {
            return false;
        }

        // After a VPS restart, give preferred workers a short chance to
        // reconnect before a deliberately-low-priority fallback claims.
        if (
            Date.now() < Number(startupGraceUntil || 0) &&
            workerPriority < 50
        ) {
            return false;
        }

        const betterWorkerOnline =
            activeWorkers.some(other => {
                if (!other) return false;
                if (String(other.workerId) === String(worker.workerId)) {
                    return false;
                }

                const otherPriority =
                    Number(other.priority || 0);

                return (
                    otherPriority > workerPriority &&
                    workerCanRun(candidate, other)
                );
            });

        return !betterWorkerOnline;
    });

    if (!job) return null;

    return updateJob(job.id, {
        status: "processing",
        workerId: String(worker.workerId || "unknown-worker"),
        workerPriority,
        startedAt: job.startedAt || new Date().toISOString(),
        stage: "claimed"
    });
}

function inputPathFor(job) {
    return path.join(jobDir(job.id), job.inputName);
}

function outputPathFor(job, mimeType = "video/mp4") {
    const name = "output" + extensionFromMime(mimeType);
    return {
        name,
        path: path.join(jobDir(job.id), name)
    };
}

function cancelJob(id, ownerId = null) {
    const job = getJob(id);
    if (!job) return null;
    if (ownerId && job.ownerId !== String(ownerId)) return false;

    return updateJob(job.id, {
        status: "cancelled",
        stage: "cancelled",
        workerId: null
    });
}

function recoverInterruptedJobs() {
    const jobs = listJobs({ limit: 50 });
    let recovered = 0;

    for (const job of jobs) {
        if (job.status === "processing") {
            updateJob(job.id, {
                status: "queued",
                stage: "recovered-after-restart",
                workerId: null
            });
            recovered++;
        }
    }

    if (recovered) {
        console.log("[EDITOR JOBS] recovered interrupted jobs:", recovered);
    }

    return recovered;
}

ensureDirs();

module.exports = {
    ROOT,
    JOBS_DIR,
    createJob,
    getJob,
    updateJob,
    listJobs,
    claimNextJob,
    workerCanRun,
    inputPathFor,
    outputPathFor,
    cancelJob,
    recoverInterruptedJobs
};
