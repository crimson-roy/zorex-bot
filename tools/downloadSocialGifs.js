"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const API_BASE = "https://nekos.best/api/v2";
const ROOT = path.resolve(__dirname, "..");
const SOCIAL_ROOT = path.join(ROOT, "media", "social");

// Zorex social command -> nekos.best GIF category.
// "kill" deliberately uses the playful "yeet" category rather than
// anything graphic. A separate seppuku pack should be curated manually.
const CATEGORY_MAP = {
    hug: "hug",
    kiss: "kiss",
    slap: "slap",
    pat: "pat",
    poke: "poke",
    cuddle: "cuddle",
    bite: "bite",
    highfive: "highfive",
    dance: "dance",
    kill: "yeet"
};

const USER_AGENT =
    process.env.NEKOS_USER_AGENT ||
    "Zorex-AI (https://github.com/crimson-roy/zorex-bot)";

function usage() {
    console.log(`
Usage:
  node tools/downloadSocialGifs.js <category> [count]
  node tools/downloadSocialGifs.js all [count]

Examples:
  node tools/downloadSocialGifs.js hug 10
  node tools/downloadSocialGifs.js kiss 15
  node tools/downloadSocialGifs.js all 10

Available categories:
  ${Object.keys(CATEGORY_MAP).join(", ")}

Notes:
  - count defaults to 10
  - each API request asks for at most 20 GIFs
  - downloaded GIFs are converted to MP4 for WhatsApp gifPlayback
  - files are saved under media/social/<category>/
`.trim());
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function runFFmpeg(input, output) {
    return new Promise((resolve, reject) => {
        const args = [
            "-y",
            "-i", input,
            "-an",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "24",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            output
        ];

        const proc = spawn("ffmpeg", args, {
            stdio: ["ignore", "ignore", "pipe"]
        });

        let stderr = "";

        proc.stderr.on("data", chunk => {
            stderr += chunk.toString();
        });

        proc.on("error", reject);

        proc.on("close", code => {
            if (code === 0) return resolve();

            reject(
                new Error(
                    `ffmpeg exited with code ${code}: ${stderr.slice(-1500)}`
                )
            );
        });
    });
}

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json"
        }
    });

    if (!response.ok) {
        throw new Error(
            `API request failed: HTTP ${response.status} ${await response.text()}`
        );
    }

    return response.json();
}

async function downloadBuffer(url) {
    const response = await fetch(url, {
        headers: {
            "User-Agent": USER_AGENT
        }
    });

    if (!response.ok) {
        throw new Error(
            `Download failed: HTTP ${response.status}`
        );
    }

    return Buffer.from(
        await response.arrayBuffer()
    );
}

function nextIndex(folder) {
    if (!fs.existsSync(folder)) return 1;

    const nums = fs.readdirSync(folder)
        .map(name => {
            const match = name.match(/^(\d+)\.mp4$/i);
            return match ? Number(match[1]) : null;
        })
        .filter(Number.isFinite);

    return nums.length
        ? Math.max(...nums) + 1
        : 1;
}

async function fetchBatch(sourceCategory, amount) {
    const url =
        `${API_BASE}/${encodeURIComponent(sourceCategory)}?amount=${amount}`;

    const data = await fetchJson(url);

    return Array.isArray(data.results)
        ? data.results
        : [];
}

async function downloadCategory(targetCategory, wantedCount) {
    const sourceCategory = CATEGORY_MAP[targetCategory];

    if (!sourceCategory) {
        throw new Error(
            `Unsupported category: ${targetCategory}`
        );
    }

    const folder =
        path.join(
            SOCIAL_ROOT,
            targetCategory
        );

    ensureDir(folder);

    let index =
        nextIndex(folder);

    let saved = 0;
    let attempts = 0;
    const seen = new Set();

    const metadataFile =
        path.join(
            folder,
            "metadata.json"
        );

    let metadata = [];

    if (fs.existsSync(metadataFile)) {
        try {
            metadata =
                JSON.parse(
                    fs.readFileSync(
                        metadataFile,
                        "utf8"
                    )
                );

            for (const item of metadata) {
                if (item.url) {
                    seen.add(item.url);
                }
            }
        } catch (_) {
            metadata = [];
        }
    }

    console.log(
        `\n📦 ${targetCategory}: downloading ${wantedCount} clip(s) from "${sourceCategory}"...`
    );

    while (
        saved < wantedCount &&
        attempts < 20
    ) {
        attempts++;

        const remaining =
            wantedCount - saved;

        const requestAmount =
            Math.min(
                Math.max(remaining, 1),
                20
            );

        const results =
            await fetchBatch(
                sourceCategory,
                requestAmount
            );

        if (!results.length) {
            console.log(
                `⚠️ No results returned for ${targetCategory}`
            );
            break;
        }

        for (const item of results) {
            if (saved >= wantedCount) break;

            if (
                !item?.url ||
                seen.has(item.url)
            ) {
                continue;
            }

            seen.add(item.url);

            const stem =
                String(index)
                    .padStart(3, "0");

            const gifPath =
                path.join(
                    folder,
                    `.${stem}.download.gif`
                );

            const mp4Path =
                path.join(
                    folder,
                    `${stem}.mp4`
                );

            try {
                process.stdout.write(
                    `  ⬇️ ${targetCategory} ${stem}... `
                );

                const buffer =
                    await downloadBuffer(
                        item.url
                    );

                fs.writeFileSync(
                    gifPath,
                    buffer
                );

                await runFFmpeg(
                    gifPath,
                    mp4Path
                );

                fs.rmSync(
                    gifPath,
                    { force: true }
                );

                metadata.push({
                    file: `${stem}.mp4`,
                    category: targetCategory,
                    sourceCategory,
                    animeName:
                        item.anime_name || null,
                    url:
                        item.url,
                    downloadedAt:
                        new Date().toISOString()
                });

                fs.writeFileSync(
                    metadataFile,
                    JSON.stringify(
                        metadata,
                        null,
                        2
                    )
                );

                console.log("✅");

                saved++;
                index++;

            } catch (err) {
                fs.rmSync(
                    gifPath,
                    { force: true }
                );

                fs.rmSync(
                    mp4Path,
                    { force: true }
                );

                console.log(
                    `❌ ${err.message}`
                );
            }
        }

        if (saved < wantedCount) {
            // Keep requests polite and well below the API's category
            // rate limit.
            await sleep(750);
        }
    }

    console.log(
        `✅ ${targetCategory}: saved ${saved}/${wantedCount} new clip(s) to ${path.relative(ROOT, folder)}`
    );

    return saved;
}

async function main() {
    const requested =
        String(process.argv[2] || "")
            .toLowerCase();

    const count =
        Number(process.argv[3] || 10);

    if (
        !requested ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 100
    ) {
        usage();
        process.exitCode = 1;
        return;
    }

    const categories =
        requested === "all"
            ? Object.keys(CATEGORY_MAP)
            : [requested];

    for (const category of categories) {
        if (!CATEGORY_MAP[category]) {
            console.error(
                `❌ Unknown category: ${category}`
            );
            usage();
            process.exitCode = 1;
            return;
        }
    }

    ensureDir(SOCIAL_ROOT);

    let total = 0;

    for (const category of categories) {
        total +=
            await downloadCategory(
                category,
                count
            );
    }

    console.log(
        `\n🎉 Done. Downloaded ${total} new social clip(s).`
    );
}

main().catch(err => {
    console.error(
        "\n❌ Social GIF downloader failed:",
        err.message
    );

    process.exitCode = 1;
});
