// lib/tierStar.js
//
// Spec §4: same underlying number, .company (owner) shows "Tier N",
// .jobinfo (public) shows "N-Star". Levels 0-24 all fall in tier 1 —
// the spec table starts its range at 1, but a brand-new level-0 company
// needs a bucket too, so it's grouped with 1-24 rather than left undefined.
//
// Does NOT drive salary percentages — purely a display mechanic (see
// spec §5 for why tier-scaled salary was explicitly rejected).

function tierForLevel(level) {
    if (level >= 100) return 5;
    if (level >= 75) return 4;
    if (level >= 50) return 3;
    if (level >= 25) return 2;
    return 1;
}

module.exports = { tierForLevel };
