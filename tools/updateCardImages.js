const fs = require("fs");

const CARD_FILE = "./card.json";

try {
    const cards = JSON.parse(fs.readFileSync(CARD_FILE, "utf8"));

    let updated = 0;

    for (const [cardId, card] of Object.entries(cards)) {
        if (typeof card.image === "string" && /\.webp$/i.test(card.image)) {
            card.image = card.image.replace(/\.webp$/i, ".jpg");
            updated++;
        }
    }

    fs.writeFileSync(
        CARD_FILE,
        JSON.stringify(cards, null, 2),
        "utf8"
    );

    console.log("✅ Card image paths updated!");
    console.log(`🖼️ Updated: ${updated}`);
    console.log(`📁 File: ${CARD_FILE}`);

} catch (err) {
    console.error("❌ Failed:", err.message);
    process.exit(1);
}