// tools/cleanupWebp.js
//
// Deletes .webp files in the cards directory, but ONLY if a matching
// .jpg with the same base filename already exists — so a webp never
// gets deleted unless convertCard.js actually produced its replacement.
// Any .webp without a matching .jpg is left alone and flagged.
//
// Usage:
//   node tools/cleanupWebp.js          -> dry run, lists what WOULD be deleted
//   node tools/cleanupWebp.js --apply  -> actually deletes them

const fs = require("fs");
const path = require("path");

const CARD_DIR = path.join(__dirname, "..", "cards");

function main() {

    const apply = process.argv.includes("--apply");

    console.log(apply ? "🗑️ APPLY MODE — matching .webp files will be deleted.\n" : "🔍 DRY RUN — nothing will be deleted. Use --apply to actually delete.\n");

    if (!fs.existsSync(CARD_DIR)) {
        console.error("❌ cards/ directory not found.");
        return;
    }

    const files = fs.readdirSync(CARD_DIR);
    const webpFiles = files.filter(f => f.toLowerCase().endsWith(".webp"));

    if (webpFiles.length === 0) {
        console.log("✅ No .webp files found — nothing to do.");
        return;
    }

    let toDelete = [];
    let missingJpg = [];

    for (const webp of webpFiles) {

        const base = webp.slice(0, -".webp".length);
        const jpgPath = path.join(CARD_DIR, `${base}.jpg`);

        if (fs.existsSync(jpgPath) && fs.statSync(jpgPath).size > 0) {
            toDelete.push(webp);
        } else {
            missingJpg.push(webp);
        }

    }

    console.log(`📋 ${toDelete.length} .webp file(s) have a matching .jpg and are safe to delete:`);
    toDelete.forEach(f => console.log(`   ${f}`));

    if (missingJpg.length > 0) {
        console.log(`\n⚠️ ${missingJpg.length} .webp file(s) have NO matching .jpg — left untouched:`);
        missingJpg.forEach(f => console.log(`   ${f}`));
    }

    if (!apply) {
        console.log("\nDry run complete — re-run with --apply to actually delete the safe list above.");
        return;
    }

    let deleted = 0;

    for (const webp of toDelete) {

        try {
            fs.unlinkSync(path.join(CARD_DIR, webp));
            deleted++;
        } catch (err) {
            console.error(`   ❌ Failed to delete ${webp}: ${err.message}`);
        }

    }

    console.log(`\n✅ Deleted ${deleted} .webp file(s).`);

}

main();