"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TASK_TYPES = new Set(["coding", "research", "writing", "explanation", "planning", "analysis", "general"]);
const SIGNALS = new Set([
    "clear_sections", "step_by_step", "examples", "concise", "detailed",
    "code_blocks", "source_links", "checklists", "tradeoffs", "summary_first"
]);

function accountKey(subject) {
    return crypto.createHash("sha256").update(String(subject)).digest("hex");
}

function classifyTask(value) {
    const text = String(value || "").toLowerCase();
    if (/\b(code|coding|program|javascript|python|debug|error|function|api|script|sql|git|terminal)\b/.test(text)) return "coding";
    if (/\b(research|sources|latest|current|compare|look up|search|evidence|citation)\b/.test(text)) return "research";
    if (/\b(write|draft|rewrite|email|essay|story|post|polish|proofread|caption)\b/.test(text)) return "writing";
    if (/\b(plan|schedule|roadmap|steps|organize|strategy|itinerary)\b/.test(text)) return "planning";
    if (/\b(analy[sz]e|analysis|evaluate|review|audit|diagnos|pros and cons)\b/.test(text)) return "analysis";
    if (/\b(explain|what is|how does|teach|understand|meaning|define)\b/.test(text)) return "explanation";
    return "general";
}

function responseSignals(value) {
    const text = String(value || "");
    const signals = [];
    if (/^#{1,3}\s|\n#{1,3}\s/m.test(text)) signals.push("clear_sections");
    if (/\n\s*(?:\d+[.)]|[-*])\s/m.test(text)) signals.push("step_by_step");
    if (/\bfor example\b|\be\.g\.\b|\bexample:\b/i.test(text)) signals.push("examples");
    if (text.length < 900) signals.push("concise");
    if (text.length > 1800) signals.push("detailed");
    if (/\x60{3}/.test(text)) signals.push("code_blocks");
    if (/https:\/\//i.test(text) || /\[[^\]]+\]\(https:\/\//i.test(text)) signals.push("source_links");
    if (/\[[ x]\]|\bchecklist\b/i.test(text)) signals.push("checklists");
    if (/\btrade[- ]?offs?\b|\badvantages?\b|\bdisadvantages?\b/i.test(text)) signals.push("tradeoffs");
    if (/^(?:#{1,3}\s*)?(?:summary|key takeaway|in brief|bottom line)\b/i.test(text.trim())) signals.push("summary_first");
    return signals;
}

function createAriExperienceStore(options = {}) {
    const fsImpl = options.fs || fs;
    const now = options.now || (() => Date.now());
    const directory = path.resolve(options.dataDir || path.join(__dirname, "..", "data"));
    const filePath = path.join(directory, "ariExperience.json");
    let queue = Promise.resolve();

    function readStore() {
        try {
            const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
            if (parsed && parsed.version === 1 && parsed.accounts &&
                typeof parsed.accounts === "object" && !Array.isArray(parsed.accounts)) return parsed;
            throw new Error("Unsupported Ari experience data format.");
        } catch (error) {
            if (error.code === "ENOENT") return { version: 1, accounts: {} };
            throw new Error("Ari experience data could not be read safely.");
        }
    }

    function writeStore(store) {
        fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporary = filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(8).toString("hex");
        try {
            fsImpl.writeFileSync(temporary, JSON.stringify(store), { encoding: "utf8", mode: 0o600, flag: "wx" });
            fsImpl.renameSync(temporary, filePath);
            try { fsImpl.chmodSync(filePath, 0o600); } catch { /* Windows ACLs replace POSIX mode bits. */ }
        } catch (_) {
            try { fsImpl.rmSync(temporary, { force: true }); } catch { /* Ignore cleanup errors. */ }
            throw new Error("Ari experience data could not be saved safely.");
        }
    }

    function recordFeedback(subject, input) {
        if (typeof subject !== "string" || !subject.trim()) {
            return Promise.reject(Object.assign(new Error("A signed-in account is required."), { statusCode: 401 }));
        }
        if (!input || typeof input !== "object" ||
            !["medium", "max"].includes(input.tier) ||
            !TASK_TYPES.has(input.taskType) ||
            !["like", "dislike"].includes(input.rating) ||
            typeof input.responseId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(input.responseId)) {
            return Promise.reject(Object.assign(new Error("Ari experience feedback is invalid."), { statusCode: 400 }));
        }
        const signals = Array.isArray(input.signals)
            ? [...new Set(input.signals.filter(value => SIGNALS.has(value)))]
            : [];
        const key = accountKey(subject);
        const operation = queue.then(() => {
            const store = readStore();
            const account = store.accounts[key] && typeof store.accounts[key] === "object"
                ? store.accounts[key]
                : { responses: [] };
            const responses = Array.isArray(account.responses) ? account.responses : [];
            const responseKey = crypto.createHash("sha256").update(key + ":" + input.responseId).digest("hex");
            const existing = responses.find(item => item.id === responseKey);
            if (existing) {
                existing.rating = input.rating;
                existing.tier = input.tier;
                existing.taskType = input.taskType;
                existing.signals = signals;
                existing.updatedAt = now();
            } else {
                responses.push({
                    id: responseKey,
                    tier: input.tier,
                    taskType: input.taskType,
                    rating: input.rating,
                    signals,
                    createdAt: now(),
                    updatedAt: now()
                });
            }
            const bounded = responses.slice(-500);
            store.accounts[key] = { responses: bounded };
            writeStore(store);
            return { recorded: true, updated: Boolean(existing), sampleCount: bounded.length };
        });
        queue = operation.catch(() => undefined);
        return operation;
    }

    function guidanceFor(subject, prompt) {
        if (typeof subject !== "string" || !subject.trim()) return "";
        const taskType = classifyTask(prompt);
        const store = readStore();
        const account = store.accounts[accountKey(subject)];
        const responses = account && Array.isArray(account.responses) ? account.responses : [];
        const relevant = responses.filter(item => item.taskType === taskType);
        if (!relevant.length) return "";
        const counts = new Map();
        let likes = 0;
        let dislikes = 0;
        for (const entry of relevant) {
            if (entry.rating === "like") likes++;
            else if (entry.rating === "dislike") dislikes++;
            if (entry.rating !== "like") continue;
            for (const signal of entry.signals || []) counts.set(signal, (counts.get(signal) || 0) + 1);
        }
        const preferences = [...counts.entries()]
            .filter(([, count]) => count >= 1)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([signal]) => ({
                clear_sections: "use clear section headings",
                step_by_step: "use ordered, practical steps where they help",
                examples: "include a relevant example",
                concise: "keep the answer concise",
                detailed: "include enough detail to make the answer useful",
                code_blocks: "format code in fenced code blocks",
                source_links: "include relevant source links when available",
                checklists: "use a checklist for multi-step tasks",
                tradeoffs: "explain important trade-offs",
                summary_first: "lead with a short summary"
            })[signal])
            .filter(Boolean);
        if (likes <= dislikes || !preferences.length) {
            return "Experience learning for this task category has not found a consistently preferred answer pattern yet. Prioritize the current request and its constraints.";
        }
        return "Use these reusable response patterns learned from the user's ratings of earlier Medium/Max sessions for " +
            taskType + " tasks: " + preferences.join("; ") +
            ". These are style/workflow hints only. They contain no previous message text; follow the current request if it differs.";
    }

    function getSummary(subject) {
        if (typeof subject !== "string" || !subject.trim()) return { samples: 0, likes: 0, dislikes: 0 };
        const store = readStore();
        const account = store.accounts[accountKey(subject)];
        const responses = account && Array.isArray(account.responses) ? account.responses : [];
        return {
            samples: responses.length,
            likes: responses.filter(item => item.rating === "like").length,
            dislikes: responses.filter(item => item.rating === "dislike").length
        };
    }

    return { recordFeedback, guidanceFor, getSummary, filePath };
}

module.exports = { createAriExperienceStore, classifyTask, responseSignals };
