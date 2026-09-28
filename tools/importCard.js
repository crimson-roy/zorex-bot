// tools/importCard.js
//
// Mazoku card importer
//
// Usage:
//   node tools/importCard.js "Rem"
//   node tools/importCard.js "Rem" --all
//   node tools/importCard.js "69f4fdd0-9ca0-4dde-ab7f-81aa81f18a54"
//
// Media handling:
//   C / R / S / SR  -> downloaded as image and converted to JPG
//   SSR / UR        -> downloaded from Mazoku's video endpoint
//                    -> actual Content-Type is detected
//                    -> WebM is converted to REAL MP4
//
// IMPORTANT:
// Mazoku may return video/webm even when the URL ends in .mp4.
// Therefore we NEVER trust the URL extension.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");

const CARD_FILE = path.join(__dirname, "..", "card.json");
const CARD_DIR = path.join(__dirname, "..", "cards");

const MAZOKU_API = "https://api.mazoku.cc/cards";
const MAZOKU_CDN = "https://cdn7.mazoku.cc/cards";

// Be polite to Mazoku's API during full-catalog scans. The normal importer
// only makes a few requests, but --missing can require 40+ pages.
const MAZOKU_PAGE_DELAY_MS = 850;
const MAZOKU_MAX_RETRIES = 8;

function sleep(ms) {
    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}

// --------------------------------------------------
// TIER VALUES
// --------------------------------------------------

const TIER_VALUES = {
    UR: {
        min: 1500000,
        max: 2000000
    },

    SSR: {
        min: 1000000,
        max: 1500000
    },

    SR: {
        min: 500000,
        max: 800000
    },

    S: {
        min: 350000,
        max: 500000
    },

    R: {
        min: 200000,
        max: 350000
    },

    C: {
        min: 50000,
        max: 100000
    }
};

const TIER_ORDER = [
    "UR",
    "SSR",
    "SR",
    "S",
    "R",
    "C"
];

// --------------------------------------------------
// ANIMATED TIERS
// --------------------------------------------------
//
// These are the tiers that should be animated.
//
// If Mazoku later adds another animated tier,
// simply add it here.
// --------------------------------------------------

const ANIMATED_TIERS = new Set([
    "UR",
    "SSR"
]);

// --------------------------------------------------
// FILE HELPERS
// --------------------------------------------------

function loadCards() {

    if (!fs.existsSync(CARD_FILE)) {
        fs.writeFileSync(CARD_FILE, "{}", "utf8");
    }

    try {

        return JSON.parse(
            fs.readFileSync(
                CARD_FILE,
                "utf8"
            )
        );

    } catch (err) {

        throw new Error(
            `Could not read card.json: ${err.message}`
        );

    }

}

function saveCards(cards) {

    fs.writeFileSync(
        CARD_FILE,
        JSON.stringify(cards, null, 2),
        "utf8"
    );

}

function ensureCardDirectory() {

    if (!fs.existsSync(CARD_DIR)) {

        fs.mkdirSync(
            CARD_DIR,
            {
                recursive: true
            }
        );

    }

}

// --------------------------------------------------
// BOT ID GENERATOR
// --------------------------------------------------

function generateBotId(cards) {

    let botId;

    do {

        // 8 hex characters, matching the style of your existing older
        // cards (e.g. "59e04c5d", "a7132fd0") — letters + numbers instead
        // of a plain numeric string.
        botId = require("crypto")
            .randomBytes(4)
            .toString("hex");

    } while (cards[botId]);

    return botId;

}

// --------------------------------------------------
// API ERROR
// --------------------------------------------------

async function getApiErrorMessage(response) {

    let message =
        `${response.status} ${response.statusText}`;

    try {

        const error =
            await response.json();

        if (error?.error?.message) {

            message =
                `${response.status}: ${error.error.message}`;

        } else if (error?.message) {

            message =
                `${response.status}: ${error.message}`;

        }

    } catch (_) {}

    return message;

}

// --------------------------------------------------
// MAZOKU API
// --------------------------------------------------

