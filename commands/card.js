const fs = require("fs");
const { prepareVideo } = require("../lib/videoHelper");

const CARD_FILE = "./card.json";
const COLLECTION_FILE = "./collection.json";

const TIER_ICONS = {
    SSR: "👑",
    SR: "🟣",
    S: "🟡",
    R: "🔵",
    C: "⚪"
};

const TIER_LABELS = {
    SSR: "SSR",
    SR: "SR",
    S: "S",
    R: "Rare",
    C: "Common"
};

const TIER_ORDER = ["SSR", "SR", "S", "R", "C"];


function loadCards() {

    if (!fs.existsSync(CARD_FILE)) {
        fs.writeFileSync(CARD_FILE, "{}");
    }

    return JSON.parse(fs.readFileSync(CARD_FILE, "utf8"));

}

function loadCollection() {

    if (!fs.existsSync(COLLECTION_FILE)) {
        fs.writeFileSync(COLLECTION_FILE, "{}");
    }

    return JSON.parse(fs.readFileSync(COLLECTION_FILE, "utf8"));

}

// Find every userId that currently owns this exact card (by card_ID)
function findOwners(cardId, collection) {

    const owners = [];

    for (const userId in collection) {

        const items = collection[userId] || [];

        if (items.some(it => it.id === cardId)) {
            owners.push(userId);
        }

    }

    return owners;

}

function formatCardBlock(cardId, card, owners) {

    const icon = TIER_ICONS[card.tier] || "⚪";
    const label = TIER_LABELS[card.tier] || card.tier;

    const ownerLine =
        owners.length === 0
            ? "No one yet — be the first!"
            : owners.map(o => `@${o.split("@")[0]}`).join(", ");

    const text =
`┌─── 📋 Card Info ───────────
│ ${icon} ${card.name}
│ 📚 ${card.series}
│ 🏷️ Tier: ${card.tier} — ${icon} ${label}
│ 💎 Value: ${card.valueMin.toLocaleString()} – ${card.valueMax.toLocaleString()} 🌙
│ 🆔 #${cardId}
└─────────────────────────────
👤 Owners: ${ownerLine}`;

    return { text, mentions: owners };

}

async function sendCardDisplay(sock, msg, cardId, card, owners, extraText = "") {

    const block = formatCardBlock(cardId, card, owners);
    const caption = block.text + extraText;

    if (card.video && fs.existsSync(card.video)) {

        // Convert to a WhatsApp-friendly 720x1280 vertical MP4 first (cached
        // after the first conversion, so repeat sends of the same card are
        // instant). Falls back to the original file if conversion fails,
        // so a broken/missing FFmpeg never breaks the card display entirely.
        let videoPath = card.video;

        try {

            videoPath = await prepareVideo(card.video);

        } catch (err) {

            console.error("⚠️ prepareVideo failed, sending original file:", err.message);

        }

        await sock.sendMessage(msg.key.remoteJid, {
            video: fs.readFileSync(videoPath),
            caption,
            gifPlayback: true,
            mentions: block.mentions
        }, { quoted: msg });

    } else if (card.image && fs.existsSync(card.image)) {

        await sock.sendMessage(msg.key.remoteJid, {
            image: fs.readFileSync(card.image),
            caption,
            mentions: block.mentions
        }, { quoted: msg });

    } else {

        await sock.sendMessage(msg.key.remoteJid, {
            text: caption,
            mentions: block.mentions
        }, { quoted: msg });

    }

}


// ---------- .cs <cardname> [tier] ----------
async function cardCommands(sock, msg, text) {

    const args =
        text
        .replace(".cs", "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    if (args.length === 0) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Usage:\n\n.cs <cardname>\n.cs <cardname> <SSR/SR/S/R/C>`
        }, { quoted: msg });

    }

    let rarity = null;
    const lastArg = args[args.length - 1].toUpperCase();

    if (TIER_ORDER.includes(lastArg) && args.length > 1) {
        rarity = lastArg;
        args.pop();
    }

    const searchTerm = args.join(" ").toLowerCase();

    if (!searchTerm) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Please provide a card name.`
        }, { quoted: msg });

    }

    await sock.sendMessage(msg.key.remoteJid, {
        text: rarity
            ? `🔍 Searching for ${searchTerm} [${rarity}]...`
            : `🔍 Searching for ${searchTerm}...`
    }, { quoted: msg });

    const cards = loadCards();
    const collection = loadCollection();

    // Strip a leading "#" so both "59e04c5d" and "#59e04c5d" work
    const cleanTerm = searchTerm.replace(/^#/, "");

    // Exact card_ID match takes priority over name search
    const idMatch = Object.keys(cards).find(
        id => id.toLowerCase() === cleanTerm
    );

    let matches;

    if (idMatch) {

        matches = [[idMatch, cards[idMatch]]];

    } else {

        matches = Object.entries(cards).filter(
            ([id, card]) => card.name.toLowerCase().includes(cleanTerm)
        );

    }

    if (rarity) {
        matches = matches.filter(([id, card]) => card.tier === rarity);
    }

    if (matches.length === 0) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text:
`❌ No cards found for ${searchTerm}${rarity ? ` [${rarity}]` : ""}.
💡 Check spelling or try a shorter name.`
        }, { quoted: msg });

    }

    const [topId, topCard] = matches[0];
    const owners = findOwners(topId, collection);

    let extraText = "";

    if (matches.length > 1) {

        const others = matches.slice(1, 3);
        const remaining = matches.length - 1;

        const lines = others.map(([id, card]) => {
            const icon = TIER_ICONS[card.tier] || "⚪";
            return `  • ${icon} ${card.name} [${card.tier}] — ${card.series} #${id}`;
        });

        extraText =
`\n📌 ${remaining} other match${remaining === 1 ? "" : "es"} — Top ${Math.min(matches.length, 3)}:
${lines.join("\n")}`;

    }

    await sendCardDisplay(sock, msg, topId, topCard, owners, extraText);

}

module.exports = {
    cardCommands,
    loadCards,
    loadCollection,
    findOwners,
    formatCardBlock,
    sendCardDisplay
};