"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_ACCOUNT_QUOTA_BYTES = 512 * 1024 * 1024;
const DEFAULT_GLOBAL_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const PREVIEWABLE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

function accountKey(subject) {
    return crypto.createHash("sha256").update(String(subject)).digest("hex");
}

function positiveLimit(value, fallback, maximum) {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function safeFileName(value) {
    let name = typeof value === "string" ? value : "";
    try { name = decodeURIComponent(name); } catch { /* Keep the original header value. */ }
    name = name.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/\s+/g, " ").replace(/^\.+/, "").trim().slice(0, 140);
    return name || "uploaded-file";
}

function safeMimeType(value) {
    const mime = typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : "";
    return /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/.test(mime)
        ? mime
        : "application/octet-stream";
}

function fileError(message, statusCode) {
    return Object.assign(new Error(message), { statusCode });
}

function sumFiles(files) {
    return files.reduce((sum, file) => sum + (Number.isSafeInteger(file.size) && file.size > 0 ? file.size : 0), 0);
}

function createAriLibraryStore(options = {}) {
    const fsImpl = options.fs || fs;
    const fsp = fsImpl.promises;
    const now = options.now || (() => Date.now());
    const dataDir = path.resolve(options.dataDir || path.join(__dirname, "..", "data"));
    const libraryDir = path.join(dataDir, "ariLibrary");
    const stagingDir = path.join(libraryDir, ".staging");
    const metadataPath = path.join(dataDir, "ariLibrary.json");
    const maxFileBytes = positiveLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES);
    const quotaBytes = positiveLimit(options.quotaBytes, DEFAULT_ACCOUNT_QUOTA_BYTES, 10 * 1024 * 1024 * 1024);
    const globalQuotaBytes = positiveLimit(options.globalQuotaBytes, DEFAULT_GLOBAL_QUOTA_BYTES, 20 * 1024 * 1024 * 1024);
    let queue = Promise.resolve();

    function readStore() {
        try {
            const parsed = JSON.parse(fsImpl.readFileSync(metadataPath, "utf8"));
            if (parsed && parsed.version === 1 && parsed.accounts &&
                typeof parsed.accounts === "object" && !Array.isArray(parsed.accounts)) {
                return parsed;
            }
            throw new Error("Unsupported Library data format.");
        } catch (error) {
            if (error.code === "ENOENT") return { version: 1, accounts: {} };
            throw new Error("Ari Library data could not be read safely.");
        }
    }

    function writeStore(store) {
        fsImpl.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        const temporary = metadataPath + ".tmp-" + process.pid + "-" + crypto.randomBytes(8).toString("hex");
        try {
            fsImpl.writeFileSync(temporary, JSON.stringify(store), { encoding: "utf8", mode: 0o600, flag: "wx" });
            fsImpl.renameSync(temporary, metadataPath);
            try { fsImpl.chmodSync(metadataPath, 0o600); } catch { /* Windows ACLs replace POSIX mode bits. */ }
        } catch (_) {
            try { fsImpl.rmSync(temporary, { force: true }); } catch { /* Ignore cleanup errors. */ }
            throw new Error("Ari Library data could not be saved safely.");
        }
    }

    function accountFiles(store, subject) {
        const account = store.accounts[accountKey(subject)];
        return account && Array.isArray(account.files) ? account.files : [];
    }

    function publicRecord(file) {
        return {
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            size: file.size,
            createdAt: file.createdAt
        };
    }

    function listFiles(subject) {
        if (typeof subject !== "string" || !subject.trim()) {
            throw fileError("A signed-in account is required.", 401);
        }
        const store = readStore();
        const files = accountFiles(store, subject).slice().sort((a, b) => b.createdAt - a.createdAt);
        const usedBytes = sumFiles(files);
        const globalUsedBytes = Object.values(store.accounts).reduce((sum, account) =>
            sum + (account && Array.isArray(account.files) ? sumFiles(account.files) : 0), 0);
        return {
            files: files.map(publicRecord),
            usedBytes,
            quotaBytes,
            remainingBytes: Math.max(0, quotaBytes - usedBytes),
            maxFileBytes,
            globalUsedBytes,
            globalQuotaBytes
        };
    }

    function getFile(subject, id) {
        if (typeof subject !== "string" || !subject.trim() ||
            typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
            return null;
        }
        const store = readStore();
        const file = accountFiles(store, subject).find(item => item.id === id);
        if (!file) return null;
        const filePath = path.join(libraryDir, accountKey(subject), id + ".bin");
        if (!fsImpl.existsSync(filePath)) return null;
        return { ...publicRecord(file), filePath, previewable: PREVIEWABLE_MIME_TYPES.has(file.mimeType) };
    }

    async function saveFile(subject, metadata, source, expectedSize) {
        if (typeof subject !== "string" || !subject.trim()) throw fileError("A signed-in account is required.", 401);
        if (!source || typeof source[Symbol.asyncIterator] !== "function") throw fileError("The file upload stream is invalid.", 400);
        if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) throw fileError("A valid file size is required.", 411);
        if (expectedSize > maxFileBytes) throw fileError("This file exceeds Ari's configured per-file limit.", 413);

        const name = safeFileName(metadata && metadata.name);
        const mimeType = safeMimeType(metadata && metadata.mimeType);
        fsImpl.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
        const temporaryPath = path.join(stagingDir, crypto.randomUUID() + ".upload");
        let actualSize = 0;
        let oversized = false;
        const handle = await fsp.open(temporaryPath, "wx", 0o600);
        try {
            for await (const chunk of source) {
                actualSize += chunk.length;
                if (actualSize > maxFileBytes) {
                    oversized = true;
                    continue;
                }
                let offset = 0;
                while (offset < chunk.length) {
                    const result = await handle.write(chunk, offset, chunk.length - offset, null);
                    if (!result.bytesWritten) throw new Error("The upload could not be written.");
                    offset += result.bytesWritten;
                }
            }
        } catch (error) {
            try { await handle.close(); } catch { /* Ignore close errors. */ }
            try { await fsp.rm(temporaryPath, { force: true }); } catch { /* Ignore cleanup errors. */ }
            throw error;
        }
        await handle.close();

        if (oversized || actualSize > maxFileBytes) {
            await fsp.rm(temporaryPath, { force: true });
            throw fileError("This file exceeds Ari's configured per-file limit.", 413);
        }
        if (actualSize !== expectedSize) {
            await fsp.rm(temporaryPath, { force: true });
            throw fileError("The uploaded file size did not match the request.", 400);
        }
        if (actualSize <= 0) {
            await fsp.rm(temporaryPath, { force: true });
            throw fileError("Empty files cannot be added to the Library.", 400);
        }

        const operation = queue.then(() => {
            const store = readStore();
            const key = accountKey(subject);
            const existing = store.accounts[key] && Array.isArray(store.accounts[key].files)
                ? store.accounts[key].files
                : [];
            const usedBytes = sumFiles(existing);
            const globalUsedBytes = Object.values(store.accounts).reduce((sum, account) =>
                sum + (account && Array.isArray(account.files) ? sumFiles(account.files) : 0), 0);
            if (usedBytes + actualSize > quotaBytes) {
                throw fileError("Your Ari Library storage limit has been reached. Delete a file or use a smaller upload.", 413);
            }
            if (globalUsedBytes + actualSize > globalQuotaBytes) {
                throw fileError("Ari's shared Library storage is temporarily full. Please try again later.", 507);
            }

            const id = crypto.randomUUID();
            const accountDirectory = path.join(libraryDir, key);
            const destination = path.join(accountDirectory, id + ".bin");
            fsImpl.mkdirSync(accountDirectory, { recursive: true, mode: 0o700 });
            fsImpl.renameSync(temporaryPath, destination);
            const record = { id, name, mimeType, size: actualSize, createdAt: now() };
            store.accounts[key] = {
                ...(store.accounts[key] && typeof store.accounts[key] === "object" ? store.accounts[key] : {}),
                files: [...existing, record]
            };
            try {
                writeStore(store);
            } catch (error) {
                try { fsImpl.rmSync(destination, { force: true }); } catch { /* Ignore cleanup errors. */ }
                throw error;
            }
            return publicRecord(record);
        });
        queue = operation.catch(() => undefined);
        try {
            return await operation;
        } catch (error) {
            try { await fsp.rm(temporaryPath, { force: true }); } catch { /* Ignore cleanup errors. */ }
            throw error;
        }
    }

    function deleteFile(subject, id) {
        if (typeof subject !== "string" || !subject.trim()) {
            return Promise.reject(fileError("A signed-in account is required.", 401));
        }
        const operation = queue.then(() => {
            if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
                throw fileError("That Library file could not be found.", 404);
            }
            const store = readStore();
            const key = accountKey(subject);
            const account = store.accounts[key];
            const files = account && Array.isArray(account.files) ? account.files : [];
            const record = files.find(file => file.id === id);
            if (!record) throw fileError("That Library file could not be found.", 404);
            store.accounts[key] = { ...account, files: files.filter(file => file.id !== id) };
            writeStore(store);
            const filePath = path.join(libraryDir, key, id + ".bin");
            try { fsImpl.rmSync(filePath, { force: true }); } catch { /* Metadata removal prevents future access. */ }
            return publicRecord(record);
        });
        queue = operation.catch(() => undefined);
        return operation;
    }

    return {
        listFiles,
        getFile,
        saveFile,
        deleteFile,
        dataDir,
        libraryDir,
        metadataPath,
        maxFileBytes,
        quotaBytes,
        globalQuotaBytes
    };
}

module.exports = {
    createAriLibraryStore,
    safeFileName,
    safeMimeType,
    DEFAULT_MAX_FILE_BYTES,
    DEFAULT_ACCOUNT_QUOTA_BYTES,
    DEFAULT_GLOBAL_QUOTA_BYTES,
    PREVIEWABLE_MIME_TYPES
};