async function fetchMazokuPage(
    page = 1,
    pageSize = 100
) {

    const url =
        `${MAZOKU_API}` +
        `?page=${page}` +
        `&pageSize=${pageSize}` +
        `&orderBy=created_at` +
        `&order=DESC` +
        `&spicy=false`;

    for (
        let attempt = 0;
        attempt <= MAZOKU_MAX_RETRIES;
        attempt++
    ) {

        console.log(
            attempt === 0
                ? `📡 Fetching Mazoku page ${page}...`
                : `🔁 Retrying Mazoku page ${page} (attempt ${attempt + 1}/${MAZOKU_MAX_RETRIES + 1})...`
        );

        const response =
            await fetch(url);

        if (response.ok) {
            return await response.json();
        }

        const message =
            await getApiErrorMessage(response);

        // Full-catalog scans can hit Mazoku's rate limit. Respect the
        // server's Retry-After header when supplied; otherwise back off
        // progressively and retry the SAME page instead of losing the scan.
        if (
            response.status === 429 &&
            attempt < MAZOKU_MAX_RETRIES
        ) {

            const retryAfter =
                Number(
                    response.headers.get("retry-after")
                );

            const waitMs =
                Number.isFinite(retryAfter) &&
                retryAfter > 0
                    ? Math.ceil(retryAfter * 1000)
                    : Math.min(
                        5000 * Math.pow(2, attempt),
                        60000
                    );

            console.log(
                `   ⏳ Mazoku rate limit hit. Waiting ${Math.ceil(waitMs / 1000)}s before retrying page ${page}...`
            );

            await sleep(waitMs);

            continue;
        }

        throw new Error(
            `Mazoku API failed: ${message}`
        );

    }

    throw new Error(
        `Mazoku API failed after ${MAZOKU_MAX_RETRIES + 1} attempts on page ${page}.`
    );

}

// --------------------------------------------------
// SEARCH BY MAZOKU UUID
// --------------------------------------------------

async function searchByMazokuId(
    mazokuId
) {

   const url =
    `${MAZOKU_API}` +
    `?cardId=${encodeURIComponent(mazokuId)}` +
    `&page=1` +
    `&pageSize=100` +
    `&orderBy=version` +
    `&order=ASC` +
    `&spicy=false`;

    console.log(
        `📡 Looking up Mazoku ID...`
    );

    const response =
        await fetch(url);

    if (!response.ok) {

        const message =
            await getApiErrorMessage(response);

        throw new Error(
            `Mazoku API failed: ${message}`
        );

    }

    const data =
        await response.json();

    return Array.isArray(data.cards)
        ? data.cards
        : [];

}

// --------------------------------------------------
// SEARCH BY NAME
// --------------------------------------------------

async function searchByName(
    searchTerm
) {

    const cleanSearch =
        searchTerm.trim();

    const url =
        `${MAZOKU_API}` +
        `?page=1` +
        `&pageSize=100` +
        `&orderBy=created_at` +
        `&order=DESC` +
        `&spicy=false` +
        `&name=${encodeURIComponent(cleanSearch)}`;

    console.log(
        `📡 Searching Mazoku for "${cleanSearch}"...`
    );

    const response =
        await fetch(url);

    if (!response.ok) {

        const message =
            await getApiErrorMessage(response);

        throw new Error(
            `Mazoku API failed: ${message}`
        );

    }

    const data =
        await response.json();

    return Array.isArray(data.cards)
        ? data.cards
        : [];

}

// --------------------------------------------------
// SEARCH BY SERIES
// --------------------------------------------------
//
// Tries a direct seriesName query param first, mirroring how
// searchByName() uses &name=. Mazoku's API isn't publicly documented,
// so this isn't confirmed to work — if it comes back empty, this falls
// back to paginating fetchMazokuPage() and filtering on card.seriesName
// client-side, which is slower but guaranteed correct regardless of
// what the query param actually does.

async function searchBySeriesDirect(
    seriesTerm
) {

    const cleanSearch =
        seriesTerm.trim();

    const url =
        `${MAZOKU_API}` +
        `?page=1` +
        `&pageSize=100` +
        `&orderBy=created_at` +
        `&order=DESC` +
        `&spicy=false` +
        `&seriesName=${encodeURIComponent(cleanSearch)}`;

    console.log(
        `📡 Searching Mazoku by series "${cleanSearch}"...`
    );

    const response =
        await fetch(url);

    if (!response.ok) {

        const message =
            await getApiErrorMessage(response);

        throw new Error(
            `Mazoku API failed: ${message}`
        );

    }

    const data =
        await response.json();

    return Array.isArray(data.cards)
        ? data.cards
        : [];

}

