"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const readline = require("node:readline");
const { once } = require("node:events");
const { buildConversationExamples, splitForTree } = require("../lib/oasst1");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_INPUT = path.join(
    ROOT,
    "data",
    "datasets",
    "oasst1",
    "2023-04-12_oasst_ready.trees.jsonl.gz"
);
const DEFAULT_OUTPUT = path.join(ROOT, "data", "processed", "oasst1-en");

async function writeLine(stream, value) {
    if (!stream.write(JSON.stringify(value) + "\n")) {
        await once(stream, "drain");
    }
}

async function prepareDataset(options = {}) {
    const inputPath = path.resolve(options.inputPath || process.env.OASST1_PATH || DEFAULT_INPUT);
    const outputDir = path.resolve(options.outputDir || process.env.OASST1_OUTPUT_DIR || DEFAULT_OUTPUT);

    if (!fs.existsSync(inputPath)) {
        throw new Error(
            "OASST1 file not found at " + inputPath +
            ". Set OASST1_PATH or place the ready trees .jsonl.gz file in data/datasets/oasst1."
        );
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const trainPath = path.join(outputDir, "train.jsonl");
    const validationPath = path.join(outputDir, "validation.jsonl");
    const trainStream = fs.createWriteStream(trainPath, { encoding: "utf8" });
    const validationStream = fs.createWriteStream(validationPath, { encoding: "utf8" });

    const stats = {
        inputPath,
        outputDir,
        treesRead: 0,
        treesSkipped: 0,
        messagesSkipped: 0,
        examplesWritten: 0,
        trainExamples: 0,
        validationExamples: 0
    };

    const input = fs.createReadStream(inputPath).pipe(zlib.createGunzip());
    const lines = readline.createInterface({ input, crlfDelay: Infinity });

    try {
        for await (const line of lines) {
            if (!line.trim()) continue;
            let tree;
            try {
                tree = JSON.parse(line);
            } catch (error) {
                throw new Error("Invalid JSONL row near tree " + (stats.treesRead + 1) + ": " + error.message);
            }

            stats.treesRead += 1;
            const result = buildConversationExamples(tree);
            if (result.skippedTree) stats.treesSkipped += 1;
            stats.messagesSkipped += result.skippedMessages;

            for (const example of result.examples) {
                const split = splitForTree(example.source_tree_id);
                if (split === "validation") {
                    await writeLine(validationStream, example);
                    stats.validationExamples += 1;
                } else {
                    await writeLine(trainStream, example);
                    stats.trainExamples += 1;
                }
                stats.examplesWritten += 1;
            }
        }

        trainStream.end();
        validationStream.end();
        await Promise.all([once(trainStream, "finish"), once(validationStream, "finish")]);
    } catch (error) {
        trainStream.destroy();
        validationStream.destroy();
        throw error;
    }

    return {
        ...stats,
        trainPath,
        validationPath
    };
}

if (require.main === module) {
    prepareDataset()
        .then(stats => {
            console.log("[Ari OASST1] Preparation complete.");
            console.log(JSON.stringify(stats, null, 2));
            console.log("These are candidate examples for review, not a trained model.");
        })
        .catch(error => {
            console.error("[Ari OASST1] " + error.message);
            process.exitCode = 1;
        });
}

module.exports = { prepareDataset, DEFAULT_INPUT, DEFAULT_OUTPUT };
