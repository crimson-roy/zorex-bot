/**
 * providers/localDepth.js
 *
 * Local Depth Anything V2 inference for Zorex using Transformers.js.
 * This avoids Hugging Face ZeroGPU quotas entirely.
 *
 * Model:
 *   onnx-community/depth-anything-v2-small
 *
 * Runtime:
 *   CPU/WASM with q4 weights by default.
 *
 * First use downloads and caches the model; subsequent calls reuse the
 * same in-process pipeline and local model cache.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const MODEL_ID =
    process.env.LOCAL_DEPTH_MODEL ||
    "onnx-community/depth-anything-v2-small";

const DTYPE =
    process.env.LOCAL_DEPTH_DTYPE ||
    "q4";

const TEMP_DIR =
    path.join(
        os.tmpdir(),
        "zorex-local-depth"
    );

let depthPipelinePromise =
    null;

function ensureTempDir() {
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(
            TEMP_DIR,
            {
                recursive: true
            }
        );
    }
}

async function getDepthPipeline() {

    if (!depthPipelinePromise) {

        depthPipelinePromise =
            import(
                "@huggingface/transformers"
            )
                .then(
                    async ({
                        pipeline
                    }) => {

                        return await pipeline(
                            "depth-estimation",
                            MODEL_ID,
                            {
                                dtype:
                                    DTYPE
                            }
                        );

                    }
                )
                .catch(
                    err => {

                        depthPipelinePromise =
                            null;

                        throw err;

                    }
                );

    }

    return await depthPipelinePromise;
}

async function generateLocalDepthMap(
    inputPathOrUrl
) {

    ensureTempDir();

    const estimator =
        await getDepthPipeline();

    const output =
        await estimator(
            inputPathOrUrl
        );

    const depth =
        output?.depth;

    if (!depth) {
        throw new Error(
            "Local depth model returned no depth image."
        );
    }

    const outputPath =
        path.join(
            TEMP_DIR,
            `${crypto.randomBytes(8).toString("hex")}.png`
        );

    if (
        typeof depth.save ===
        "function"
    ) {

        await depth.save(
            outputPath
        );

        return outputPath;

    }

    throw new Error(
        "Local depth result could not be saved as an image."
    );
}

module.exports = {
    generateLocalDepthMap
};
