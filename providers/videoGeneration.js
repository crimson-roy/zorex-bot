/**
 * providers/videoGeneration.js
 *
 * Runway video-generation provider for Zorex.
 *
 * Uses the current Runway Dev REST API directly with fetch:
 *   POST /v1/image_to_video
 *   GET  /v1/tasks/:id
 *
 * Text-to-video uses the same create endpoint but omits promptImage.
 *
 * Required env:
 *   RUNWAYML_API_SECRET
 *
 * Optional env:
 *   RUNWAY_VIDEO_MODEL=gen4.5
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const API_BASE =
    "https://api.dev.runwayml.com";

const API_VERSION =
    "2024-11-06";

const DEFAULT_MODEL =
    "gen4.5";

const POLL_BASE_MS =
    5500;

const TASK_TIMEOUT_MS =
    12 * 60 * 1000;

const TEMP_DIR =
    path.join(
        os.tmpdir(),
        "zorex-video-generation"
    );

function ensureTempDir() {
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(
            TEMP_DIR,
            {
                recursive:
                    true
            }
        );
    }
}

function sleep(ms) {
    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

function getSecret() {
    return String(
        process.env.RUNWAYML_API_SECRET ||
        ""
    ).trim();
}

function getModel() {
    return String(
        process.env.RUNWAY_VIDEO_MODEL ||
        DEFAULT_MODEL
    ).trim();
}

function headers() {
    const secret =
        getSecret();

    if (!secret) {
        throw new Error(
            "RUNWAYML_API_SECRET is not configured."
        );
    }

    return {
        "Content-Type":
            "application/json",
        "Authorization":
            `Bearer ${secret}`,
        "X-Runway-Version":
            API_VERSION
    };
}

async function parseApiError(
    response
) {
    const text =
        await response.text()
            .catch(
                () => ""
            );

    return new Error(
        `Runway API error ${response.status}: ${text || response.statusText}`
    );
}

async function createTask({
    promptText,
    promptImage,
    ratio,
    duration
}) {

    const body = {
        model:
            getModel(),
        promptText:
            String(
                promptText ||
                ""
            ).trim(),
        ratio,
        duration
    };

    if (promptImage) {
        body.promptImage =
            promptImage;
    }

    const response =
        await fetch(
            `${API_BASE}/v1/image_to_video`,
            {
                method:
                    "POST",
                headers:
                    headers(),
                body:
                    JSON.stringify(
                        body
                    )
            }
        );

    if (!response.ok) {
        throw await parseApiError(
            response
        );
    }

    const data =
        await response.json();

    if (!data?.id) {
        throw new Error(
            "Runway did not return a task ID."
        );
    }

    return data.id;
}

async function retrieveTask(
    taskId
) {

    const response =
        await fetch(
            `${API_BASE}/v1/tasks/${encodeURIComponent(taskId)}`,
            {
                headers:
                    headers()
            }
        );

    if (!response.ok) {
        throw await parseApiError(
            response
        );
    }

    return await response.json();
}

async function waitForTask(
    taskId,
    {
        onStatus
    } = {}
) {

    const startedAt =
        Date.now();

    let lastStatus =
        "";

    let transientFailures =
        0;

    while (
        Date.now() -
        startedAt <
        TASK_TIMEOUT_MS
    ) {

        let task;

        try {

            task =
                await retrieveTask(
                    taskId
                );

            transientFailures =
                0;

        } catch (err) {

            transientFailures++;

            if (
                transientFailures >=
                5
            ) {
                throw err;
            }

            await sleep(
                Math.min(
                    5000 *
                    Math.pow(
                        2,
                        transientFailures -
                        1
                    ),
                    30000
                )
            );

            continue;

        }

        const status =
            String(
                task?.status ||
                ""
            ).toUpperCase();

        if (
            status &&
            status !==
            lastStatus
        ) {

            lastStatus =
                status;

            if (onStatus) {
                await onStatus(
                    status,
                    task
                );
            }

        }

        if (
            status ===
            "SUCCEEDED"
        ) {

            const outputUrl =
                Array.isArray(
                    task.output
                )
                    ? task.output[0]
                    : null;

            if (!outputUrl) {
                throw new Error(
                    "Runway task succeeded but returned no output URL."
                );
            }

            return {
                task,
                outputUrl
            };

        }

        if (
            status === "FAILED" ||
            status === "CANCELED"
        ) {
            throw new Error(
                `Runway task ${status.toLowerCase()}: ${task?.failure || task?.failureCode || "no failure details"}`
            );
        }

        const jitter =
            Math.floor(
                Math.random() *
                1200
            );

        await sleep(
            POLL_BASE_MS +
            jitter
        );

    }

    throw new Error(
        "Runway video generation timed out."
    );
}

async function downloadVideo(
    url
) {

    ensureTempDir();

    const outputPath =
        path.join(
            TEMP_DIR,
            `${crypto.randomBytes(8).toString("hex")}.mp4`
        );

    const response =
        await fetch(
            url
        );

    if (!response.ok) {
        throw new Error(
            `Runway output download failed: HTTP ${response.status}`
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

async function generateVideo({
    promptText,
    promptImage,
    ratio = "720:1280",
    duration = 5,
    onStatus
}) {

    const taskId =
        await createTask({
            promptText,
            promptImage,
            ratio,
            duration
        });

    if (onStatus) {
        await onStatus(
            "SUBMITTED",
            {
                id:
                    taskId
            }
        );
    }

    const {
        outputUrl
    } =
        await waitForTask(
            taskId,
            {
                onStatus
            }
        );

    const filePath =
        await downloadVideo(
            outputUrl
        );

    return {
        taskId,
        filePath
    };
}

module.exports = {
    generateVideo
};
