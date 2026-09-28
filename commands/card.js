const fs = require("fs");
const { prepareVideo } = require("../lib/videoHelper");
const { startProgress } = require("../lib/progressIndicator");

// Abbreviation -> a substring to search for in card.series. Only needed
// for series whose common short name has no substring relationship with
// the full name (e.g. "jjk" doesn't appear anywhere in "Jujutsu Kaisen").
// Series like "dxd" already work via plain substring match against
// "High School DxD" and don't need an entry here — this list is only a
// fallback layer on top of that.
const SERIES_ALIASES = {
    jjk: "jujutsu kaisen",
    aot: "attack on titan",
    mha: "my hero academia",
    op: "one piece",
    hxh: "hunter x hunter",
    csm: "chainsaw man",
    ygo: "yu-gi-oh",
    nge: "evangelion",
    sxf: "spy x family",
    hsr: "honkai"
};

// PERSISTENCE FIX: collection.json is written by other command files
// (auction.js, inventory.js) that were switched to dataPath() — this file
// only reads it, but it must resolve to the SAME path those writers use,
// or card.js would keep reading an empty/stale copy on the ephemeral disk
// after a redeploy while the real data lives on the volume. card.json
// stays a plain relative path since it's a static catalog nothing ever
// writes to. See lib/dataPath.js.
const dataPath = require("../lib/dataPath");

const CARD_FILE = "./card.json";
const COLLECTION_FILE = dataPath("collection.json");

// users.json — read-only here, used for registered-name lookups (e.g.
// .cardlb). Written elsewhere (index.js's .register flow); this file only
// ever reads it.
const USERS_FILE = dataPath("users.json");

const TIER_ICONS = {
    UR: "💎",
    SSR: "👑",
    SR: "🟣",
    S: "🟡",
    R: "🔵",
    C: "⚪"
};

const TIER_LABELS = {
    UR: "UR",
    SSR: "SSR",
    SR: "SR",
    S: "S",
    R: "Rare",
    C: "Common"
};

const TIER_ORDER = ["UR", "SSR", "SR", "S", "R", "C"];


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

function loadUsers() {

    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, "{}");
    }

    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));

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
    const users = loadUsers();

    const ownerLines =
        owners.length === 0
            ? "No one yet — be the first!"
            : owners
                .map((ownerId, index) => {
                    const registeredName =
                        users[ownerId]?.name ||
                        "Unregistered User";

                    return `${index + 1}. ${registeredName}`;
                })
                .join("\n");

    const text =
`┌─── 📋 Card Info ───────────
│ ${icon} ${card.name}
│ 📚 ${card.series}
│ 🏷️ Tier: ${card.tier} — ${icon} ${label}
│ 💎 Value: ${card.valueMin.toLocaleString()} – ${card.valueMax.toLocaleString()} 🌙
│ 🆔 #${cardId}
└─────────────────────────────
👤 Owners:
${ownerLines}`;

    return { text };

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
            gifPlayback: true
        }, { quoted: msg });

    } else if (card.image && fs.existsSync(card.image)) {

        await sock.sendMessage(msg.key.remoteJid, {
            image: fs.readFileSync(card.image),
            caption
        }, { quoted: msg });

    } else {

        await sock.sendMessage(msg.key.remoteJid, {
            text: caption
        }, { quoted: msg });

    }

}

