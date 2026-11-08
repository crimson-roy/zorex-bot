"use strict";

const fs = require("node:fs");
const path = require("node:path");

const POS = ["noun", "verb", "adj", "adv"];
const POS_LABELS = { noun: "noun", verb: "verb", adj: "adjective", adv: "adverb" };

function candidateDirectories() {
    const candidates = [];
    if (process.env.WORDNET_DICT_DIR) candidates.push(process.env.WORDNET_DICT_DIR);

    if (process.platform === "win32") {
        candidates.push(
            "C:\\Program Files (x86)\\WordNet\\2.1\\dict",
            "C:\\Program Files\\WordNet\\2.1\\dict",
            "C:\\Program Files (x86)\\WordNet\\3.0\\dict",
            "C:\\Program Files\\WordNet\\3.0\\dict"
        );
    } else {
        candidates.push(
            "/usr/local/WordNet-2.1/dict",
            "/usr/local/WordNet-3.0/dict",
            "/usr/share/wordnet"
        );
    }

    return [...new Set(candidates.map(value => path.resolve(value)))];
}

function isDictionaryDirectory(directory) {
    return Boolean(
        directory &&
        fs.existsSync(path.join(directory, "index.noun")) &&
        fs.existsSync(path.join(directory, "data.noun"))
    );
}

function resolveDictionaryDirectory(explicitDirectory) {
    if (explicitDirectory) {
        const resolved = path.resolve(explicitDirectory);
        return isDictionaryDirectory(resolved) ? resolved : null;
    }

    return candidateDirectories().find(isDictionaryDirectory) || null;
}

function normalizeLemma(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_'-]/g, "");
}

function editDistanceAtMostOne(left, right) {
    if (Math.abs(left.length - right.length) > 1) return false;

    let i = 0;
    let j = 0;
    let edits = 0;

    while (i < left.length && j < right.length) {
        if (left[i] === right[j]) {
            i += 1;
            j += 1;
            continue;
        }

        edits += 1;
        if (edits > 1) return false;

        if (left.length > right.length) i += 1;
        else if (right.length > left.length) j += 1;
        else {
            i += 1;
            j += 1;
        }
    }

    if (i < left.length || j < right.length) edits += 1;
    return edits <= 1;
}

class WordNetDictionary {
    constructor(options = {}) {
        this.dictDir = resolveDictionaryDirectory(options.dictDir);
        this.indexCache = new Map();
        this.dataCache = new Map();
        this.exceptionCache = new Map();
        this.lemmaCache = null;
    }

    isAvailable() {
        return isDictionaryDirectory(this.dictDir);
    }

    getDirectory() {
        return this.dictDir;
    }

    loadIndex(pos) {
        if (this.indexCache.has(pos)) return this.indexCache.get(pos);

        const entries = new Map();
        if (!this.dictDir) {
            this.indexCache.set(pos, entries);
            return entries;
        }

        const file = path.join(this.dictDir, `index.${pos}`);
        if (!fs.existsSync(file)) {
            this.indexCache.set(pos, entries);
            return entries;
        }

        const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
        for (const line of lines) {
            if (!line || line.startsWith("  ")) continue;
            const fields = line.trim().split(/\s+/);
            if (fields.length < 6) continue;

            const synsetCount = Number.parseInt(fields[2], 10);
            const pointerCount = Number.parseInt(fields[3], 10);
            if (!Number.isInteger(synsetCount) || !Number.isInteger(pointerCount)) continue;

            const offsetStart = 6 + pointerCount;
            const offsets = fields.slice(offsetStart, offsetStart + synsetCount);
            if (offsets.length === synsetCount) entries.set(fields[0], offsets);
        }

        this.indexCache.set(pos, entries);
        return entries;
    }

    loadData(pos) {
        if (this.dataCache.has(pos)) return this.dataCache.get(pos);

        const entries = new Map();
        if (this.dictDir) {
            const file = path.join(this.dictDir, `data.${pos}`);
            if (fs.existsSync(file)) {
                const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
                for (const line of lines) {
                    if (!/^\d{8}\s/.test(line)) continue;
                    entries.set(line.slice(0, 8), line);
                }
            }
        }

        this.dataCache.set(pos, entries);
        return entries;
    }

    loadExceptions(pos) {
        if (this.exceptionCache.has(pos)) return this.exceptionCache.get(pos);

        const entries = new Map();
        if (this.dictDir) {
            const file = path.join(this.dictDir, `${pos}.exc`);
            if (fs.existsSync(file)) {
                for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
                    const fields = line.trim().split(/\s+/).filter(Boolean);
                    if (fields.length > 1) entries.set(fields[0], fields.slice(1));
                }
            }
        }

