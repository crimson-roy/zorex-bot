"use strict";

/**
 * Zorex Editor Worker
 *
 * Runs on a GPU machine (Windows/Linux/Lightning/etc.) and talks to the
 * persistent editor API on the always-on Zorex VPS.
 *
 * Required env:
 *   EDITOR_SERVER_URL=http(s)://your-vps:3210
 *   EDITOR_WORKER_TOKEN=the-same-secret-as-the-vps
 *
 * Optional env:
 *   EDITOR_WORKER_ID=daniel-pc
 *   REAL_ESRGAN_BIN=/path/to/realesrgan-ncnn-vulkan
 *   FFMPEG_BIN=ffmpeg
 *   FFPROBE_BIN=ffprobe
 *   WORKER_DATA_DIR=./worker-data
 *   GPU_VRAM_GB=8
 *   EDITOR_POLL_MS=5000
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const SERVER =
    String(process.env.EDITOR_SERVER_URL || "")
        .replace(/\/+$/, "");

const TOKEN =
    String(process.env.EDITOR_WORKER_TOKEN || "");

const WORKER_ID =
    String(
        process.env.EDITOR_WORKER_ID ||
        os.hostname() ||
        "zorex-worker"
    );

const REAL_ESRGAN_BIN =
    process.env.REAL_ESRGAN_BIN ||
    "realesrgan-ncnn-vulkan";

const REAL_ESRGAN_MODELS =
    String(
        process.env.REAL_ESRGAN_MODELS ||
        ""
    ).trim();

const FFMPEG_BIN =
    process.env.FFMPEG_BIN ||
    "ffmpeg";

const FFPROBE_BIN =
    process.env.FFPROBE_BIN ||
    "ffprobe";

const WORK_ROOT =
    path.resolve(
        process.env.WORKER_DATA_DIR ||
        "./worker-data"
    );

const GPU_VRAM_GB =
    Number(
        process.env.GPU_VRAM_GB ||
        8
    );

const POLL_MS =
    Math.max(
        2000,
        Number(
            process.env.EDITOR_POLL_MS ||
            5000
        )
    );

if (!SERVER) {
    throw new Error("EDITOR_SERVER_URL is required.");
}

if (!TOKEN) {
    throw new Error("EDITOR_WORKER_TOKEN is required.");
}

fs.mkdirSync(
    WORK_ROOT,
    {
        recursive:
            true
    }
);

function sleep(ms) {
    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

function authHeaders(
    extra = {}
) {
    return {
        Authorization:
            "Bearer " + TOKEN,
        ...extra
    };
}

async function apiJson(
    pathname,
    {
        method = "GET",
        body
    } = {}
) {

    const response =
        await fetch(
            SERVER + pathname,
            {
                method,
                headers:
                    authHeaders(
                        body
                            ? {
                                "Content-Type":
                                    "application/json"
                            }
                            : {}
                    ),
                body:
                    body
                        ? JSON.stringify(
                            body
                        )
                        : undefined
            }
        );

    const text =
        await response.text();

    let data;

    try {
        data =
            text
                ? JSON.parse(text)
                : {};
    } catch (_) {
        data = {
            raw:
                text
        };
    }

    if (!response.ok) {
        throw new Error(
            `Editor API ${response.status}: ${JSON.stringify(data)}`
        );
    }

    return data;
}

function run(
    command,
    args,
    options = {}
) {

    return new Promise(
        (resolve, reject) => {

            console.log(
                "[WORKER] run:",
                command,
                args.join(" ")
            );

            const child =
                spawn(
                    command,
                    args,
                    {
                        stdio:
                            [
                                "ignore",
                                "inherit",
                                "inherit"
                            ],
                        ...options
                    }
                );

            child.once(
                "error",
                reject
            );

            child.once(
                "exit",
                code => {

                    if (code === 0) {
                        resolve();
                    } else {
                        reject(
                            new Error(
                                `${command} exited with code ${code}`
                            )
                        );
                    }

                }
            );

        }
    );
}

function capture(
    command,
    args
) {

    return new Promise(
        (resolve, reject) => {

            const child =
                spawn(
                    command,
                    args,
                    {
                        stdio:
                            [
                                "ignore",
                                "pipe",
                                "pipe"
                            ]
                    }
                );

            const stdout = [];
            const stderr = [];

            child.stdout.on(
                "data",
                chunk =>
                    stdout.push(
                        Buffer.from(chunk)
                    )
            );

            child.stderr.on(
                "data",
                chunk =>
                    stderr.push(
                        Buffer.from(chunk)
                    )
            );

            child.once(
                "error",
                reject
            );

            child.once(
                "exit",
                code => {

                    if (code === 0) {
                        resolve(
                            Buffer.concat(
                                stdout
                            ).toString("utf8")
                        );
                    } else {
                        reject(
                            new Error(
                                Buffer.concat(
                                    stderr
                                ).toString("utf8") ||
                                `${command} exited with code ${code}`
                            )
                        );
                    }

                }
            );

        }
    );
}

function parseFraction(value) {

    const raw =
        String(value || "");

    if (raw.includes("/")) {

        const [
            numerator,
            denominator
        ] =
            raw.split("/")
                .map(Number);

        if (
            Number.isFinite(numerator) &&
            Number.isFinite(denominator) &&
            denominator !== 0
        ) {
            return numerator / denominator;
        }

    }

    const number =
        Number(raw);

    return (
        Number.isFinite(number) &&
        number > 0
    )
        ? number
        : 30;
}

async function probeVideo(
    inputPath
) {

    const raw =
        await capture(
            FFPROBE_BIN,
            [
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=avg_frame_rate,width,height",
                "-of",
                "json",
                inputPath
            ]
        );

    const parsed =
        JSON.parse(raw);

    const stream =
        parsed?.streams?.[0] ||
        {};

    return {
        fps:
            parseFraction(
                stream.avg_frame_rate
            ),
        width:
            Number(
                stream.width ||
                0
            ),
        height:
            Number(
                stream.height ||
                0
            )
    };
}

async function reportProgress(
    jobId,
    progress,
    stage,
    checkpoint = null
) {

    try {

        await apiJson(
            `/api/jobs/${encodeURIComponent(jobId)}/progress`,
            {
                method:
                    "POST",
                body: {
                    workerId:
                        WORKER_ID,
                    progress,
                    stage,
                    checkpoint
                }
            }
        );

    } catch (err) {

        console.warn(
            "[WORKER] progress report failed:",
            err.message
        );

    }
}

async function downloadInput(
    job,
    destination
) {

    const response =
        await fetch(
            SERVER +
            `/api/jobs/${encodeURIComponent(job.id)}/input`,
            {
                headers:
                    authHeaders()
            }
        );

    if (!response.ok) {
        throw new Error(
            `input download failed: HTTP ${response.status}`
        );
    }

    const buffer =
        Buffer.from(
            await response.arrayBuffer()
        );

    fs.writeFileSync(
        destination,
        buffer
    );
}

async function uploadOutput(
    job,
    outputPath
) {

    const stat =
        fs.statSync(
            outputPath
        );

    const stream =
        fs.createReadStream(
            outputPath
        );

    const response =
        await fetch(
            SERVER +
            `/api/jobs/${encodeURIComponent(job.id)}/output`,
            {
                method:
                    "PUT",
                headers:
                    authHeaders({
                        "Content-Type":
                            "video/mp4",
                        "Content-Length":
                            String(
                                stat.size
                            )
                    }),
                body:
                    stream,
                duplex:
                    "half"
            }
        );

    if (!response.ok) {

        const error =
            await response.text();

        throw new Error(
            `output upload failed: HTTP ${response.status} ${error}`
        );

    }

}

function realesrganArgs(
    input,
    output,
    scale
) {
    const args = [
        "-i",
        input,
        "-o",
        output,
        "-n",
        "realesrgan-x4plus",
        "-s",
        String(scale),
        "-f",
        "png"
    ];

    if (REAL_ESRGAN_MODELS) {
        args.push(
            "-m",
            REAL_ESRGAN_MODELS
        );
    }

    return args;
}

async function processUpscale(
    job
) {

    const jobDir =
        path.join(
            WORK_ROOT,
            job.id
        );

    const framesDir =
        path.join(
            jobDir,
            "frames"
        );

    const upscaledDir =
        path.join(
            jobDir,
            "upscaled"
        );

    fs.mkdirSync(
        framesDir,
        {
            recursive:
                true
        }
    );

    fs.mkdirSync(
        upscaledDir,
        {
            recursive:
                true
        }
    );

    const inputPath =
        path.join(
            jobDir,
            "input.mp4"
        );

    const outputPath =
        path.join(
            jobDir,
            "output.mp4"
        );

    await reportProgress(
        job.id,
        2,
        "downloading-source"
    );

    await downloadInput(
        job,
        inputPath
    );

    await reportProgress(
        job.id,
        5,
        "probing-video"
    );

    const metadata =
        await probeVideo(
            inputPath
        );

    console.log(
        "[WORKER] source",
        {
            job:
                job.id,
            ...metadata
        }
    );

    await reportProgress(
        job.id,
        8,
        "extracting-frames"
    );

    await run(
        FFMPEG_BIN,
        [
            "-y",
            "-i",
            inputPath,
            "-vsync",
            "0",
            path.join(
                framesDir,
                "frame-%08d.png"
            )
        ]
    );

    await reportProgress(
        job.id,
        20,
        "realesrgan"
    );

    const scale =
        Number(
            job.options?.scale ||
            4
        );

    if (
        ![2, 4, 8].includes(scale)
    ) {
        throw new Error(
            `Unsupported upscale scale ${scale}`
        );
    }

    if (scale === 8) {

        const passOneDir =
            path.join(
                jobDir,
                "upscaled-4x"
            );

        fs.mkdirSync(
            passOneDir,
            {
                recursive:
                    true
            }
        );

        await run(
            REAL_ESRGAN_BIN,
            realesrganArgs(
                framesDir,
                passOneDir,
                4
            )
        );

        await reportProgress(
            job.id,
            55,
            "realesrgan-pass-2"
        );

        await run(
            REAL_ESRGAN_BIN,
            realesrganArgs(
                passOneDir,
                upscaledDir,
                2
            )
        );

    } else {

        await run(
            REAL_ESRGAN_BIN,
            realesrganArgs(
                framesDir,
                upscaledDir,
                scale
            )
        );

    }

    await reportProgress(
        job.id,
        78,
        "encoding"
    );

    const fps =
        Number(
            job.options?.fps ||
            metadata.fps
        );

    const quality =
        job.options?.quality ===
        "max";

    const args = [
        "-y",
        "-framerate",
        String(fps),
        "-i",
        path.join(
            upscaledDir,
            "frame-%08d.png"
        ),
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-map",
        "1:a?",
        "-c:v",
        "libx264",
        "-preset",
        quality
            ? "veryslow"
            : "slow"
    ];

    if (
        Number(
            job.options?.bitrateKbps ||
            0
        ) > 0
    ) {

        args.push(
            "-b:v",
            `${Number(job.options.bitrateKbps)}k`
        );

    } else {

        args.push(
            "-crf",
            quality
                ? "14"
                : "17"
        );

    }

    args.push(
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-movflags",
        "+faststart",
        outputPath
    );

    await run(
        FFMPEG_BIN,
        args
    );

    await reportProgress(
        job.id,
        95,
        "uploading-result"
    );

    await uploadOutput(
        job,
        outputPath
    );

    console.log(
        "[WORKER] completed",
        job.id
    );
}

async function failJob(
    job,
    err,
    requeue = true
) {

    try {

        await apiJson(
            `/api/jobs/${encodeURIComponent(job.id)}/fail`,
            {
                method:
                    "POST",
                body: {
                    workerId:
                        WORKER_ID,
                    requeue,
                    error:
                        err?.stack ||
                        err?.message ||
                        String(err)
                }
            }
        );

    } catch (reportErr) {

        console.error(
            "[WORKER] failed to report job failure:",
            reportErr.message
        );

    }
}

async function claim() {

    const result =
        await apiJson(
            "/api/jobs/claim",
            {
                method:
                    "POST",
                body: {
                    workerId:
                        WORKER_ID,
                    gpu:
                        true,
                    vramGb:
                        GPU_VRAM_GB,
                    capabilities: [
                        "realesrgan"
                    ]
                }
            }
        );

    return (
        result?.job ||
        null
    );
}

async function main() {

    console.log(
        "[WORKER] Zorex Editor worker online",
        {
            server:
                SERVER,
            workerId:
                WORKER_ID,
            realEsrgan:
                REAL_ESRGAN_BIN,
            models:
                REAL_ESRGAN_MODELS ||
                "default",
            vramGb:
                GPU_VRAM_GB
        }
    );

    while (true) {

        let job;

        try {

            job =
                await claim();

        } catch (err) {

            console.error(
                "[WORKER] claim failed:",
                err.message
            );

            await sleep(
                POLL_MS
            );

            continue;

        }

        if (!job) {

            await sleep(
                POLL_MS
            );

            continue;

        }

        console.log(
            "[WORKER] claimed",
            {
                id:
                    job.id,
                type:
                    job.type,
                options:
                    job.options
            }
        );

        try {

            if (
                job.type ===
                "video_upscale"
            ) {

                await processUpscale(
                    job
                );

            } else {

                throw new Error(
                    `Unsupported worker job type: ${job.type}`
                );

            }

        } catch (err) {

            console.error(
                "[WORKER] job failed",
                job.id,
                err
            );

            await failJob(
                job,
                err,
                true
            );

        }

    }
}

main().catch(
    err => {

        console.error(
            "[WORKER] fatal:",
            err
        );

        process.exitCode =
            1;

    }
);