// Normalize a series name for matching/grouping without changing the value
// stored in card.json. Case, whitespace and punctuation differences should
// not split the same series into separate .ss results. Examples:
// "KonoSuba" / "Konosuba", "Steins; Gate" / "Steins;Gate", and
// "JoJo's Bizarre Adventure" / "JoJos Bizarre Adventure" all collapse
// to the same comparison key. Different titles such as "Fate/Zero" and
// "Fate Series" remain separate.
function normalizeSeriesName(value) {

    return String(value || "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^\p{L}\p{N}]+/gu, "");

}

// Build one logical group per normalized series name while retaining the
// most common original spelling for display. This lets .ss merge duplicate
// labels without rewriting card.json or losing the nicer source title.
function buildSeriesGroups(cards) {

    const groups = new Map();

    for (const card of Object.values(cards)) {

        const rawSeries = String(card?.series || "").trim();
        const key = normalizeSeriesName(rawSeries);

        if (!rawSeries || !key) continue;

        if (!groups.has(key)) {
            groups.set(key, {
                key,
                variants: new Map()
            });
        }

        const group = groups.get(key);
        group.variants.set(
            rawSeries,
            (group.variants.get(rawSeries) || 0) + 1
        );

    }

    return [...groups.values()].map(group => {

        const displayName = [...group.variants.entries()]
            .sort((a, b) => {
                if (b[1] !== a[1]) return b[1] - a[1];
                return a[0].localeCompare(b[0]);
            })[0][0];

        return {
            key: group.key,
            displayName,
            variants: [...group.variants.keys()]
        };

    });

}

// Resolves a user's search term to logical series groups. Exact normalized
// matches take priority over broader substring matches, so `.ss dragon ball`
// opens "Dragon Ball" directly even when "Dragon Ball Series" also exists.
// Alias expansion still happens first, and partial searches still return all
// matching series when there is no exact match.
function resolveSeriesMatches(searchTerm, cards) {

    const term = searchTerm.trim().toLowerCase();
    const searchFor = normalizeSeriesName(SERIES_ALIASES[term] || term);

    if (!searchFor) return [];

    const groups = buildSeriesGroups(cards);
    const exactMatches = groups.filter(group => group.key === searchFor);

    if (exactMatches.length > 0) {
        return exactMatches;
    }

    return groups.filter(group => group.key.includes(searchFor));

}

// ---------- .ss <series> — browse every card in a series, grouped by tier ----------
async function seriesSearchCommand(sock, msg, text) {

    const searchTerm = text.replace(/^\.ss/i, "").trim();

    if (!searchTerm) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Usage:\n\n.ss <series>\n\nExample:\n.ss dxd`
        }, { quoted: msg });

    }

    const progress =
        await startProgress(
            sock,
            msg,
            `🔎 Searching series for "${searchTerm}"...`
        );

    try {

        const cards = loadCards();
        const matchingSeries = resolveSeriesMatches(searchTerm, cards);

        if (matchingSeries.length === 0) {

            await progress.fail(
                "❌ No matching series found"
            );

            return await sock.sendMessage(msg.key.remoteJid, {
                text: `❌ No series found matching "${searchTerm}".`
            }, { quoted: msg });

        }

        if (matchingSeries.length > 1) {

            await progress.succeed(
                `✅ Found ${matchingSeries.length} matching series`
            );

            return await sock.sendMessage(msg.key.remoteJid, {
                text: `⚠️ Multiple series match "${searchTerm}" — please be more specific:\n\n${matchingSeries.map(group => `• ${group.displayName}`).join("\n")}`
            }, { quoted: msg });

        }

        await progress.update(
            "📚 Preparing series list..."
        );

        const seriesGroup = matchingSeries[0];
        const seriesName = seriesGroup.displayName;

        const seriesCards = Object.entries(cards).filter(
            ([id, card]) => normalizeSeriesName(card.series) === seriesGroup.key
        );

        const byTier = {};

        for (const [id, card] of seriesCards) {
            if (!byTier[card.tier]) byTier[card.tier] = [];
            byTier[card.tier].push({ id, name: card.name });
        }

        for (const tier of Object.keys(byTier)) {
            byTier[tier].sort((a, b) => a.name.localeCompare(b.name));
        }

        let out =
            `📚 *${seriesName}*\n📊 ${seriesCards.length} cards\n▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n`;

        for (const tier of TIER_ORDER) {

            const entries = byTier[tier];

            if (!entries || entries.length === 0) continue;

            const icon = TIER_ICONS[tier] || "⚪";
            const label = TIER_LABELS[tier] || tier;

            out +=
                `${icon} *${label}* (${entries.length})\n─────────────────────\n`;

            out +=
                entries
                    .map(
                        (card, index) =>
                            `${index + 1}.🃏 ${card.name} \`#${card.id}\``
                    )
                    .join("\n");

            out += "\n";

        }

        out +=
            `💡 \`.spawn\` to try getting a card from this series`;

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: out
            },
            {
                quoted: msg
            }
        );

        await progress.succeed(
            `✅ ${seriesName} — ${seriesCards.length} cards found`
        );

    } catch (err) {

        console.error(
            "[.ss] search failed:",
            err.message
        );

        await progress.fail(
            "❌ Series search failed"
        );

        throw err;

    }

}

