"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SOCIAL_ROOT = path.join(ROOT, "media", "social");

const SOURCE_OWNER = "ZekaiDev";
const SOURCE_REPO = "anime-reaction-gif";
const SOURCE_BRANCH = "main";
const RAW_BASE =
    `https://raw.githubusercontent.com/${SOURCE_OWNER}/${SOURCE_REPO}/${SOURCE_BRANCH}`;

// Zorex command -> source folder + number of GIFs in that folder.
// highfive uses "brofist" because this pack has no highfive folder.
// kill uses "punch" to keep it exaggerated/cartoonish rather than graphic.
const CATEGORY_MAP = {
    hug:      { source: "hug",      count: 40 },
    kiss:     { source: "kiss",     count: 36 },
    slap:     { source: "slap",     count: 25 },
    pat:      { source: "pat",      count: 28 },
    poke:     { source: "poke",     count: 18 },
    cuddle:   { source: "cuddle",   count: 30 },
    bite:     { source: "bite",     count: 20 },
    highfive: { source: "brofist",  count: 9  },
    dance:    { source: "dance",    count: 33 },
    kill:     { source: "punch",    count: 15 }
};

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
  - source is the public ZekaiDev/anime-reaction-gif GitHub pack
  - GIFs are converted to MP4 for WhatsApp gifPlayback
  - files are saved under media/social/<category>/
  - reruns skip source GIFs already recorded in metadata.json
`.trim());
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function shuffle(values) {
    const copy = [...values];

    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }

    return copy;
}

function runFFmpeg(input, output) {
    return new Promise((resolve, reject) => {
        const args = [
            "-y",
            "-i", input,
            "-an",

            // H.264 + yuv420p requires even width/height. Anime GIF packs
            // commonly contain odd sizes such as 453x280 or 480x285,
            // so round each dimension up to the nearest even pixel.
            "-vf",
            "scale=ceil(iw/2)*2:ceil(ih/2)*2",

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

async function downloadBuffer(url) {
    const response = await fetch(url, {
        headers: {
            "User-Agent":
                "Zorex-AI-Social-GIF-Downloader/1.0",
            "Accept":
                "image/gif,image/*;q=0.9,*/*;q=0.8"
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
            const match =
                name.match(/^(\d+)\.mp4$/i);

            return match
                ? Number(match[1])
                : null;
        })
        .filter(Number.isFinite);

    return nums.length
        ? Math.max(...nums) + 1
        : 1;
}

function loadMetadata(metadataFile) {
    if (!fs.existsSync(metadataFile)) {
        return [];
    }

    try {
        const parsed =
            JSON.parse(
                fs.readFileSync(
                    metadataFile,
                    "utf8"
                )
            );

        return Array.isArray(parsed)
            ? parsed
            : [];

    } catch (_) {
        return [];
    }
}

function saveMetadata(metadataFile, metadata) {
    fs.writeFileSync(
        metadataFile,
        JSON.stringify(
            metadata,
            null,
            2
        )
    );
}

function sourceUrl(sourceCategory, sourceNumber) {
    return (
        `${RAW_BASE}/` +
        `${encodeURIComponent(sourceCategory)}/` +
        `${sourceNumber}.gif`
    );
}

async function downloadCategory(targetCategory, wantedCount) {

    const config =
        CATEGORY_MAP[targetCategory];

    if (!config) {
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

    const metadataFile =
        path.join(
            folder,
            "metadata.json"
        );

    const metadata =
        loadMetadata(metadataFile);

    const seen =
        new Set(
            metadata
                .map(item => item.sourceUrl || item.url)
                .filter(Boolean)
        );

    let outputIndex =
        nextIndex(folder);

    let saved = 0;

    const candidates =
        shuffle(
            Array.from(
                { length: config.count },
                (_, index) => index + 1
            )
        );

    console.log(
        `\n📦 ${targetCategory}: downloading up to ${wantedCount} new clip(s) from GitHub folder "${config.source}"...`
    );

    for (const sourceNumber of candidates) {

        if (saved >= wantedCount) {
            break;
        }

        const url =
            sourceUrl(
                config.source,
                sourceNumber
            );

        if (seen.has(url)) {
            continue;
        }

        const stem =
            String(outputIndex)
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
                `  ⬇️ ${targetCategory} ${stem} (source #${sourceNumber})... `
            );

            const buffer =
                await downloadBuffer(url);

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
                file:
                    `${stem}.mp4`,
                category:
                    targetCategory,
                sourceCategory:
                    config.source,
                sourceNumber,
                sourceUrl:
                    url,
                repository:
                    `${SOURCE_OWNER}/${SOURCE_REPO}`,
                downloadedAt:
                    new Date().toISOString()
            });

            saveMetadata(
                metadataFile,
                metadata
            );

            seen.add(url);

            console.log("✅");

            saved++;
            outputIndex++;

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

    const remainingAvailable =
        Math.max(
            0,
            config.count - seen.size
        );

    console.log(
        `✅ ${targetCategory}: saved ${saved}/${wantedCount} new clip(s) to ${path.relative(ROOT, folder)}`
    );

    if (
        saved < wantedCount &&
        remainingAvailable === 0
    ) {
        console.log(
            `ℹ️ No unseen source GIFs remain for ${targetCategory}.`
        );
    }

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
