// tools/migrateCardIds.js
//
// One-time migration: rewrites every purely-numeric card ID in card.json
// to a new 8-char hex ID (matching the style importCard.js now generates
// going forward), and updates every reference to those IDs inside
// collection.json (each owned card entry stores its own `id`).
//
// Backs up both files (.bak) before writing anything. Only touches IDs
// that are purely numeric — any card already using an alphanumeric ID is
// left untouched.
//
// IMPORTANT: this script only knows about card.json and collection.json.
// If auction.js or trade.js persist a card ID anywhere in their own JSON
// files (e.g. an active auction listing, a pending trade offer), this
// migration will NOT update those — check auction.json / trades.json (or
// whatever those files are actually called) manually after running this,
// and consider running it only when there are no active auctions/trades
// in progress.
//
// Usage:
//   node tools/migrateCardIds.js          -> dry run, shows what WOULD change
//   node tools/migrateCardIds.js --apply  -> actually writes the changes

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dataPath = require("../lib/dataPath");

const CARD_FILE = path.join(__dirname, "..", "card.json");
const COLLECTION_FILE = dataPath("collection.json");

function generateHexId(existingIds) {

    let id;

    do {
        id = crypto.randomBytes(4).toString("hex");
    } while (existingIds.has(id));

    return id;

}

function backup(filePath) {

    if (!fs.existsSync(filePath)) return;

    const backupPath = `${filePath}.bak-${Date.now()}`;
    fs.copyFileSync(filePath, backupPath);
    console.log(`   💾 Backed up ${path.basename(filePath)} -> ${path.basename(backupPath)}`);

}

function main() {

    const apply = process.argv.includes("--apply");

    console.log(apply ? "🔧 APPLY MODE — files will be modified.\n" : "🔍 DRY RUN — no files will be modified. Use --apply to write changes.\n");

    if (!fs.existsSync(CARD_FILE)) {
        console.error("❌ card.json not found.");
        return;
    }

    const cards = JSON.parse(fs.readFileSync(CARD_FILE, "utf8"));

    const collection = fs.existsSync(COLLECTION_FILE)
        ? JSON.parse(fs.readFileSync(COLLECTION_FILE, "utf8"))
        : {};

    const existingIds = new Set(Object.keys(cards));
    const idMap = {}; // oldId -> newId, numeric IDs only

    for (const oldId of Object.keys(cards)) {

        if (!/^\d+$/.test(oldId)) continue; // already alphanumeric, skip

        const newId = generateHexId(existingIds);
        existingIds.add(newId);
        idMap[oldId] = newId;

    }

    if (Object.keys(idMap).length === 0) {
        console.log("✅ No purely-numeric card IDs found — nothing to migrate.");
        return;
    }

    console.log(`📋 ${Object.keys(idMap).length} card(s) will be renumbered:\n`);
    for (const [oldId, newId] of Object.entries(idMap)) {
        console.log(`   ${oldId}  ->  ${newId}   (${cards[oldId].name})`);
    }

    // Build new card.json
    const newCards = {};
    for (const [oldId, card] of Object.entries(cards)) {
        const newId = idMap[oldId] || oldId;
        newCards[newId] = card;
    }

    // Build new collection.json — update every owned-card entry's `id`
    let updatedOwnedCards = 0;
    const newCollection = {};

    for (const [userId, items] of Object.entries(collection)) {

        newCollection[userId] = (items || []).map(item => {

            if (idMap[item.id]) {
                updatedOwnedCards++;
                return { ...item, id: idMap[item.id] };
            }

            return item;

        });

    }

    console.log(`\n📦 ${updatedOwnedCards} owned-card entr${updatedOwnedCards === 1 ? "y" : "ies"} in collection.json will be updated.\n`);

    if (!apply) {
        console.log("Dry run complete — no files were changed. Re-run with --apply to write these changes.");
        return;
    }

    backup(CARD_FILE);
    backup(COLLECTION_FILE);

    fs.writeFileSync(CARD_FILE, JSON.stringify(newCards, null, 2));
    fs.writeFileSync(COLLECTION_FILE, JSON.stringify(newCollection, null, 4));

    console.log("\n✅ Migration applied. card.json and collection.json updated.");
    console.log("⚠️  Remember: if auction.js or trade.js store card IDs in their own files, check those manually — this script did not touch them.");

}

main();