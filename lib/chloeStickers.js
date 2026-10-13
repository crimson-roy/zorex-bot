// chloeStickers.js
// Picks a sticker for Chloe to send, based on her detected mood in a reply
// AND her current relationship tier with that person — so warmer/more
// intimate stickers only unlock once she's actually close to someone.
//
// Expects .webp sticker files organized like:
//   data/stickers/neutral/*.webp
//   data/stickers/happy/*.webp
//   data/stickers/laughing/*.webp
//   data/stickers/loving/*.webp
//   data/stickers/pouty/*.webp
//   data/stickers/angry/*.webp
//   data/stickers/sad/*.webp
//   data/stickers/shy/*.webp
//   data/stickers/teasing/*.webp
//   data/stickers/special/*.webp
//
// Any mood folder can be empty or missing entirely — pickSticker() walks
// the downgrade chain until it finds one with files, ultimately falling
// back to 'neutral', and returns null if even that has nothing usable.

const fs = require('fs');
const path = require('path');

const STICKER_ROOTS = [
  path.join(__dirname, '..', 'media', 'chloe'),
  path.join(__dirname, '..', 'data', 'stickers')
];

// Must match relationshipStore.js's TIERS order (low -> high).
const TIER_ORDER = ['stranger', 'acquaintance', 'friend', 'bestfriend', 'crush', 'couple'];

// Cumulative — each tier unlocks everything from the tier below it, plus
// one new mood. 'angry' isn't a closeness-gated mood (like neutral/happy/
// sad/shy), so it's available from 'stranger' onward.
const TIER_MOODS = {
  stranger:     ['neutral', 'sad', 'angry'],
  acquaintance: ['neutral', 'sad', 'angry', 'teasing'],
  friend:       ['neutral', 'sad', 'angry', 'teasing', 'laughing'],
  bestfriend:   ['neutral', 'happy', 'sad', 'shy', 'angry', 'teasing', 'laughing', 'pouty'],
  crush:        ['neutral', 'happy', 'sad', 'shy', 'angry', 'teasing', 'laughing', 'pouty', 'loving'],
  couple:       ['neutral', 'happy', 'sad', 'shy', 'angry', 'teasing', 'laughing', 'pouty', 'loving', 'special'],
};

// If a mood isn't unlocked yet (or its folder is empty), step down to the
// nearest allowed equivalent instead of just flatlining straight to neutral.
const MOOD_DOWNGRADE = {
  special: 'loving',
  loving: 'happy',
  pouty: 'sad',
  laughing: 'happy',
  teasing: 'happy',
  angry: 'sad',
  happy: 'neutral',
  sad: 'neutral',
  shy: 'neutral',
  neutral: 'neutral', // terminal — always available
};

function tierMoods(tierKey) {
  return TIER_MOODS[tierKey] || TIER_MOODS.stranger;
}

const STICKER_EXTENSIONS =
  new Set([
    ".webp",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif"
  ]);

function walkStickerFiles(
  dir,
  depth = 0
) {
  if (
    depth > 5 ||
    !fs.existsSync(dir)
  ) {
    return [];
  }

  let entries;

  try {
    entries =
      fs.readdirSync(
        dir,
        {
          withFileTypes:
            true
        }
      );
  } catch (_) {
    return [];
  }

  const files = [];

  for (const entry of entries) {
    const fullPath =
      path.join(
        dir,
        entry.name
      );

    if (entry.isDirectory()) {
      files.push(
        ...walkStickerFiles(
          fullPath,
          depth + 1
        )
      );

      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const ext =
      path.extname(
        entry.name
      )
        .toLowerCase();

    if (
      STICKER_EXTENSIONS.has(
        ext
      )
    ) {
      files.push(
        fullPath
      );
    }
  }

  return files;
}

function moodMatchesPath(
  filePath,
  mood
) {
  const normalized =
    String(filePath || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ");

  return normalized
    .split(/\s+/)
    .includes(
      String(mood || "")
        .toLowerCase()
    );
}

function listStickerFiles(mood, roots = STICKER_ROOTS) {
  const moodMatches = [];

  for (const root of roots) {
    const files = walkStickerFiles(root);
    for (const file of files) {
      if (moodMatchesPath(file, mood)) moodMatches.push(file);
    }
  }

  // Never substitute an unrelated sticker when the requested mood has no
  // matching file. A mismatched happy/loving sticker breaks Chloe's tone.
  return [...new Set(moodMatches)];
}

/**
 * @param {string} tierKey - one of TIER_ORDER, e.g. 'friend'
 * @param {string} mood - Chloe's detected mood for this reply
 * @returns {string|null} absolute path to a .webp file, or null if nothing usable
 */
function isDirectCompliment(text) {
  return /\b(?:you(?:'re| are| look| seem)\s+(?:so\s+)?(?:beautiful|pretty|cute|gorgeous|lovely|sweet|amazing|wonderful|perfect|adorable|kind|attractive|fine)|you're the best|i\s+(?:love|like|adore)\s+you|good girl|pretty girl|beautiful girl|my queen|i have a crush on you)\b/i
    .test(String(text || ""));
}

function pickSticker(tierKey, mood, relationship = {}) {
  const allowed = tierMoods(tierKey);
  const requestedMood = String(mood || "neutral").toLowerCase();
  const trust = Number(relationship.trust);
  const affection = Number(relationship.affection);
  const lowRelationship =
    (Number.isFinite(trust) && trust < 2) ||
    (Number.isFinite(affection) && affection < 2);
  const warmMoods = new Set(["happy", "shy", "loving", "pouty", "special"]);

  // At low trust/affection, don't reward a direct compliment with a warm
  // sticker before Chloe has actually earned or shown that warmth.
  let current = requestedMood;
  if (lowRelationship && isDirectCompliment(relationship.userMessage) &&
      warmMoods.has(current)) {
    current = "neutral";
  }

  if (!allowed.includes(current)) {
    const seen = new Set();
    while (!allowed.includes(current) && !seen.has(current)) {
      seen.add(current);
      current = MOOD_DOWNGRADE[current] || "neutral";
    }
    if (!allowed.includes(current)) current = "neutral";
  }

  const roots = Array.isArray(relationship.roots) ? relationship.roots : STICKER_ROOTS;
  let files = listStickerFiles(current, roots);
  const seenEmpty = new Set();
  while (files.length === 0 && !seenEmpty.has(current)) {
    seenEmpty.add(current);
    if (current === "neutral") break;
    current = MOOD_DOWNGRADE[current] || "neutral";
    const seen = new Set();
    while (!allowed.includes(current) && !seen.has(current)) {
      seen.add(current);
      current = MOOD_DOWNGRADE[current] || "neutral";
    }
    if (!allowed.includes(current)) current = "neutral";
    files = listStickerFiles(current, roots);
  }

  if (files.length === 0) return null;
  return files[Math.floor(Math.random() * files.length)];
}

module.exports = { pickSticker, listStickerFiles, TIER_MOODS, MOOD_DOWNGRADE, TIER_ORDER };