async function searchBySeriesPaginated(
    seriesTerm
) {

    const cleanSearch =
        seriesTerm.trim().toLowerCase();

    let page = 1;
    let allMatches = [];
    let keepGoing = true;

    while (keepGoing) {

        const data =
            await fetchMazokuPage(page, 100);

        const results =
            Array.isArray(data.cards)
                ? data.cards
                : [];

        if (results.length === 0) {

            keepGoing = false;
            break;

        }

        const matches =
            results.filter(
                card =>
                    (card.seriesName || "")
                        .toLowerCase()
                        .includes(cleanSearch)
            );

        allMatches = allMatches.concat(matches);

        if (results.length < 100) {
            keepGoing = false;
        } else {
            page++;
        }

    }

  const uniqueCards = new Map();

for (const card of allMatches) {

    if (!card?.id) {
        continue;
    }

    uniqueCards.set(
        String(card.id).toLowerCase(),
        card
    );

}

return [...uniqueCards.values()];

}

async function searchBySeries(
    seriesTerm
) {

    const direct =
        await searchBySeriesDirect(seriesTerm);

    if (direct.length > 0) {

        console.log(
            `   ✅ Direct seriesName query worked (${direct.length} result(s)).`
        );

        return direct;

    }

    console.log(
        `   ⚠️ Direct seriesName query returned nothing — falling back to full page scan...`
    );

    return await searchBySeriesPaginated(seriesTerm);

}

// --------------------------------------------------
// FULL CATALOG / MISSING-CARD AUDIT
// --------------------------------------------------

async function fetchAllMazokuCards() {

    let page = 1;
    const all = [];

    while (true) {

        const data =
            await fetchMazokuPage(page, 100);

        const results =
            Array.isArray(data.cards)
                ? data.cards
                : [];

        if (results.length === 0) {
            break;
        }

        all.push(...results);

        console.log(
            `   📚 Catalog so far: ${all.length} cards`
        );

        if (results.length < 100) {
            break;
        }

        page++;

        // --missing walks the entire public catalog, so leave a short gap
        // between pages rather than firing dozens of requests back-to-back.
        await sleep(MAZOKU_PAGE_DELAY_MS);
    }

    // Deduplicate by Mazoku UUID in case the API ever repeats an item
    // across page boundaries while new cards are being added.
    const unique = new Map();

    for (const card of all) {

        if (!card?.id) {
            continue;
        }

        unique.set(
            String(card.id).toLowerCase(),
            card
        );
    }

    return [...unique.values()];
}

function buildMissingCardReport(missing) {

    const grouped = new Map();

    for (const card of missing) {

        const series =
            card.seriesName ||
            "Unknown series";

        if (!grouped.has(series)) {
            grouped.set(series, []);
        }

        grouped.get(series).push(card);
    }

    const tierRank =
        tier => {
            const index =
                TIER_ORDER.indexOf(
                    String(tier || "C").toUpperCase()
                );

            return index === -1
                ? 999
                : index;
        };

    const lines = [];

    lines.push("ZOREX — MISSING MAZOKU CARDS");
    lines.push("================================");
    lines.push(`Missing cards: ${missing.length}`);
    lines.push(`Affected series: ${grouped.size}`);
    lines.push("");

    const sortedSeries =
        [...grouped.entries()]
            .sort(
                ([a], [b]) =>
                    a.localeCompare(b)
            );

    for (const [series, cards] of sortedSeries) {

        cards.sort(
            (a, b) =>
                tierRank(a.tier) - tierRank(b.tier) ||
                String(a.name || "").localeCompare(
                    String(b.name || "")
                )
        );

        lines.push(
            `=== ${series} (${cards.length} missing) ===`
        );

        cards.forEach(
            (card, index) => {

                lines.push(
                    `${index + 1}. [${String(card.tier || "C").toUpperCase()}] ${card.name || "Unknown"}`
                );

                lines.push(
                    `   Mazoku ID: ${card.id}`
                );
            }
        );

        lines.push("");
    }

    return lines.join("\n");
}

