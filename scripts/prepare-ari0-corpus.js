"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { once } = require("node:events");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_INPUT_DIR = path.join(ROOT, "data", "processed", "oasst1-en");
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "data", "processed", "ari0");

function serializeExample(example) {
    const messages = Array.isArray(example && example.messages) ? example.messages : [];
    if (messages.length < 2) return "";

    const lines = [];
    for (const message of messages) {
        if (!message || !["user", "assistant"].includes(message.role)) return "";
        if (typeof message.content !== "string" || !message.content.trim()) return "";
        lines.push(message.role === "user" ? "<|user|>" : "<|assistant|>");
        lines.push(message.content.trim());
        if (message.role === "assistant") lines.push("<|end|>");
    }

    if (messages[messages.length - 1].role !== "assistant") return "";
    return lines.join("\n") + "\n\n";
}

async function prepareSplit(inputPath, outputPath) {
    const input = fs.createReadStream(inputPath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    const output = fs.createWriteStream(outputPath, { encoding: "utf8" });
    const stats = { rowsRead: 0, conversationsWritten: 0, rowsSkipped: 0, charactersWritten: 0 };

    try {
        for await (const line of lines) {
            if (!line.trim()) continue;
            stats.rowsRead += 1;
            let example;
            try {
                example = JSON.parse(line);
            } catch (error) {
                throw new Error("Invalid JSONL row " + stats.rowsRead + " in " + inputPath + ": " + error.message);
            }

            const serialized = serializeExample(example);
            if (!serialized) {
                stats.rowsSkipped += 1;
                continue;
            }
            if (!output.write(serialized)) await once(output, "drain");
            stats.conversationsWritten += 1;
            stats.charactersWritten += serialized.length;
        }

        const finished = once(output, "finish");
        output.end();
        await finished;
    } catch (error) {
        output.destroy();
        throw error;
    }
    return { inputPath, outputPath, ...stats };
}

async function prepareAri0Corpus(options = {}) {
    const inputDir = path.resolve(options.inputDir || process.env.OASST1_OUTPUT_DIR || DEFAULT_INPUT_DIR);
    const outputDir = path.resolve(options.outputDir || process.env.ARI0_CORPUS_DIR || DEFAULT_OUTPUT_DIR);
    const trainInput = path.join(inputDir, "train.jsonl");
    const validationInput = path.join(inputDir, "validation.jsonl");

    for (const file of [trainInput, validationInput]) {
        if (!fs.existsSync(file)) {
            throw new Error("Prepared OASST1 file not found: " + file + ". Run npm run ari:prepare-oasst first.");
        }
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const [train, validation] = await Promise.all([
        prepareSplit(trainInput, path.join(outputDir, "train.txt")),
        prepareSplit(validationInput, path.join(outputDir, "validation.txt"))
    ]);
    return { inputDir, outputDir, train, validation };
}

if (require.main === module) {
    prepareAri0Corpus()
        .then(stats => {
            console.log("[Ari-0] Conversation corpus preparation complete.");
            console.log(JSON.stringify(stats, null, 2));
            console.log("Conversation roles and end-of-turn markers are included; no model weights are trained here.");
        })
        .catch(error => {
            console.error("[Ari-0] " + error.message);
            process.exitCode = 1;
        });
}

module.exports = { serializeExample, prepareSplit, prepareAri0Corpus, DEFAULT_INPUT_DIR, DEFAULT_OUTPUT_DIR };
