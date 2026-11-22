"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_PROJECTS = 50;
const MAX_PROJECT_BYTES = 2 * 1024 * 1024;
const MAX_ACCOUNT_BYTES = 8 * 1024 * 1024;

function createZcutProjectStore(options = {}) {
    const fsImpl = options.fs || fs;
    const now = options.now || (() => Date.now());
    const storageDir = path.resolve(options.dataDir || path.join(__dirname, "..", "data"), "zcutProjects");
    let queue = Promise.resolve();

    function accountKey(subject) {
        if (typeof subject !== "string" || !subject.trim() || subject.length > 512) {
            throw new Error("A valid Zorex account is required.");
        }
        return crypto.createHash("sha256").update(subject).digest("hex");
    }

    function filePathFor(subject) {
        return path.join(storageDir, accountKey(subject) + ".json");
    }

    function readStore(filePath) {
        try {
            const value = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
            if (value && value.version === 1 && Array.isArray(value.projects)) return value;
            throw new Error("Unsupported Z_Cut project store.");
        } catch (error) {
            if (error.code === "ENOENT") return { version: 1, projects: [] };
            throw new Error("Z_Cut projects could not be read safely.");
        }
    }

    function writeStore(filePath, value) {
        const serialized = JSON.stringify(value);
        if (Buffer.byteLength(serialized, "utf8") > MAX_ACCOUNT_BYTES) {
            throw Object.assign(new Error("Your Z_Cut cloud project storage is full."), { statusCode: 413 });
        }
        fsImpl.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
        const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(8).toString("hex");
        try {
            fsImpl.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
            fsImpl.renameSync(temporary, filePath);
            try { fsImpl.chmodSync(filePath, 0o600); } catch {}
        } catch (error) {
            try { fsImpl.rmSync(temporary, { force: true }); } catch {}
            throw new Error("Z_Cut projects could not be saved safely.");
        }
    }

    function normalizeProject(input) {
        if (!input || typeof input !== "object" || Array.isArray(input) ||
            typeof input.id !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(input.id) ||
            !input.project || typeof input.project !== "object" || Array.isArray(input.project) ||
            !input.project.comps || typeof input.project.comps !== "object" || Array.isArray(input.project.comps)) {
            throw Object.assign(new Error("The Z_Cut project has an invalid format."), { statusCode: 400 });
        }
        const project = {
            id: input.id,
            name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : "Untitled project",
            currentComp: typeof input.currentComp === "string" ? input.currentComp.slice(0, 100) : "main",
            updatedAt: Number.isSafeInteger(input.updatedAt) && input.updatedAt > 0 ? input.updatedAt : now(),
            project: input.project,
            media: Array.isArray(input.media) ? input.media.slice(0, 500).map(item => {
                if (!item || typeof item !== "object" || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{4,100}$/.test(item.id)) return null;
                return {
                    id: item.id,
                    name: typeof item.name === "string" ? item.name.slice(0, 255) : "Missing media",
                    type: ["video", "audio", "image"].includes(item.type) ? item.type : "video",
                    duration: Number.isFinite(item.duration) ? Math.max(0, Math.min(item.duration, 86400)) : 0,
                    width: Number.isFinite(item.width) ? Math.max(0, Math.min(item.width, 16384)) : 0,
                    height: Number.isFinite(item.height) ? Math.max(0, Math.min(item.height, 16384)) : 0,
                    size: Number.isSafeInteger(item.size) && item.size >= 0 ? Math.min(item.size, 1024 * 1024 * 1024 * 1024) : 0,
                    lastModified: Number.isSafeInteger(item.lastModified) && item.lastModified >= 0 ? item.lastModified : 0
                };
            }).filter(Boolean) : []
        };
        const bytes = Buffer.byteLength(JSON.stringify(project), "utf8");
        if (bytes > MAX_PROJECT_BYTES) {
            throw Object.assign(new Error("This Z_Cut project is too large to sync. Save a local .zcut copy instead."), { statusCode: 413 });
        }
        return project;
    }

    function enqueue(fn) {
        const result = queue.then(fn);
        queue = result.catch(() => undefined);
        return result;
    }

    function listProjects(subject) {
        const filePath = filePathFor(subject);
        return enqueue(() => readStore(filePath).projects
            .slice().sort((a, b) => b.updatedAt - a.updatedAt)
            .map(({ id, name, currentComp, updatedAt, media }) => ({ id, name, currentComp, updatedAt, mediaCount: media.length })));
    }

    function getProject(subject, id) {
        const filePath = filePathFor(subject);
        return enqueue(() => {
            const item = readStore(filePath).projects.find(project => project.id === id);
            return item ? JSON.parse(JSON.stringify(item)) : null;
        });
    }

    function saveProject(subject, input) {
        const filePath = filePathFor(subject);
        return enqueue(() => {
            const project = normalizeProject(input);
            const store = readStore(filePath);
            const index = store.projects.findIndex(item => item.id === project.id);
            if (index < 0 && store.projects.length >= MAX_PROJECTS) {
                throw Object.assign(new Error("You have reached the 50-project cloud limit."), { statusCode: 413 });
            }
            if (index < 0) store.projects.push(project);
            else store.projects[index] = project;
            writeStore(filePath, { version: 1, projects: store.projects });
            return { id: project.id, name: project.name, updatedAt: project.updatedAt };
        });
    }

    function deleteProject(subject, id) {
        const filePath = filePathFor(subject);
        return enqueue(() => {
            const store = readStore(filePath);
            const projects = store.projects.filter(item => item.id !== id);
            if (projects.length === store.projects.length) return false;
            if (projects.length) writeStore(filePath, { version: 1, projects });
            else {
                try { fsImpl.rmSync(filePath, { force: true }); } catch { throw new Error("Z_Cut projects could not be deleted safely."); }
            }
            return true;
        });
    }

    return { listProjects, getProject, saveProject, deleteProject, filePathFor,
        limits: { maxProjects: MAX_PROJECTS, maxProjectBytes: MAX_PROJECT_BYTES, maxAccountBytes: MAX_ACCOUNT_BYTES } };
}

module.exports = { createZcutProjectStore };