async function auditMissingCards() {

    console.log(
        "\n🔎 Scanning local card.json..."
    );

    const cards =
        loadCards();

    const importedIds =
        new Set(
            Object.values(cards)
                .map(card => card?.mazokuId)
                .filter(Boolean)
                .map(id => String(id).toLowerCase())
        );

    console.log(
        `✅ Local cards with Mazoku IDs: ${importedIds.size}`
    );

    console.log(
        "\n🌐 Scanning the full Mazoku catalog..."
    );

    const catalog =
        await fetchAllMazokuCards();

    const missing =
        catalog.filter(
            card =>
                card?.id &&
                !importedIds.has(
                    String(card.id).toLowerCase()
                )
        );

    missing.sort(
        (a, b) =>
            String(a.seriesName || "")
                .localeCompare(
                    String(b.seriesName || "")
                ) ||
            TIER_ORDER.indexOf(
                String(a.tier || "C").toUpperCase()
            ) -
            TIER_ORDER.indexOf(
                String(b.tier || "C").toUpperCase()
            ) ||
            String(a.name || "")
                .localeCompare(
                    String(b.name || "")
                )
    );

    const report =
        buildMissingCardReport(missing);

    const reportPath =
        path.join(
            __dirname,
            "..",
            "missing-cards.txt"
        );

    const jsonPath =
        path.join(
            __dirname,
            "..",
            "missing-cards.json"
        );

    fs.writeFileSync(
        reportPath,
        report,
        "utf8"
    );

    fs.writeFileSync(
        jsonPath,
        JSON.stringify(missing, null, 2),
        "utf8"
    );

    const affectedSeries =
        new Set(
            missing.map(
                card =>
                    card.seriesName ||
                    "Unknown series"
            )
        );

    console.log(
        `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 MAZOKU CARD AUDIT

🌐 Mazoku catalog: ${catalog.length}
✅ Already imported: ${catalog.length - missing.length}
❌ Missing: ${missing.length}
📚 Series affected: ${affectedSeries.size}

📝 Full readable report:
${reportPath}

📦 JSON report:
${jsonPath}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
    );

    if (missing.length === 0) {

        console.log(
            "🎉 You currently have every non-spicy card returned by Mazoku."
        );

        return;
    }

    console.log(
        "First 25 missing cards:\n"
    );

    missing.slice(0, 25).forEach(
        (card, index) => {

            console.log(
                `${index + 1}. [${card.tier || "C"}] ${card.name} — ${card.seriesName || "Unknown series"}`
            );
        }
    );

    if (missing.length > 25) {

        console.log(
            `\n...and ${missing.length - 25} more. Open missing-cards.txt for the complete list.`
        );
    }
}

// --------------------------------------------------
// SEARCH
// --------------------------------------------------

async function searchCards(
    searchTerm
) {

    const cleanSearch =
        searchTerm.trim();

    const looksLikeId =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            .test(cleanSearch);

    if (looksLikeId) {

        return searchByMazokuId(
            cleanSearch
        );

    }

    return searchByName(
        cleanSearch
    );

}

// --------------------------------------------------
// MEDIA TYPE
// --------------------------------------------------

function isAnimatedTier(tier) {

    return ANIMATED_TIERS.has(
        String(tier).toUpperCase()
    );

}

// --------------------------------------------------
// FILE PATHS
// --------------------------------------------------

function getImagePath(botId) {

    return path.join(
        CARD_DIR,
        `${botId}.jpg`
    );

}

function getVideoPath(botId) {

    return path.join(
        CARD_DIR,
        `${botId}.mp4`
    );

}

function getImageRelativePath(botId) {

    return `./cards/${botId}.jpg`;

}

function getVideoRelativePath(botId) {

    return `./cards/${botId}.mp4`;

}

// --------------------------------------------------
// DELETE OLD MEDIA
// --------------------------------------------------

function removeOldMedia(botId) {

    const extensions = [
        ".webp",
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webm",
        ".mp4"
    ];

    for (const ext of extensions) {

        const file =
            path.join(
                CARD_DIR,
                `${botId}${ext}`
            );

        if (fs.existsSync(file)) {

            try {

                fs.unlinkSync(file);

                console.log(
                    `   🗑️ Removed old media: ${path.basename(file)}`
                );

            } catch (err) {

                console.warn(
                    `   ⚠️ Could not remove ${file}: ${err.message}`
                );

            }

        }

    }

}

// --------------------------------------------------
// FETCH MEDIA
// --------------------------------------------------
//
// Returns:
//
// {
//   buffer,
//   contentType
// }
//
// We inspect Content-Type instead of trusting
// ".webp", ".mp4", or ".gif" in the URL.
// --------------------------------------------------

async function fetchMedia(
    url
) {

    console.log(
        `   🌐 ${url}`
    );

    const response =
        await fetch(url);

    if (!response.ok) {

        throw new Error(
            `Media download failed: ${response.status} ${response.statusText}`
        );

    }

    const contentType =
        (
            response.headers.get("content-type") ||
            ""
        )
        .split(";")[0]
        .trim()
        .toLowerCase();

    const buffer =
        Buffer.from(
            await response.arrayBuffer()
        );

    console.log(
        `   📦 HTTP ${response.status}`
    );

    console.log(
        `   📄 Content-Type: ${contentType || "unknown"}`
    );

    console.log(
        `   📏 Size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`
    );

    return {
        buffer,
        contentType
    };

}

// --------------------------------------------------
// SAVE STATIC IMAGE
// --------------------------------------------------
//
// Mazoku gives us WebP.
// We convert it to a real JPG.
//
// This prevents WhatsApp from having to deal with
// the original WebP file.
// --------------------------------------------------

async function saveStaticImage(
    buffer,
    destination
) {

    await sharp(buffer)
        .jpeg({
            quality: 95,
            mozjpeg: true
        })
        .toFile(destination);

}

// --------------------------------------------------
// RUN FFMPEG
// --------------------------------------------------

function runFFmpeg(
    input,
    output
) {

    return new Promise(
        (resolve, reject) => {

            console.log(
                `   🎬 Converting video to MP4...`
            );

            const args = [
                "-y",

                "-i",
                input,

                // Keep the card vertical while making sure
                // WhatsApp receives a normal MP4.
                "-vf",
                "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2",

                "-c:v",
                "libx264",

                "-pix_fmt",
                "yuv420p",

                "-movflags",
                "+faststart",

                // Cards don't need audio.
                "-an",

                output
            ];

            const ffmpeg =
                spawn(
                    "ffmpeg",
                    args,
                    {
                        windowsHide: true
                    }
                );

            let stderr = "";

            ffmpeg.stderr.on(
                "data",
                data => {

                    stderr +=
                        data.toString();

                }
            );

            ffmpeg.on(
                "error",
                err => {

                    reject(
                        new Error(
                            `Could not start FFmpeg. Make sure FFmpeg is installed and available in PATH.\n${err.message}`
                        )
                    );

                }
            );

            ffmpeg.on(
                "close",
                code => {

                    if (code === 0) {

                        resolve();

                    } else {

                        reject(
                            new Error(
                                `FFmpeg exited with code ${code}\n${stderr.slice(-2000)}`
                            )
                        );

                    }

                }
            );

        }
    );

}

// --------------------------------------------------
// SAVE ANIMATED CARD
// --------------------------------------------------
//
// Mazoku's ".mp4" endpoint can return video/webm.
//
// We therefore:
//   1. Fetch it
//   2. Inspect Content-Type
//   3. Save the original response as a temporary file
//   4. Let FFmpeg read it based on actual media data
//   5. Produce a genuine MP4
// --------------------------------------------------

async function saveAnimatedVideo(
    buffer,
    contentType,
    botId
) {

    const tempExtension =
        contentType.includes("webm")
            ? ".webm"
            : contentType.includes("mp4")
                ? ".mp4"
                : ".media";

    const tempPath =
        path.join(
            CARD_DIR,
            `.tmp_${botId}${tempExtension}`
        );

    const outputPath =
        getVideoPath(botId);

    try {

        fs.writeFileSync(
            tempPath,
            buffer
        );

        console.log(
            `   💾 Temporary media: ${path.basename(tempPath)}`
        );

        // If Mazoku really returns MP4, FFmpeg still normalizes
        // it into our WhatsApp-friendly MP4.
        await runFFmpeg(
            tempPath,
            outputPath
        );

        if (!fs.existsSync(outputPath)) {

            throw new Error(
                "FFmpeg finished but the MP4 file was not created."
            );

        }

        const size =
            fs.statSync(outputPath).size;

        if (size === 0) {

            throw new Error(
                "Generated MP4 is empty."
            );

        }

        console.log(
            `   ✅ MP4 saved → ${getVideoRelativePath(botId)}`
        );

        console.log(
            `   📏 Final size: ${(size / 1024 / 1024).toFixed(2)} MB`
        );

    } finally {

        if (fs.existsSync(tempPath)) {

            try {
                fs.unlinkSync(tempPath);
            } catch (_) {}

        }

    }

}

// --------------------------------------------------
// FIND EXISTING CARD
// --------------------------------------------------

function buildMazokuIndex(cards) {

    const index = new Map();

    for (const [botId, card] of Object.entries(cards)) {

        if (!card?.mazokuId) {
            continue;
        }

        index.set(
            String(card.mazokuId).toLowerCase(),
            botId
        );

    }

    return index;

}

function findExistingCard(
    mazokuIndex,
    mazokuId
) {

    if (!mazokuId) {
        return null;
    }

    return (
        mazokuIndex.get(
            String(mazokuId).toLowerCase()
        ) || null
    );

}

// --------------------------------------------------
// IMPORT / REPAIR ONE CARD
// --------------------------------------------------

async function importOne(
    card,
    cards,
    mazokuIndex
) {

    const mazokuId =
        card.id;

    if (!mazokuId) {

        console.log(
            `   ⚠️ Skipping card without Mazoku ID.`
        );

        return null;

    }

    const name =
        card.name ||
        "Unknown";

    const series =
        card.seriesName ||
        "Unknown series";

    const tier =
        String(
            card.tier ||
            "C"
        ).toUpperCase();

    if (!TIER_VALUES[tier]) {

        console.log(
            `   ⚠️ "${name}" has unsupported Mazoku tier "${tier}".`
        );

        return null;

    }

    // --------------------------------------------------
    // FIND EXISTING CARD
    // --------------------------------------------------

    let botId =
    findExistingCard(
        mazokuIndex,
        mazokuId
    );

    const alreadyExists =
        Boolean(botId);

    if (!botId) {

        botId =
            generateBotId(cards);

        console.log(
            `   🆕 New card`
        );

        console.log(
            `      BOT ID: ${botId}`
        );

mazokuIndex.set(
    String(mazokuId).toLowerCase(),
    botId
);

    } else {

        console.log(
            `   🔎 Existing card found`
        );

        console.log(
            `      BOT ID: ${botId}`
        );

    }

    ensureCardDirectory();

    // --------------------------------------------------
    // DETERMINE MEDIA TYPE
    // --------------------------------------------------

    const animated =
        isAnimatedTier(tier);

    console.log(
        `   🎞️ Media type: ${animated ? "ANIMATED VIDEO" : "STATIC IMAGE"}`
    );

    // --------------------------------------------------
    // ANIMATED CARD
    // --------------------------------------------------

    if (animated) {

        const videoPath =
            getVideoPath(botId);

        const imagePath =
            getImagePath(botId);

        // If it already has a real MP4, don't download again.
        // BUT if card.json currently points to an image,
        // we repair it.
        const hasValidVideo =
            fs.existsSync(videoPath) &&
            fs.statSync(videoPath).size > 0;

        if (hasValidVideo) {

            console.log(
                `   ✅ Existing MP4 found — keeping it.`
            );

        } else {

            // Remove stale image/media before creating the video.
            removeOldMedia(botId);

            const videoUrl =
                `${MAZOKU_CDN}/${mazokuId}.mp4?width=750`;

            console.log(
                `   ⬇️ Downloading animated ${name}...`
            );

            const media =
                await fetchMedia(
                    videoUrl
                );

            // IMPORTANT:
            // We don't care that the URL says .mp4.
            // Mazoku may return video/webm.
            if (
                !media.contentType.startsWith("video/")
            ) {

                throw new Error(
                    `Expected animated media, but Mazoku returned "${media.contentType || "unknown"}".`
                );

            }

            await saveAnimatedVideo(
                media.buffer,
                media.contentType,
                botId
            );

        }

        // Make absolutely sure the card points to video.
        cards[botId] = {

            name,

            series,

            tier,

            valueMin:
                TIER_VALUES[tier].min,

            valueMax:
                TIER_VALUES[tier].max,

            type: "card",

            video:
                getVideoRelativePath(botId),

            mazokuId,

            eventName:
                card.eventName ||
                null,

            special:
                Boolean(card.special)

        };

    }

    // --------------------------------------------------
    // STATIC CARD
    // --------------------------------------------------

    else {

        const imagePath =
            getImagePath(botId);

        const videoPath =
            getVideoPath(botId);

        const hasValidImage =
            fs.existsSync(imagePath) &&
            fs.statSync(imagePath).size > 0;

        if (hasValidImage) {

            console.log(
                `   ✅ Existing JPG found — keeping it.`
            );

        } else {

            removeOldMedia(botId);

            const imageUrl =
                `${MAZOKU_CDN}/${mazokuId}.webp?width=750`;

            console.log(
                `   ⬇️ Downloading ${name}...`
            );

            const media =
                await fetchMedia(
                    imageUrl
                );

            if (
                !media.contentType.startsWith("image/")
            ) {

                throw new Error(
                    `Expected an image, but Mazoku returned "${media.contentType || "unknown"}".`
                );

            }

            await saveStaticImage(
                media.buffer,
                imagePath
            );

            console.log(
                `   ✅ JPG saved → ${getImageRelativePath(botId)}`
            );

        }

        // Make sure static cards aren't still pointing
        // at an old video.
        if (fs.existsSync(videoPath)) {

            try {
                fs.unlinkSync(videoPath);
            } catch (_) {}

        }

        cards[botId] = {

            name,

            series,

            tier,

            valueMin:
                TIER_VALUES[tier].min,

            valueMax:
                TIER_VALUES[tier].max,

            type: "card",

            image:
                getImageRelativePath(botId),

            mazokuId,

            eventName:
                card.eventName ||
                null,

            special:
                Boolean(card.special)

        };

    }

    if (alreadyExists) {

        console.log(
            `   🔧 Card repaired/verified successfully.`
        );

    } else {

        console.log(
            `   ✅ Imported ${name} [${tier}]`
        );

    }

    console.log(
        `      BOT ID: ${botId}`
    );

    console.log(
        `      Mazoku ID: ${mazokuId}`
    );

    return botId;

}

// --------------------------------------------------
// MAIN
// --------------------------------------------------

async function main() {

    const args =
        process.argv.slice(2);

    const bulkMode =
        args.includes("--all");

    const seriesMode =
        args.includes("--series");

    const missingMode =
        args.includes("--missing");

    const positional =
        args.filter(
            arg =>
                arg !== "--all" &&
                arg !== "--series" &&
                arg !== "--missing"
        );

    const searchTerm =
        positional.join(" ").trim();

    if (missingMode) {

        await auditMissingCards();

        return;
    }

    if (!searchTerm) {

        console.log(`
Usage:

  node tools/importCard.js "character name"

  node tools/importCard.js "character name" --all

  node tools/importCard.js "MAZOKU-CARD-UUID"

  node tools/importCard.js --missing

Examples:

  node tools/importCard.js "Rem"

  node tools/importCard.js "Makima"

  node tools/importCard.js "Uta" --all

  node tools/importCard.js "22eceb73-8e8e-4aae-b9c6-7e2b6c565d2d"
`);

        return;

    }

    console.log(
        `\n🌐 Connecting to Mazoku...\n`
    );

    console.log(
        `🔍 Searching for "${searchTerm}"...\n`
    );

    const results =
        seriesMode
            ? await searchBySeries(searchTerm)
            : await searchCards(searchTerm);

    if (!results.length) {

        console.log(
            `❌ No Mazoku cards found for "${searchTerm}".`
        );

        return;

    }

    // --------------------------------------------------
    // SORT BY TIER
    // --------------------------------------------------

    results.sort(
        (a, b) => {

            const tierA =
                TIER_ORDER.indexOf(
                    String(
                        a.tier ||
                        "C"
                    ).toUpperCase()
                );

            const tierB =
                TIER_ORDER.indexOf(
                    String(
                        b.tier ||
                        "C"
                    ).toUpperCase()
                );

            return (
                (tierA === -1 ? 999 : tierA) -
                (tierB === -1 ? 999 : tierB)
            );

        }
    );

    console.log(
        `\n🎴 Found ${results.length} result(s):\n`
    );

    results.forEach(
        (card, index) => {

            const special =
                card.special
                    ? " ⭐ SPECIAL"
                    : "";

            console.log(
                `${index + 1}. ` +
                `${card.name} — ` +
                `${card.seriesName} ` +
                `[${card.tier}]` +
                `${special}`
            );

            console.log(
                `   Mazoku ID: ${card.id}`
            );

            if (card.eventName) {

                console.log(
                    `   Event: ${card.eventName}`
                );

            }

            console.log();

        }
    );
const cards =
    loadCards();

const mazokuIndex =
    buildMazokuIndex(cards);

    // --------------------------------------------------
    // BULK MODE
    // --------------------------------------------------

    if (bulkMode) {

        console.log(
            `📦 --all detected.`
        );

        console.log(
            `Importing all ${results.length} results...\n`
        );

        let added = 0;
        let repaired = 0;
        let skipped = 0;
        let failed = 0;

        for (
            const card of results
        ) {

          const existedBefore =
    Boolean(
        findExistingCard(
            mazokuIndex,
            card.id
        )
    );

            try {

             const id =
    await importOne(
        card,
        cards,
        mazokuIndex
    );
                if (id) {

                    if (existedBefore) {
                        repaired++;
                    } else {
                        added++;
                    }

                } else {

                    skipped++;

                }

            } catch (err) {

                failed++;

                console.error(
                    `   ❌ Failed: ${card.name} — ${err.message}`
                );

            }

        }

        saveCards(cards);

        console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Mazoku import complete

🎴 Added:    ${added}
🔧 Repaired: ${repaired}
♻️ Skipped:  ${skipped}
❌ Failed:   ${failed}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

        return;

    }

    // --------------------------------------------------
    // SINGLE PICK
    // --------------------------------------------------

    const readline =
        require("readline");

    const rl =
        readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

    const ask =
        question =>
            new Promise(
                resolve =>
                    rl.question(
                        question,
                        resolve
                    )
            );

    const choice =
        await ask(
            `Pick a number (1-${results.length}), or 0 to cancel: `
        );

    rl.close();

    const choiceNumber =
        Number(choice);

    const index =
        choiceNumber - 1;

    if (
        choice === "0" ||
        !Number.isInteger(choiceNumber) ||
        index < 0 ||
        index >= results.length
    ) {

        console.log(
            "Cancelled."
        );

        return;

    }

    const selected =
        results[index];

    console.log(
        `\n🎴 Selected: ${selected.name}`
    );

    console.log(
        `📚 Series: ${selected.seriesName}`
    );

    console.log(
        `🏷️ Tier: ${selected.tier}`
    );

    console.log(
        `🆔 Mazoku ID: ${selected.id}`
    );

   const existingBotId =
    findExistingCard(
        mazokuIndex,
        selected.id
    );

    if (existingBotId) {

        console.log(
            `🔧 Existing BOT ID found: ${existingBotId}`
        );

        console.log(
            `🔄 Checking/repairing its media...`
        );

    }
const id =
    await importOne(
        selected,
        cards,
        mazokuIndex
    );

    saveCards(cards);

    if (id) {

        console.log(
            `\n💾 Saved to card.json.`
        );

        console.log(
            `🎴 BOT ID: ${id}`
        );

        console.log(
            `👉 Use: .cs ${id}`
        );

    } else {

        console.log(
            `\nℹ️ No changes made.`
        );

    }

}

// --------------------------------------------------
// RUN
// --------------------------------------------------

main().catch(
    err => {

        console.error(
            `❌ Error: ${err.message}`
        );

        process.exitCode = 1;

    }
);