        this.exceptionCache.set(pos, entries);
        return entries;
    }

    morphologicalForms(lemma, pos) {
        const forms = [];
        const exceptions = this.loadExceptions(pos).get(lemma) || [];
        forms.push(...exceptions);

        const rules = {
            noun: [
                [/s$/, ""], [/ses$/, "s"], [/xes$/, "x"], [/zes$/, "z"],
                [/ches$/, "ch"], [/shes$/, "sh"], [/men$/, "man"], [/ies$/, "y"]
            ],
            verb: [
                [/s$/, ""], [/ies$/, "y"], [/es$/, "e"], [/es$/, ""],
                [/ed$/, "e"], [/ed$/, ""], [/ing$/, "e"], [/ing$/, ""]
            ],
            adj: [[/er$/, ""], [/est$/, ""], [/er$/, "e"], [/est$/, "e"]],
            adv: []
        };

        for (const [pattern, replacement] of rules[pos] || []) {
            if (pattern.test(lemma)) forms.push(lemma.replace(pattern, replacement));
        }

        return [...new Set(forms.filter(Boolean).filter(form => form !== lemma))];
    }

    parseSynset(line, pos) {
        if (!line) return null;
        const divider = line.indexOf("|");
        if (divider < 0) return null;

        const header = line.slice(0, divider).trim().split(/\s+/);
        const wordCount = Number.parseInt(header[3], 16);
        if (!Number.isInteger(wordCount) || wordCount < 1) return null;

        const words = [];
        for (let i = 0; i < wordCount; i += 1) {
            const raw = header[4 + (i * 2)];
            if (!raw) continue;
            words.push(raw.replace(/\([^)]*\)$/, "").replace(/_/g, " "));
        }

        return {
            pos: POS_LABELS[pos] || pos,
            synonyms: words,
            definition: line.slice(divider + 1).trim()
        };
    }

    lookupExact(lemma) {
        const senses = [];

        for (const pos of POS) {
            const offsets = this.loadIndex(pos).get(lemma);
            if (!offsets) continue;

            const data = this.loadData(pos);
            for (const offset of offsets) {
                const sense = this.parseSynset(data.get(offset), pos);
                if (sense) senses.push(sense);
            }
        }

        return senses;
    }

    findSuggestion(lemma) {
        if (lemma.length < 5) return null;
        const prefix = lemma.slice(0, Math.min(4, lemma.length));
        const matches = [];

        for (const pos of POS) {
            for (const candidate of this.loadIndex(pos).keys()) {
                if (candidate === lemma) continue;
                if (!candidate.startsWith(prefix)) continue;
                if (!editDistanceAtMostOne(lemma, candidate)) continue;
                matches.push(candidate);
                if (matches.length > 4) return null;
            }
        }

        const unique = [...new Set(matches)];
        return unique.length === 1 ? unique[0] : null;
    }

    searchWords(options = {}) {
        if (!this.isAvailable()) return { available: false, words: [] };

        const count = Math.max(1, Math.min(1000, Number.parseInt(options.count, 10) || 5));
        const length = Number.parseInt(options.length, 10) || null;
        const minLength = Math.max(1, Math.min(64, Number.parseInt(options.minLength, 10) || 3));
        const startsWith = String(options.startsWith || "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 1);
        const candidates = new Set();

        for (const pos of POS) {
            for (const lemma of this.loadIndex(pos).keys()) {
                if (!/^[a-z]+$/.test(lemma)) continue;
                if (length && lemma.length !== length) continue;
                if (!length && lemma.length < minLength) continue;
                if (startsWith && !lemma.startsWith(startsWith)) continue;
                candidates.add(lemma);
            }
        }

        const words = [];
        for (const lemma of [...candidates].sort()) {
            const senses = this.lookupExact(lemma);
            if (!senses.length) continue;
            words.push({
                word: lemma,
                senses: senses.slice(0, 3)
            });
            if (words.length >= count) break;
        }

        return { available: true, words };
    }

    lookup(term) {
        if (!this.isAvailable()) {
            return { available: false, lemma: normalizeLemma(term), senses: [] };
        }

        const requested = normalizeLemma(term);
        if (!requested || requested.length > 64) {
            return { available: true, lemma: requested, senses: [] };
        }

        let senses = this.lookupExact(requested);
        if (senses.length) {
            return { available: true, lemma: requested.replace(/_/g, " "), senses, corrected: false };
        }

        for (const pos of POS) {
            for (const form of this.morphologicalForms(requested, pos)) {
                senses = this.lookupExact(form);
                if (senses.length) {
                    return { available: true, lemma: form.replace(/_/g, " "), senses, corrected: true, requested: requested.replace(/_/g, " ") };
                }
            }
        }

        const suggestion = this.findSuggestion(requested);
        if (suggestion) {
            senses = this.lookupExact(suggestion);
            if (senses.length) {
                return {
                    available: true,
                    lemma: suggestion.replace(/_/g, " "),
                    senses,
                    corrected: true,
                    requested: requested.replace(/_/g, " ")
                };
            }
        }

        return { available: true, lemma: requested.replace(/_/g, " "), senses: [] };
    }
}

module.exports = {
    WordNetDictionary,
    resolveDictionaryDirectory,
    isDictionaryDirectory,
    normalizeLemma,
    editDistanceAtMostOne
};
