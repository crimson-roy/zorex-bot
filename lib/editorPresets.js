"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dataPath = require("./dataPath");

const PRESET_ROOT = dataPath("editor/presets");
const INDEX_FILE = path.join(PRESET_ROOT, "index.json");

function ensure() {
    fs.mkdirSync(PRESET_ROOT, { recursive: true });
    if (!fs.existsSync(INDEX_FILE)) {
        atomicWrite(INDEX_FILE, { presets: [] });
    }
}

function atomicWrite(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
}

function loadIndex() {
    ensure();
    try {
        const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
        return { presets: Array.isArray(parsed.presets) ? parsed.presets : [] };
    } catch (_) {
        return { presets: [] };
    }
}

function cleanName(value) {
    return String(value || "")
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
}

function makeId() {
    return "ZRP-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function presetFile(id) {
    return path.join(PRESET_ROOT, `${id}.json`);
}

/**
 * Presets intentionally store edit instructions rather than source media.
 * A clip preset can therefore be applied to another video later.
 */
function savePreset({
    ownerId,
    name,
    scope = "clip",
    payload,
    description = ""
}) {
    ensure();

    const safeName = cleanName(name);
    if (!safeName) throw new Error("Preset name is required.");

    const normalizedScope = String(scope || "clip").toLowerCase();
    if (!["clip", "track", "timeline"].includes(normalizedScope)) {
        throw new Error("Preset scope must be clip, track, or timeline.");
    }

    if (!payload || typeof payload !== "object") {
        throw new Error("Preset payload must be an object.");
    }

    const now = new Date().toISOString();
    const preset = {
        id: makeId(),
        ownerId: String(ownerId || ""),
        name: safeName,
        description: cleanName(description),
        scope: normalizedScope,
        version: 1,
        createdAt: now,
        updatedAt: now,
        payload: JSON.parse(JSON.stringify(payload))
    };

    atomicWrite(presetFile(preset.id), preset);

    const index = loadIndex();
    index.presets.unshift({
        id: preset.id,
        ownerId: preset.ownerId,
        name: preset.name,
        scope: preset.scope,
        updatedAt: preset.updatedAt
    });
    atomicWrite(INDEX_FILE, index);

    return preset;
}

function getPreset(id, ownerId = null) {
    const file = presetFile(String(id || "").toUpperCase());
    if (!fs.existsSync(file)) return null;

    try {
        const preset = JSON.parse(fs.readFileSync(file, "utf8"));
        if (ownerId && preset.ownerId !== String(ownerId)) return false;
        return preset;
    } catch (_) {
        return null;
    }
}

function listPresets(ownerId, limit = 20) {
    const index = loadIndex();
    return index.presets
        .filter(item => !ownerId || item.ownerId === String(ownerId))
        .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)))
        .map(item => getPreset(item.id))
        .filter(Boolean);
}

function deletePreset(id, ownerId = null) {
    const preset = getPreset(id, ownerId);
    if (!preset) return preset;

    const file = presetFile(preset.id);
    if (fs.existsSync(file)) fs.unlinkSync(file);

    const index = loadIndex();
    index.presets = index.presets.filter(item => item.id !== preset.id);
    atomicWrite(INDEX_FILE, index);

    return true;
}

ensure();

module.exports = {
    PRESET_ROOT,
    savePreset,
    getPreset,
    listPresets,
    deletePreset
};
