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

const STICKERS_DIR = path.join(__dirname, '..', 'data', 'stickers');

// Must match relationshipStore.js's TIERS order (low -> high).
const TIER_ORDER = ['stranger', 'acquaintance', 'friend', 'bestfriend', 'crush', 'couple'];

// Cumulative — each tier unlocks everything from the tier below it, plus
// one new mood. 'angry' isn't a closeness-gated mood (like neutral/happy/
// sad/shy), so it's available from 'stranger' onward.
const TIER_MOODS = {
  stranger:     ['neutral', 'happy', 'sad', 'shy', 'angry'],
  acquaintance: ['neutral', 'happy', 'sad', 'shy', 'angry', 'teasing'],
  friend:       ['neutral', 'happy', 'sad', 'shy', 'angry', 'teasing', 'laughing'],
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

function listWebpFiles(mood) {
  const dir = path.join(STICKERS_DIR, mood);
  try {
    return fs
      .readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.webp'))
      .map(f => path.join(dir, f));
  } catch (err) {
    return []; // folder doesn't exist yet — fine, caller falls back
  }
}

/**
 * @param {string} tierKey - one of TIER_ORDER, e.g. 'friend'
 * @param {string} mood - Chloe's detected mood for this reply
 * @returns {string|null} absolute path to a .webp file, or null if nothing usable
 */
function pickSticker(tierKey, mood) {
  const allowed = tierMoods(tierKey);

  let current = allowed.includes(mood) ? mood : 'neutral';
  // If the requested mood isn't unlocked for this tier, walk the downgrade
  // chain until we land on one that is.
  if (!allowed.includes(mood)) {
    current = mood;
    const seen = new Set();
    while (!allowed.includes(current) && !seen.has(current)) {
      seen.add(current);
      current = MOOD_DOWNGRADE[current] || 'neutral';
    }
    if (!allowed.includes(current)) current = 'neutral';
  }

  // Now find files, walking the same downgrade chain further if the
  // resolved mood's folder happens to be empty.
  let files = listWebpFiles(current);
  const seenEmpty = new Set();
  while (files.length === 0 && !seenEmpty.has(current)) {
    seenEmpty.add(current);
    if (current === 'neutral') break;
    current = MOOD_DOWNGRADE[current] || 'neutral';
    files = listWebpFiles(current);
  }

  if (files.length === 0) return null;

  return files[Math.floor(Math.random() * files.length)];
}

module.exports = { pickSticker, TIER_MOODS, MOOD_DOWNGRADE, TIER_ORDER };