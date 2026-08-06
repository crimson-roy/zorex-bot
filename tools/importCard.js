// tools/importCard.js
//
// Mazoku card importer
//
// Usage:
//   node tools/importCard.js "Rem"
//   node tools/importCard.js "Rem" --all
//   node tools/importCard.js "69f4fdd0-9ca0-4dde-ab7f-81aa81f18a54"
//
// IMPORTANT:
// - BOT_ID is the short ID used by Zorex (.cs <BOT_ID>)
// - mazokuId is Mazoku's long UUID and is stored separately
// - The importer generates the BOT_ID automatically
// - Images are downloaded only when they do not already exist
//
// Supported tiers:
//   UR, SSR, SR, S, R, C

const fs = require("fs");
const path = require("path");
const https = require("https");

const CARD_FILE = path.join(__dirname, "..", "card.json");
const CARD_DIR = path.join(__dirname, "..", "cards");

const MAZOKU_API = "https://api.mazoku.cc/cards";
const MAZOKU_CDN = "https://cdn7.mazoku.cc/cards";

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
// FILE HELPERS
// --------------------------------------------------

function loadCards() {

    if (!fs.existsSync(CARD_FILE)) {

        fs.writeFileSync(
            CARD_FILE,
            "{}",
            "utf8"
        );

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
//
// This is the ID Zorex uses with:
//
//   .cs <BOT_ID>
//
// Mazoku UUID is stored separately as:
//
//   mazokuId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
//
// --------------------------------------------------

function generateBotId(cards) {

    let botId;

    do {

        // 8-digit BOT ID
        botId = String(
            Math.floor(
                10000000 +
                Math.random() * 90000000
            )
        );

    } while (cards[botId]);

    return botId;

}

// --------------------------------------------------
// MAZOKU API ERROR HANDLER
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

    console.log(
        `📡 Fetching Mazoku page ${page}...`
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

    return await response.json();

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
        `&order=ASC`;

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
//
// IMPORTANT:
//
// Instead of doing:
//
//   page 1
//   page 2
//   page 3
//   ...
//   page 121
//
// we now ask Mazoku:
//
//   ?name=Makima
//
// This lets the API perform the search.
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
// SEARCH
// --------------------------------------------------

async function searchCards(
    searchTerm
) {

    const cleanSearch =
        searchTerm.trim();

    // Mazoku UUID format
    const looksLikeId =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            .test(cleanSearch);

    if (looksLikeId) {

        return searchByMazokuId(
            cleanSearch
        );

    }

    // Use Mazoku's server-side name search
    return searchByName(
        cleanSearch
    );

}

// --------------------------------------------------
// IMAGE PATHS
// --------------------------------------------------
//
// Images use the BOT_ID filename so our local card
// system remains completely independent from Mazoku.
//
// Example:
//
// BOT ID:
// 48372915
//
// Image:
// cards/48372915.webp
//
// Mazoku UUID:
// 69f4fdd0-9ca0-4dde-ab7f-81aa81f18a54
//
// --------------------------------------------------

function getImagePath(botId) {

    return path.join(
        CARD_DIR,
        `${botId}.webp`
    );

}

function getImageRelativePath(botId) {

    return `./cards/${botId}.webp`;

}

// --------------------------------------------------
// DOWNLOAD IMAGE
// --------------------------------------------------

function downloadImage(
    url,
    destination
) {

    return new Promise(
        (resolve, reject) => {

            const file =
                fs.createWriteStream(
                    destination
                );

            const request =
                https.get(
                    url,
                    response => {

                        // Handle redirects
                        if (
                            response.statusCode >= 300 &&
                            response.statusCode < 400 &&
                            response.headers.location
                        ) {

                            file.close();

                            fs.unlink(
                                destination,
                                () => {}
                            );

                            return downloadImage(
                                response.headers.location,
                                destination
                            )
                                .then(resolve)
                                .catch(reject);

                        }

                        if (
                            response.statusCode !== 200
                        ) {

                            file.close();

                            fs.unlink(
                                destination,
                                () => {}
                            );

                            reject(
                                new Error(
                                    `Image download failed: ${response.statusCode}`
                                )
                            );

                            return;

                        }

                        response.pipe(file);

                        file.on(
                            "finish",
                            () => {

                                file.close(
                                    () => {
                                        resolve();
                                    }
                                );

                            }
                        );

                    }
                );

            request.on(
                "error",
                err => {

                    file.close();

                    fs.unlink(
                        destination,
                        () => {}
                    );

                    reject(err);

                }
            );

        }
    );

}

// --------------------------------------------------
// DUPLICATE CHECK
// --------------------------------------------------
//
// We DO NOT use the Mazoku UUID as the Zorex card ID.
//
// Instead, search through card.json for:
//
//   mazokuId === Mazoku UUID
//
// This prevents importing the same Mazoku card twice,
// even if the BOT_ID is different.
// --------------------------------------------------

function findExistingCard(
    cards,
    mazokuId
) {

    for (
        const [botId, card] of Object.entries(cards)
    ) {

        if (
            card &&
            card.mazokuId &&
            String(card.mazokuId).toLowerCase() ===
            String(mazokuId).toLowerCase()
        ) {

            return botId;

        }

    }

    return null;

}

// --------------------------------------------------
// IMPORT ONE CARD
// --------------------------------------------------

async function importOne(
    card,
    cards
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

    // --------------------------------------------------
    // CHECK IF MAZOKU CARD ALREADY EXISTS
    // --------------------------------------------------

    const existingBotId =
        findExistingCard(
            cards,
            mazokuId
        );

    if (existingBotId) {

        console.log(
            `   ⏭️ "${name}" already imported.`
        );

        console.log(
            `      BOT ID: ${existingBotId}`
        );

        console.log(
            `      Mazoku ID: ${mazokuId}`
        );

        return null;

    }

    // --------------------------------------------------
    // VALIDATE TIER
    // --------------------------------------------------

    if (!TIER_VALUES[tier]) {

        console.log(
            `   ⚠️ "${name}" has unsupported Mazoku tier "${tier}".`
        );

        return null;

    }

    // --------------------------------------------------
    // GENERATE ZOREX BOT ID
    // --------------------------------------------------

    const botId =
        generateBotId(cards);

    ensureCardDirectory();

    const imagePath =
        getImagePath(botId);

    const imageRelativePath =
        getImageRelativePath(botId);

    // --------------------------------------------------
    // IMAGE DOWNLOAD CHECK
    // --------------------------------------------------

    if (fs.existsSync(imagePath)) {

        console.log(
            `   ♻️ Image already downloaded — skipping download.`
        );

    } else {

        const imageUrl =
            `${MAZOKU_CDN}/${mazokuId}.webp?width=750`;

        console.log(
            `   ⬇️ Downloading ${name}...`
        );

        console.log(
            `   🌐 ${imageUrl}`
        );

        await downloadImage(
            imageUrl,
            imagePath
        );

        console.log(
            `   ✅ Image saved → ${imageRelativePath}`
        );

    }

    // --------------------------------------------------
    // TIER VALUE
    // --------------------------------------------------

    const {
        min,
        max
    } = TIER_VALUES[tier];

    // --------------------------------------------------
    // SAVE CARD
    // --------------------------------------------------
    //
    // IMPORTANT:
    //
    // card.json key = BOT ID
    //
    // mazokuId = Mazoku's UUID
    //
    // This means .cs continues to use:
    //
    // .cs 48372915
    //
    // NOT:
    //
    // .cs 69f4fdd0-9ca0-4dde-ab7f-81aa81f18a54
    //
    // --------------------------------------------------

    cards[botId] = {

        name,

        series,

        tier,

        valueMin: min,

        valueMax: max,

        type: "card",

        image: imageRelativePath,

        // Mazoku's original card UUID
        mazokuId,

        eventName:
            card.eventName ||
            null,

        special:
            Boolean(card.special)

    };

    console.log(
        `   ✅ Imported ${name} [${tier}]`
    );

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

    const positional =
        args.filter(
            arg => arg !== "--all"
        );

    const searchTerm =
        positional.join(" ").trim();

    if (!searchTerm) {

        console.log(`
Usage:

  node tools/importCard.js "character name"

  node tools/importCard.js "character name" --all

  node tools/importCard.js "MAZOKU-CARD-UUID"

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
        await searchCards(
            searchTerm
        );

    if (!results.length) {

        console.log(
            `❌ No Mazoku cards found for "${searchTerm}".`
        );

        return;

    }

    // --------------------------------------------------
    // SORT RESULTS BY TIER
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
        let skipped = 0;
        let failed = 0;

        for (
            const card of results
        ) {

            try {

                const id =
                    await importOne(
                        card,
                        cards
                    );

                if (id) {

                    added++;

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

🎴 Added:   ${added}
♻️ Skipped: ${skipped}
❌ Failed:  ${failed}
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

    const id =
        await importOne(
            selected,
            cards
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