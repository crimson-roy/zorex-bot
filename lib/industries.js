// lib/industries.js
//
// Industry catalogs for .companycreate <name> <industry>.
// Each industry key is what the user types as the industry argument
// (case-insensitive). Every position now has BOTH a salary rate (percent
// of company income, matching computeSalariesOwed()'s `rate / 100` math
// in commands/company.js) AND a maxSlots capacity — a position can now
// hold multiple simultaneous employees, up to that cap, all earning the
// FULL rate independently (not split).
//
// maxSlots follows one rule, applied consistently: cap scales inversely
// with rate/seniority. Entry-level, high-volume roles get more slots;
// senior/leadership roles are capped at 1. Exact thresholds:
//   rate <= 0.30%        -> 10 slots
//   0.30% < rate <= 0.60% ->  5 slots
//   0.60% < rate <= 1.00% ->  3 slots
//   rate > 1.00%          ->  1 slot
// This is a design default, not something explicitly specified per
// position — easy to hand-tune any individual maxSlots value below
// without touching the rest.
//
// "Manager" is deliberately excluded from every catalog — majors are
// assumed to already have that role permanently filled.

const INDUSTRIES = {

    animation: {
        label: "🎬 Animation / Anime Studio",
        positions: {
            "receptionist":        { rate: 0.20, maxSlots: 10 },
            "security personnel":  { rate: 0.30, maxSlots: 10 },
            "background artist":   { rate: 0.50, maxSlots: 5 },
            "colorist":            { rate: 0.60, maxSlots: 5 },
            "in-between animator": { rate: 0.70, maxSlots: 3 },
            "sound engineer":      { rate: 0.80, maxSlots: 3 },
            "voice actor":         { rate: 0.90, maxSlots: 3 },
            "editor":              { rate: 1.00, maxSlots: 3 },
            "key animator":        { rate: 1.10, maxSlots: 1 },
            "storyboard artist":   { rate: 1.30, maxSlots: 1 }
        }
    },

    retail: {
        label: "🛍️ Retail / Fashion",
        positions: {
            "sales associate":     { rate: 0.20, maxSlots: 10 },
            "cashier":             { rate: 0.25, maxSlots: 10 },
            "stock clerk":         { rate: 0.25, maxSlots: 10 },
            "security personnel":  { rate: 0.30, maxSlots: 10 },
            "driver":              { rate: 0.40, maxSlots: 5 },
            "visual merchandiser": { rate: 0.50, maxSlots: 5 },
            "tailor's assistant":  { rate: 0.55, maxSlots: 5 },
            "personal shopper":    { rate: 0.80, maxSlots: 3 },
            "head tailor":         { rate: 1.20, maxSlots: 1 }
        }
    },

    food: {
        label: "🍽️ Food / Fine Dining",
        positions: {
            "kitchen porter":      { rate: 0.20, maxSlots: 10 },
            "host/hostess":        { rate: 0.25, maxSlots: 10 },
            "security personnel":  { rate: 0.30, maxSlots: 10 },
            "server":              { rate: 0.35, maxSlots: 5 },
            "valet":               { rate: 0.35, maxSlots: 5 },
            "line cook":           { rate: 0.55, maxSlots: 5 },
            "sommelier":           { rate: 0.90, maxSlots: 3 },
            "sous chef":           { rate: 1.10, maxSlots: 1 },
            "head chef":           { rate: 1.40, maxSlots: 1 }
        }
    }

};

function isValidIndustry(key) {
    return Object.prototype.hasOwnProperty.call(INDUSTRIES, (key || "").toLowerCase());
}

function getIndustry(key) {
    return INDUSTRIES[(key || "").toLowerCase()];
}

function listIndustryKeys() {
    return Object.keys(INDUSTRIES);
}

function isValidPosition(industryKey, positionName) {
    const industry = getIndustry(industryKey);
    if (!industry) return false;
    return Object.prototype.hasOwnProperty.call(industry.positions, (positionName || "").toLowerCase());
}

function positionRate(industryKey, positionName) {
    const industry = getIndustry(industryKey);
    if (!industry) return null;
    const def = industry.positions[(positionName || "").toLowerCase()];
    return def ? def.rate : null;
}

function getMaxSlots(industryKey, positionName) {
    const industry = getIndustry(industryKey);
    if (!industry) return null;
    const def = industry.positions[(positionName || "").toLowerCase()];
    return def ? def.maxSlots : null;
}

// Positions are stored/compared lowercase internally; this is purely for
// display in offer listings, rosters, and confirmations.
function titleCase(str) {
    return (str || "")
        .split(" ")
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

module.exports = {
    INDUSTRIES,
    isValidIndustry,
    getIndustry,
    listIndustryKeys,
    isValidPosition,
    positionRate,
    getMaxSlots,
    titleCase
};