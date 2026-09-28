/**
 * providers/depth.js
 *
 * Depth-map provider for Zorex.
 * Uses the official depth-anything/Depth-Anything-V2 Hugging Face Space.
 *
 * Expected Gradio endpoint:
 *   /on_submit
 *
 * Current Space output shape:
 *   data[0] -> slider/comparison output
 *   data[1] -> grayscale depth-map file
 *   data[2] -> raw 16-bit depth/disparity file
 *
 * Public contract:
 *   generateDepthMap(inputPathOrUrl)
 *     -> local path to grayscale depth-map PNG
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const {
    Client,
    handle_file
} = require("@gradio/client");

const SPACE_NAME =
    "depth-anything/Depth-Anything-V2";

const ENDPOINT =
    "/on_submit";

const CONNECT_TIMEOUT_MS =
    30000;

const PREDICT_TIMEOUT_MS =
    120000;

const TEMP_DIR =
    path.join(
        os.tmpdir(),
        "zorex-depth-provider"
    );

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

function withTimeout(
    promise,
    timeoutMs,
    label
) {
    let timer;

    const timeout =
        new Promise(
            (_, reject) => {
                timer =
                    setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `Depth provider: ${label} timed out after ${timeoutMs}ms`
                                )
                            ),
                        timeoutMs
                    );
            }
        );

    return Promise.race(
        [
            promise,
            timeout
        ]
    ).finally(
        () =>
            clearTimeout(
                timer
            )
    );
}

async function connectToSpace() {
    try {
        return await withTimeout(
            Client.connect(
                SPACE_NAME,
                {
                    token:
                        process.env.HUGGINGFACE_API_TOKEN
                }
            ),
            CONNECT_TIMEOUT_MS,
            `connecting to ${SPACE_NAME}`
        );
    } catch (err) {
        throw new Error(
            `Depth provider: could not connect to ${SPACE_NAME} — ${err.message}`
        );
    }
}

async function downloadToTemp(url) {
    ensureTempDir();

    const ext =
        path.extname(
            new URL(
                url
            ).pathname
        ) ||
        ".png";

    const outputPath =
        path.join(
            TEMP_DIR,
            `${crypto.randomBytes(6).toString("hex")}${ext}`
        );

    const response =
        await fetch(
            url
        );

    if (!response.ok) {
        throw new Error(
            `Depth provider: failed downloading result (HTTP ${response.status})`
        );
    }

    const buffer =
        Buffer.from(
            await response.arrayBuffer()
        );

    fs.writeFileSync(
        outputPath,
        buffer
    );

    return outputPath;
}

async function generateDepthMap(
    inputPathOrUrl
) {
    const app =
        await connectToSpace();

    let result;

    try {
        result =
            await withTimeout(
                app.predict(
                    ENDPOINT,
                    [
                        handle_file(
                            inputPathOrUrl
                        )
                    ]
                ),
                PREDICT_TIMEOUT_MS,
                `generating depth map via ${ENDPOINT}`
            );
    } catch (err) {
        throw new Error(
            `Depth provider: prediction failed — ${err.message}`
        );
    }

    const data =
        result?.data ||
        [];

    const grayDepth =
        data[1];

    if (
        !grayDepth ||
        !grayDepth.url
    ) {
        throw new Error(
            "Depth provider: Space returned no grayscale depth map at data[1]."
        );
    }

    return await downloadToTemp(
        grayDepth.url
    );
}

module.exports = {
    generateDepthMap
};
