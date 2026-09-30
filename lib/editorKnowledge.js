"use strict";

const fs = require("fs");
const crypto = require("crypto");
const dataPath = require("./dataPath");

const KNOWLEDGE_FILE =
    dataPath("editor/editingKnowledge.json");

function ensureFile() {
    if (!fs.existsSync(KNOWLEDGE_FILE)) {
        fs.writeFileSync(
            KNOWLEDGE_FILE,
            JSON.stringify(
                {
                    version: 1,
                    entries: []
                },
                null,
                2
            )
        );
    }
}

function loadStore() {
    ensureFile();

    try {
        const parsed =
            JSON.parse(
                fs.readFileSync(
                    KNOWLEDGE_FILE,
                    "utf8"
                )
            );

        return {
            version:
                Number(parsed.version || 1),
            entries:
                Array.isArray(parsed.entries)
                    ? parsed.entries
                    : []
        };

    } catch (_) {

        return {
            version: 1,
            entries: []
        };

    }
}

function saveStore(store) {
    const temp =
        KNOWLEDGE_FILE +
        ".tmp-" +
        process.pid +
        "-" +
        Date.now();

    fs.writeFileSync(
        temp,
        JSON.stringify(
            store,
            null,
            2
        )
    );

    fs.renameSync(
        temp,
        KNOWLEDGE_FILE
    );
}

function cleanText(value, max = 4000) {
    return String(value || "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max);
}

function normalizeTags(tags) {
    return [
        ...new Set(
            (Array.isArray(tags) ? tags : [])
                .map(tag =>
                    cleanText(tag, 60)
                        .toLowerCase()
                )
                .filter(Boolean)
        )
    ].slice(0, 32);
}

function addKnowledge({
    title,
    summary,
    rules = [],
    tags = [],
    toolMappings = [],
    source = {},
    confidence = 0.5,
    status = "candidate",
    authorId = ""
}) {
    const store =
        loadStore();

    const now =
        new Date()
            .toISOString();

    const entry = {
        id:
            "ZEK-" +
            crypto
                .randomBytes(4)
                .toString("hex")
                .toUpperCase(),
        title:
            cleanText(
                title,
                180
            ),
        summary:
            cleanText(
                summary,
                2500
            ),
        rules:
            (Array.isArray(rules) ? rules : [])
                .map(rule =>
                    cleanText(
                        rule,
                        1200
                    )
                )
                .filter(Boolean)
                .slice(0, 64),
        tags:
            normalizeTags(tags),
        toolMappings:
            (Array.isArray(toolMappings) ? toolMappings : [])
                .map(item =>
                    cleanText(
                        item,
                        300
                    )
                )
                .filter(Boolean)
                .slice(0, 64),
        source: {
            type:
                cleanText(
                    source.type,
                    40
                ),
            title:
                cleanText(
                    source.title,
                    240
                ),
            locator:
                cleanText(
                    source.locator,
                    800
                ),
            notes:
                cleanText(
                    source.notes,
                    800
                )
        },
        confidence:
            Math.max(
                0,
                Math.min(
                    1,
                    Number(confidence) ||
                    0
                )
            ),
        status:
            ["candidate", "validated", "deprecated"]
                .includes(
                    String(status)
                )
                    ? String(status)
                    : "candidate",
        authorId:
            cleanText(
                authorId,
                120
            ),
        createdAt:
            now,
        updatedAt:
            now
    };

    if (!entry.title || !entry.summary) {
        throw new Error(
            "Editing knowledge requires a title and summary."
        );
    }

    store.entries.unshift(
        entry
    );

    saveStore(
        store
    );

    return entry;
}

function listKnowledge({
    status = null,
    tag = null,
    limit = 50
} = {}) {
    const store =
        loadStore();

    let entries =
        store.entries;

    if (status) {
        entries =
            entries.filter(
                entry =>
                    entry.status ===
                    status
            );
    }

    if (tag) {
        const wanted =
            cleanText(
                tag,
                60
            )
                .toLowerCase();

        entries =
            entries.filter(
                entry =>
                    entry.tags
                        .includes(
                            wanted
                        )
            );
    }

    return entries.slice(
        0,
        Math.max(
            1,
            Math.min(
                Number(limit) ||
                50,
                500
            )
        )
    );
}

function searchKnowledge(query, limit = 10) {
    const terms =
        cleanText(
            query,
            500
        )
            .toLowerCase()
            .split(/\s+/)
            .filter(term =>
                term.length >= 2
            );

    if (!terms.length) {
        return [];
    }

    const scored =
        loadStore()
            .entries
            .filter(entry =>
                entry.status !==
                "deprecated"
            )
            .map(entry => {
                const haystack =
                    [
                        entry.title,
                        entry.summary,
                        ...(entry.rules || []),
                        ...(entry.tags || []),
                        ...(entry.toolMappings || [])
                    ]
                        .join(" ")
                        .toLowerCase();

                const score =
                    terms.reduce(
                        (sum, term) =>
                            sum +
                            (
                                haystack.includes(
                                    term
                                )
                                    ? 1
                                    : 0
                            ),
                        0
                    );

                return {
                    entry,
                    score
                };
            })
            .filter(item =>
                item.score > 0
            )
            .sort(
                (a, b) =>
                    b.score -
                    a.score ||
                    b.entry.confidence -
                    a.entry.confidence
            );

    return scored
        .slice(
            0,
            Math.max(
                1,
                Math.min(
                    Number(limit) ||
                    10,
                    50
                )
            )
        )
        .map(item =>
            item.entry
        );
}

function updateKnowledgeStatus(id, status) {
    if (
        !["candidate", "validated", "deprecated"]
            .includes(
                String(status)
            )
    ) {
        throw new Error(
            "Invalid editing knowledge status."
        );
    }

    const store =
        loadStore();

    const entry =
        store.entries
            .find(item =>
                item.id ===
                String(id)
                    .toUpperCase()
            );

    if (!entry) {
        return null;
    }

    entry.status =
        String(status);

    entry.updatedAt =
        new Date()
            .toISOString();

    saveStore(
        store
    );

    return entry;
}

ensureFile();

module.exports = {
    KNOWLEDGE_FILE,
    addKnowledge,
    listKnowledge,
    searchKnowledge,
    updateKnowledgeStatus
};
