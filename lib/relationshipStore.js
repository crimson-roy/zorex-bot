// relationshipStore.js
// Tracks Chloe's relationship with each individual user: trust, affection,
// how many exchanges they've had, and a short rolling list of behavioral
// observations that .mem draws on to keep her reflections grounded in
// actual conversation rather than generic filler.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'relationships.json');
const MAX_OBSERVATIONS = 8;

// Ordered low -> high. `max` is exclusive except for the last tier, which
// requires trust === 10 exactly (per spec: couple only at max level).
const TIERS = [
  { key: 'stranger',     label: 'stranger',     emoji: '👤', min: 0,  max: 2,  description: 'Just met' },
  { key: 'acquaintance', label: 'acquaintance', emoji: '🙂', min: 2,  max: 4,  description: 'Getting to know each other' },
  { key: 'friend',       label: 'friend',       emoji: '🤝', min: 4,  max: 6,  description: 'A real friendship' },
  { key: 'bestfriend',   label: 'bestfriend',   emoji: '🌟', min: 6,  max: 8,  description: 'Close and trusted' },
  { key: 'crush',        label: 'crush',        emoji: '😳', min: 8,  max: 10, description: 'Something more, unspoken' },
  { key: 'couple',       label: 'couple',       emoji: '💕', min: 10, max: 10, description: 'Deep relationship' },
];

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({}, null, 4));
  }
}

function loadStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 4));
}

function defaultRelationship() {
  return {
    trust: 0,
    affection: 0,
    conversations: 0,
    firstMet: Date.now(),
    lastInteraction: Date.now(),
    observations: [],
  };
}

function getRelationship(userId) {
  const store = loadStore();
  if (!store[userId]) {
    store[userId] = defaultRelationship();
    saveStore(store);
  }
  return store[userId];
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Increments conversation count and nudges trust/affection by the given
 * deltas (each expected roughly in the -0.3..+0.3 range per exchange).
 * Optionally appends a short observation string, capped at MAX_OBSERVATIONS
 * (oldest dropped first).
 */
function recordExchange(userId, { trustDelta = 0, affectionDelta = 0, observation = null } = {}) {
  const store = loadStore();
  if (!store[userId]) store[userId] = defaultRelationship();

  const rel = store[userId];
  rel.conversations += 1;
  rel.lastInteraction = Date.now();
  rel.trust = clamp(rel.trust + trustDelta, 0, 10);
  rel.affection = clamp(rel.affection + affectionDelta, 0, 10);

  if (observation) {
    rel.observations.push(observation);
    if (rel.observations.length > MAX_OBSERVATIONS) {
      rel.observations = rel.observations.slice(rel.observations.length - MAX_OBSERVATIONS);
    }
  }

  saveStore(store);
  return rel;
}

function getTier(trust) {
  // Exact max (10) always resolves to the final tier (couple), even though
  // its range technically overlaps "crush"'s upper bound.
  if (trust >= 10) return TIERS[TIERS.length - 1];
  return TIERS.find(t => trust >= t.min && trust < t.max) || TIERS[0];
}

function getNextTierInfo(trust) {
  const currentIndex = TIERS.findIndex(t => t === getTier(trust));
  const next = TIERS[currentIndex + 1];
  if (!next) return null; // already at max
  return { label: next.label, thresholdTrust: next.min };
}

module.exports = {
  getRelationship,
  recordExchange,
  getTier,
  getNextTierInfo,
  TIERS,
};
