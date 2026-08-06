const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ROOT = "./cards";

let converted = 0;
let skipped = 0;
let failed = 0;

async function convert(dir) {
    if (!fs.existsSync(dir)) {
        console.error(`❌ Folder not found: ${dir}`);
        process.exit(1);
    }

    const files = fs.readdirSync(dir);

    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        // Search subfolders too
        if (stat.isDirectory()) {
            await convert(fullPath);
            continue;
        }

        // Only convert WebP files
        if (!/\.webp$/i.test(file)) {
            continue;
        }

        const outputPath = fullPath.replace(/\.webp$/i, ".jpg");

        // Don't overwrite an existing JPG
        if (fs.existsSync(outputPath)) {
            console.log(`⏭️ Already exists: ${outputPath}`);
            skipped++;
            continue;
        }

        try {
            await sharp(fullPath)
                .jpeg({
                    quality: 95
                })
                .toFile(outputPath);

            console.log(`✅ Converted: ${file} → ${path.basename(outputPath)}`);
            converted++;

        } catch (err) {
            console.error(`❌ Failed: ${file}`);
            console.error(`   ${err.message}`);
            failed++;
        }
    }
}

async function main() {
    console.log("🖼️ Starting card WebP → JPG conversion...");
    console.log(`📂 Folder: ${ROOT}\n`);

    await convert(ROOT);

    console.log("\n────────────────────────────");
    console.log("📊 Conversion complete!");
    console.log(`✅ Converted: ${converted}`);
    console.log(`⏭️ Skipped:   ${skipped}`);
    console.log(`❌ Failed:    ${failed}`);
    console.log("────────────────────────────");
}

main().catch(err => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
});