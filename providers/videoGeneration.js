/**
 * providers/videoGeneration.js
 *
 * Provider-selectable AI video generation for Zorex.
 *
 * VIDEO_GENERATION_PROVIDER:
 *   auto    -> prefer Fal when FAL_KEY exists, otherwise Runway
 *   fal     -> force Fal
 *   runway  -> force Runway
 *
 * Fal defaults:
 *   wan/v2.6/text-to-video
 *   wan/v2.6/image-to-video
 *   720p
 *
 * Runway defaults:
 *   gen4.5
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const TEMP_DIR =
    path.join(
        os.tmpdir(),
        "zorex-video-generation"
    );

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

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

async function downloadVideo(
    url,
    label = "video provider"
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
            `${label} output download failed: HTTP ${response.status}`
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

function selectedProvider() {

    const configured =
        String(
            process.env.VIDEO_GENERATION_PROVIDER ||
            "auto"
        )
            .trim()
            .toLowerCase();

    if (
        configured !== "auto" &&
        configured !== "fal" &&
        configured !== "runway"
    ) {
        throw new Error(
            `Unsupported VIDEO_GENERATION_PROVIDER "${configured}". Use auto, fal, or runway.`
        );
    }

    if (configured === "fal") {
        return "fal";
    }

    if (configured === "runway") {
        return "runway";
    }

    if (
        String(
            process.env.FAL_KEY ||
            ""
        ).trim()
    ) {
        return "fal";
    }

    if (
        String(
            process.env.RUNWAYML_API_SECRET ||
            ""
        ).trim()
    ) {
        return "runway";
    }

    throw new Error(
        "No video generation provider is configured. Set FAL_KEY or RUNWAYML_API_SECRET."
    );
}

/* ------------------------------------------------------------------ */
/* Fal                                                                 */
/* ------------------------------------------------------------------ */

let falClientPromise =
    null;

async function getFal() {

    if (!falClientPromise) {

        falClientPromise =
            import(
                "@fal-ai/client"
            )
                .then(
                    mod => {

                        const fal =
                            mod.fal;

                        const key =
                            String(
                                process.env.FAL_KEY ||
                                ""
                            ).trim();

                        if (!key) {
                            throw new Error(
                                "FAL_KEY is not configured."
                            );
                        }

                        fal.config({
                            credentials:
                                key
                        });

                        return fal;

                    }
                )
                .catch(
                    err => {

                        falClientPromise =
                            null;

                        throw err;

                    }
                );

    }

    return await falClientPromise;
}

function falDuration(
    requested
) {

    const value =
        Number(
            requested ||
            5
        );

    if (value <= 5) {
        return "5";
    }

    if (value <= 10) {
        return "10";
    }

    return "15";
}

function falAspectRatio(
    ratio
) {

    if (
        ratio === "1280:720"
    ) {
        return "16:9";
    }

    if (
        ratio === "960:960"
    ) {
        return "1:1";
    }

    return "9:16";
}

