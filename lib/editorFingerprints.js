"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dataPath = require("./dataPath");

const ROOT = dataPath("editor/fingerprints");
const INDEX_FILE = path.join(ROOT, "index.json");

function ensure() {
    fs.mkdirSync(ROOT, { recursive: true });
    if (!fs.existsSync(INDEX_FILE)) {
        fs.writeFileSync(
            INDEX_FILE,
            JSON.stringify({ fingerprints: [] }, null, 2)
        );
    }
}

function atomicWrite(file, value) {
    const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
}

function clean(value, max = 1000) {
    return String(value || "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max);
}

function makeId() {
    return "ZRF-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function fileFor(id) {
    return path.join(ROOT, String(id).toUpperCase() + ".json");
}

function loadIndex() {
    ensure();
    try {
        const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
        return {
            fingerprints: Array.isArray(parsed.fingerprints)
                ? parsed.fingerprints
                : []
        };
    } catch (_) {
        return { fingerprints: [] };
    }
}

function saveFingerprint({
    ownerId,
    label = "",
    sourceJobId = null,
    fingerprint
}) {
    if (!fingerprint || typeof fingerprint !== "object") {
        throw new Error("Fingerprint payload is required.");
    }

    const now = new Date().toISOString();
    const item = {
        id: makeId(),
        ownerId: String(ownerId || ""),
        label: clean(label, 160),
        sourceJobId: sourceJobId || null,
        version: 1,
        createdAt: now,
        updatedAt: now,
        fingerprint: JSON.parse(JSON.stringify(fingerprint))
    };

    atomicWrite(fileFor(item.id), item);

    const index = loadIndex();
    index.fingerprints.unshift({
        id: item.id,
        ownerId: item.ownerId,
        label: item.label,
        sourceJobId: item.sourceJobId,
        createdAt: item.createdAt
    });
    atomicWrite(INDEX_FILE, index);

    return item;
}

function getFingerprint(id, ownerId = null) {
    const file = fileFor(id);
    if (!fs.existsSync(file)) return null;

    try {
        const item = JSON.parse(fs.readFileSync(file, "utf8"));
        if (ownerId && item.ownerId !== String(ownerId)) return false;
        return item;
    } catch (_) {
        return null;
    }
}

function listFingerprints(ownerId, limit = 20) {
    return loadIndex()
        .fingerprints
        .filter(row => !ownerId || row.ownerId === String(ownerId))
        .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)))
        .map(row => getFingerprint(row.id))
        .filter(Boolean);
}

function searchFingerprints(ownerId, query, limit = 10) {
    const terms = clean(query, 500)
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);

    return listFingerprints(ownerId, 100)
        .map(item => {
            const f = item.fingerprint || {};
            const haystack = [
                item.label,
                ...(f.tags || []),
                ...(f.styleFamilies || []),
                f.summary || ""
            ].join(" ").toLowerCase();

            return {
                item,
                score: terms.reduce(
                    (sum, term) => sum + (haystack.includes(term) ? 1 : 0),
                    0
                )
            };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)))
        .map(x => x.item);
}

ensure();

module.exports = {
    ROOT,
    saveFingerprint,
    getFingerprint,
    listFingerprints,
    searchFingerprints
};