// ---------- .cs <cardname> [tier] ----------
async function cardCommands(sock, msg, text) {

    const args =
        text
            .replace(/^\.cs/i, "")
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

    if (
        TIER_ORDER.includes(lastArg) &&
        args.length > 1
    ) {
        rarity = lastArg;
        args.pop();
    }

    const searchTerm =
        args.join(" ").toLowerCase();

    if (!searchTerm) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: "⚠️ Please provide a card name."
        }, { quoted: msg });

    }

    const progress =
        await startProgress(
            sock,
            msg,
            rarity
                ? `🔎 Searching for ${searchTerm} [${rarity}]...`
                : `🔎 Searching for ${searchTerm}...`
        );

    try {

        const cards = loadCards();
        const collection = loadCollection();

        // Strip a leading "#" so both "59e04c5d" and "#59e04c5d" work.
        const cleanTerm =
            searchTerm.replace(/^#/, "");

        // Exact card ID takes priority over name search.
        const idMatch =
            Object.keys(cards).find(
                id =>
                    id.toLowerCase() === cleanTerm
            );

        let matches;

        if (idMatch) {

            matches = [
                [idMatch, cards[idMatch]]
            ];

        } else {

            matches =
                Object.entries(cards).filter(
                    ([id, card]) =>
                        card.name
                            .toLowerCase()
                            .includes(cleanTerm)
                );

        }

        if (rarity) {

            matches =
                matches.filter(
                    ([id, card]) =>
                        card.tier === rarity
                );

        }

        if (matches.length === 0) {

            await progress.fail(
                "❌ No matching cards found"
            );

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`❌ No cards found for ${searchTerm}${rarity ? ` [${rarity}]` : ""}.
💡 Check spelling or try a shorter name.`
                },
                {
                    quoted: msg
                }
            );

        }

        const [topId, topCard] =
            matches[0];

        const owners =
            findOwners(
                topId,
                collection
            );

        let extraText = "";

        if (matches.length > 1) {

            const others =
                matches.slice(1, 3);

            const remaining =
                matches.length - 1;

            const lines =
                others.map(
                    ([id, card]) => {

                        const icon =
                            TIER_ICONS[card.tier] ||
                            "⚪";

                        return `  • ${icon} ${card.name} [${card.tier}] — ${card.series} #${id}`;

                    }
                );

            extraText =
`\n📌 ${remaining} other match${remaining === 1 ? "" : "es"} — Top ${Math.min(matches.length, 3)}:
${lines.join("\n")}`;

        }

        await progress.update(
            topCard.video
                ? "🎞️ Preparing card media..."
                : "🃏 Preparing card..."
        );

        await sendCardDisplay(
            sock,
            msg,
            topId,
            topCard,
            owners,
            extraText
        );

        await progress.succeed(
            `✅ Found ${topCard.name} [${topCard.tier}]`
        );

    } catch (err) {

        console.error(
            "[.cs] search failed:",
            err.message
        );

        await progress.fail(
            "❌ Card search failed"
        );

        throw err;

    }

}


// ---------- .cardlb — top 15 card collectors ----------
// Public command. Ranks by RAW total card count in collection.json — no
// series involved (series isn't part of the card system yet, per spec).
// Names are pulled from users.json (registered name), never a raw
// WhatsApp ID/mention, matching the rest of the display system.
async function cardLeaderboardCommand(sock, msg) {

    const collection = loadCollection();
    const users = loadUsers();

    const ranked = Object.entries(collection)
        .map(([userId, items]) => ({
            userId,
            count: (items || []).length
        }))
        .filter(entry => entry.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 15);

    if (ranked.length === 0) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `🏆 No one has collected any cards yet.`
        }, { quoted: msg });

    }

    const medals = ["🥇", "🥈", "🥉"];

    const list = ranked
        .map((entry, i) => {

            const rankLabel = medals[i] || `${i + 1}.`;

            const name =
                (users[entry.userId] && users[entry.userId].name) ||
                "Unregistered User";

            return `${rankLabel} ${name} — ${entry.count} card${entry.count === 1 ? "" : "s"}`;

        })
        .join("\n");

    return await sock.sendMessage(msg.key.remoteJid, {
        text:
`🏆 *Card Leaderboard — Top ${ranked.length}*

${list}`
    }, { quoted: msg });

}


module.exports = {
    cardCommands,
    cardLeaderboardCommand,
    seriesSearchCommand,
    loadCards,
    loadCollection,
    findOwners,
    formatCardBlock,
    sendCardDisplay,
    TIER_ICONS,
    TIER_LABELS,
    TIER_ORDER
};