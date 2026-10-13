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

// Warm and bashful moods unlock only when closeness has been earned.
// A stranger's compliment alone must not trigger a happy, shy or loving sticker.
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

function listStickerFiles(mood) {
  const moodMatches = [];
  const generic = [];
  const knownMoods = Object.keys(MOOD_DOWNGRADE);

  for (const root of STICKER_ROOTS) {
    const files = walkStickerFiles(root);

    for (const file of files) {
      if (moodMatchesPath(file, mood)) {
        moodMatches.push(file);
        continue;
      }

      // A labelled sticker for a different mood is not a generic fallback.
      const hasMoodLabel = knownMoods.some(
        knownMood => moodMatchesPath(file, knownMood)
      );
      if (!hasMoodLabel) generic.push(file);
    }
  }

  if (moodMatches.length) return [...new Set(moodMatches)];
  return [...new Set(generic)];
}

/**
 * @param {string} tierKey - one of TIER_ORDER, e.g. 'friend'
 * @param {string} mood - Chloe's detected mood for this reply
 * @returns {string|null} absolute path to a .webp file, or null if nothing usable
 */
function resolveMoodForTier(tierKey, mood) {
  const allowed = tierMoods(tierKey);
  let current = String(mood || 'neutral').toLowerCase();
  const seen = new Set();

  while (!allowed.includes(current) && !seen.has(current)) {
    seen.add(current);
    current = MOOD_DOWNGRADE[current] || 'neutral';
  }

  return allowed.includes(current) ? current : 'neutral';
}

function pickSticker(tierKey, mood) {
  let current = resolveMoodForTier(tierKey, mood);
  let files = listStickerFiles(current);
  const seenEmpty = new Set([current]);

  // If a mood's artwork is missing, downgrade while respecting the same tier.
  while (files.length === 0 && current !== 'neutral') {
    const next = resolveMoodForTier(
      tierKey,
      MOOD_DOWNGRADE[current] || 'neutral'
    );
    if (seenEmpty.has(next)) break;
    seenEmpty.add(next);
    current = next;
    files = listStickerFiles(current);
  }

  if (files.length === 0) return null;
  return files[Math.floor(Math.random() * files.length)];
}

module.exports = {
  pickSticker,
  resolveMoodForTier,
  TIER_MOODS,
  MOOD_DOWNGRADE,
  TIER_ORDER
};