async function generateWithFal({
    promptText,
    promptImage,
    ratio,
    duration,
    onStatus
}) {

    const fal =
        await getFal();

    const isImageToVideo =
        Boolean(
            promptImage
        );

    const model =
        isImageToVideo
            ? String(
                process.env.FAL_VIDEO_I2V_MODEL ||
                "wan/v2.6/image-to-video"
            )
            : String(
                process.env.FAL_VIDEO_T2V_MODEL ||
                "wan/v2.6/text-to-video"
            );

    const durationValue =
        falDuration(
            duration
        );

    const resolution =
        String(
            process.env.FAL_VIDEO_RESOLUTION ||
            "720p"
        );

    const input = {
        prompt:
            String(
                promptText ||
                ""
            ).trim(),
        duration:
            durationValue,
        resolution,
        enable_prompt_expansion:
            true,
        enable_safety_checker:
            true
    };

    if (isImageToVideo) {

        input.image_url =
            promptImage;

        input.multi_shots =
            false;

    } else {

        input.aspect_ratio =
            falAspectRatio(
                ratio
            );

        input.multi_shots =
            false;

    }

    if (onStatus) {
        await onStatus(
            "SUBMITTED",
            {
                provider:
                    "fal",
                model
            }
        );
    }

    const result =
        await fal.subscribe(
            model,
            {
                input,
                logs:
                    true,
                onQueueUpdate:
                    update => {

                        if (!onStatus) {
                            return;
                        }

                        const status =
                            String(
                                update?.status ||
                                ""
                            )
                                .toUpperCase();

                        const mapped =
                            status === "IN_QUEUE"
                                ? "PENDING"
                                : status === "IN_PROGRESS"
                                    ? "RUNNING"
                                    : status;

                        Promise.resolve(
                            onStatus(
                                mapped,
                                update
                            )
                        ).catch(
                            () => {}
                        );

                    }
            }
        );

    const data =
        result?.data ||
        result;

    const outputUrl =
        data?.video?.url;

    if (!outputUrl) {
        throw new Error(
            "Fal video generation completed without a video URL."
        );
    }

    const filePath =
        await downloadVideo(
            outputUrl,
            "Fal"
        );

    return {
        provider:
            "fal",
        model,
        duration:
            Number(
                durationValue
            ),
        resolution,
        filePath,
        requestId:
            result?.requestId ||
            null
    };
}

/* ------------------------------------------------------------------ */
/* Runway                                                              */
/* ------------------------------------------------------------------ */

const RUNWAY_API_BASE =
    "https://api.dev.runwayml.com";

const RUNWAY_API_VERSION =
    "2024-11-06";

const RUNWAY_POLL_BASE_MS =
    5500;

const RUNWAY_TASK_TIMEOUT_MS =
    12 * 60 * 1000;

function sleep(ms) {
    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

function runwaySecret() {
    return String(
        process.env.RUNWAYML_API_SECRET ||
        ""
    ).trim();
}

function runwayModel() {
    return String(
        process.env.RUNWAY_VIDEO_MODEL ||
        "gen4.5"
    ).trim();
}

function runwayHeaders() {

    const secret =
        runwaySecret();

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
            RUNWAY_API_VERSION
    };
}

async function runwayApiError(
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

async function createRunwayTask({
    promptText,
    promptImage,
    ratio,
    duration
}) {

    const body = {
        model:
            runwayModel(),
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
            `${RUNWAY_API_BASE}/v1/image_to_video`,
            {
                method:
                    "POST",
                headers:
                    runwayHeaders(),
                body:
                    JSON.stringify(
                        body
                    )
            }
        );

    if (!response.ok) {
        throw await runwayApiError(
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

async function retrieveRunwayTask(
    taskId
) {

    const response =
        await fetch(
            `${RUNWAY_API_BASE}/v1/tasks/${encodeURIComponent(taskId)}`,
            {
                headers:
                    runwayHeaders()
            }
        );

    if (!response.ok) {
        throw await runwayApiError(
            response
        );
    }

    return await response.json();
}

async function waitForRunwayTask(
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
        RUNWAY_TASK_TIMEOUT_MS
    ) {

        let task;

        try {

            task =
                await retrieveRunwayTask(
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

        await sleep(
            RUNWAY_POLL_BASE_MS +
            Math.floor(
                Math.random() *
                1200
            )
        );

    }

    throw new Error(
        "Runway video generation timed out."
    );
}

async function generateWithRunway({
    promptText,
    promptImage,
    ratio,
    duration,
    onStatus
}) {

    const taskId =
        await createRunwayTask({
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
                    taskId,
                provider:
                    "runway"
            }
        );
    }

    const {
        outputUrl
    } =
        await waitForRunwayTask(
            taskId,
            {
                onStatus
            }
        );

    const filePath =
        await downloadVideo(
            outputUrl,
            "Runway"
        );

    return {
        provider:
            "runway",
        model:
            runwayModel(),
        duration:
            Number(
                duration
            ),
        filePath,
        taskId
    };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

async function generateVideo(
    options
) {

    const provider =
        selectedProvider();

    if (
        provider ===
        "fal"
    ) {
        return await generateWithFal(
            options
        );
    }

    return await generateWithRunway(
        options
    );
}

module.exports = {
    generateVideo
};
