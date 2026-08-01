// tools/importCard.js
//
// Searches AniList's free character database and imports character(s)
// into card.json in the exact same shape as your existing cards.
//
// Single-pick mode (default) — shows matches, you choose one:
//   node tools/importCard.js "character name" TIER
//
// Bulk mode — imports EVERY match found, all at the same tier:
//   node tools/importCard.js "character name" TIER --all
//
// Example:
//   node tools/importCard.js "Rem" SSR
//   node tools/importCard.js "Rem" SSR --all
//
// TIER must be one of: SSR, SR, S, R, C

const fs = require("fs");
const path = require("path");
const https = require("https");
const readline = require("readline");
const crypto = require("crypto");

const CARD_FILE = path.join(__dirname, "..", "card.json");

// Value bands derived from your existing card.json entries.
const TIER_VALUES = {
    SSR: { min: 1000000, max: 1500000 },
    SR:  { min: 500000,  max: 800000  },
    S:   { min: 350000,  max: 500000  },
    R:   { min: 200000,  max: 350000  },
    C:   { min: 50000,   max: 100000  }
};

const ANILIST_URL = "https://graphql.anilist.co";

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => rl.question(question, resolve));
}

function loadCards() {
    if (!fs.existsSync(CARD_FILE)) {
        fs.writeFileSync(CARD_FILE, "{}");
    }
    return JSON.parse(fs.readFileSync(CARD_FILE, "utf8"));
}

function saveCards(cards) {
    fs.writeFileSync(CARD_FILE, JSON.stringify(cards, null, 2));
}

// Generates an 8-char lowercase hex ID, same shape as your existing keys
// (e.g. "59e04c5d"), and makes sure it doesn't collide with an existing one.
function generateCardId(existingCards) {

    let id;

    do {
        id = crypto.randomBytes(4).toString("hex");
    } while (existingCards[id]);

    return id;

}

// AniList GraphQL character search — free, no API key required.
async function searchCharacters(name) {

    const query = `
        query ($search: String) {
            Page(page: 1, perPage: 10) {
                characters(search: $search) {
                    id
                    name {
                        full
                    }
                    image {
                        large
                    }
                    media(perPage: 1) {
                        nodes {
                            title {
                                romaji
                                english
                            }
                        }
                    }
                }
            }
        }
    `;

    const response = await fetch(ANILIST_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify({ query, variables: { search: name } })
    });

    if (!response.ok) {
        throw new Error(`AniList request failed: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();

    return json.data.Page.characters;

}

function downloadImage(url, destPath) {

    return new Promise((resolve, reject) => {

        const file = fs.createWriteStream(destPath);

        https.get(url, (res) => {

            if (res.statusCode !== 200) {
                reject(new Error(`Image download failed: ${res.statusCode}`));
                return;
            }

            res.pipe(file);

            file.on("finish", () => {
                file.close(resolve);
            });

        }).on("error", (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });

    });

}

function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function getSeriesTitle(character) {
    return (
        character.media.nodes[0]?.title.english ||
        character.media.nodes[0]?.title.romaji ||
        "Unknown series"
    );
}

// Builds a filename that includes the series, so two different characters
// with the same name (like your four Yuki cards) never collide —
// e.g. "rem_re_zero.jpg" vs "rem_some_other_anime.jpg"
function buildFileName(charName, seriesTitle) {
    return `${slugify(charName)}_${slugify(seriesTitle)}.jpg`;
}

// Checks whether a card with the same name + series already exists,
// case-insensitively. Prevents re-running an import from creating a
// second, functionally-identical card under a different ID.
function findExistingCard(cards, name, series) {

    const normalizedName = name.trim().toLowerCase();
    const normalizedSeries = series.trim().toLowerCase();

    for (const [id, card] of Object.entries(cards)) {

        if (
            card.name.trim().toLowerCase() === normalizedName &&
            card.series.trim().toLowerCase() === normalizedSeries
        ) {

            return id;

        }

    }

    return null;

}

async function importOne(character, tier, cards) {

    const series = getSeriesTitle(character);

    const existingId = findExistingCard(cards, character.name.full, series);

    if (existingId) {

        console.log(`   ⏭️  Skipped "${character.name.full}" (${series}) — already exists as #${existingId}`);

        return null;

    }

    const cardId = generateCardId(cards);
    const fileName = buildFileName(character.name.full, series);
    const imagePath = path.join(__dirname, "..", fileName);

    console.log(`\n⬇️  Downloading "${character.name.full}" (${series}) → ./${fileName}`);

    await downloadImage(character.image.large, imagePath);

    const { min, max } = TIER_VALUES[tier];

    cards[cardId] = {
        name: character.name.full,
        series,
        tier,
        valueMin: min,
        valueMax: max,
        type: "card",
        image: `./${fileName}`
    };

    console.log(`   ✅ Added as #${cardId}`);

    return cardId;

}

async function main() {

    const args = process.argv.slice(2);
    const bulkMode = args.includes("--all");
    const positional = args.filter(a => a !== "--all");

    const name = positional[0];
    const tier = (positional[1] || "").toUpperCase();

    if (!name || !TIER_VALUES[tier]) {

        console.log(`Usage:`);
        console.log(`  node tools/importCard.js "character name" TIER`);
        console.log(`  node tools/importCard.js "character name" TIER --all`);
        console.log(`TIER must be one of: ${Object.keys(TIER_VALUES).join(", ")}`);
        rl.close();
        return;

    }

    console.log(`\n🔍 Searching AniList for "${name}"...\n`);

    const results = await searchCharacters(name);

    if (results.length === 0) {
        console.log("❌ No characters found. Try a different spelling or name.");
        rl.close();
        return;
    }

    results.forEach((char, i) => {
        console.log(`${i + 1}. ${char.name.full}  —  ${getSeriesTitle(char)}`);
    });

    const cards = loadCards();

    // ---------- BULK MODE: import every result at the given tier ----------
    if (bulkMode) {

        console.log(`\n📦 --all flag detected — importing all ${results.length} matches as ${tier}...`);

        const confirm = await ask(`Continue? (y/n): `);

        if (confirm.trim().toLowerCase() !== "y") {
            console.log("Cancelled.");
            rl.close();
            return;
        }

        const addedIds = [];
        let skippedCount = 0;

        for (const character of results) {

            try {

                const id = await importOne(character, tier, cards);

                if (id) {
                    addedIds.push(id);
                } else {
                    skippedCount++;
                }

            } catch (err) {

                console.error(`   ❌ Failed to import "${character.name.full}": ${err.message}`);

            }

        }

        saveCards(cards);

        console.log(`\n✅ Bulk import complete — ${addedIds.length} added, ${skippedCount} skipped (duplicates), ${results.length - addedIds.length - skippedCount} failed.\n`);

        rl.close();
        return;

    }

    // ---------- SINGLE-PICK MODE (default) ----------
    const choice = await ask(`\nPick a number (1-${results.length}), or 0 to cancel: `);
    const index = Number(choice) - 1;

    if (choice === "0" || isNaN(index) || index < 0 || index >= results.length) {
        console.log("Cancelled.");
        rl.close();
        return;
    }

    const picked = results[index];

    const id = await importOne(picked, tier, cards);

    saveCards(cards);

    if (id) {
        console.log(`\n✅ Saved to card.json.\n`);
    } else {
        console.log(`\n(No changes made — this card already exists.)\n`);
    }

    rl.close();

}

main().catch(err => {
    console.error("❌ Error:", err.message);
    rl.close();
});