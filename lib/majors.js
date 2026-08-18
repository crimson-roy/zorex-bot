// lib/majors.js
//
// The three "majors" — Nova Empire, Elegance, Chez Adélu — are public
// company listings with NO users.json entry and NO owner. Unlike player
// companies:
//   - Income is a hand-set FIXED number per major (option b), completely
//     decoupled from incomeAtLevel()/the level formula — majors have no
//     `level` field and never will.
//   - Each major has its OWN position catalog, separate from
//     lib/industries.js's per-industry catalogs — majors aren't "a
//     company with an industry", they're a fixed, hand-authored entity.
//   - There's no owner to review/approve applicants. Applying goes
//     through a 30-second, 90%-odds chance roll instead — see
//     lib/majorsState.js for that flow and the actual employment
//     records (majors have no users.json entry to store employees on).
//
// Position rate/maxSlots follow the same convention as
// lib/industries.js (rate <= 0.30% -> 10 slots, 0.30–0.60% -> 5,
// 0.60–1.00% -> 3, >1.00% -> 1), for consistency. Salary math is
// major.income * rate/100 — NEVER incomeAtLevel(level) * rate/100.
//
// FLAGGED: Nova Empire's sector/flavor was never specified (Elegance =
// retail/boutique, Chez Adélu = restaurant/fine dining, Nova Empire =
// unspecified "middle" one). Its catalog below is a generic
// corporate/flagship placeholder — swap it for whatever it should
// actually be.
//
// Ascending order, each >=10% above the previous:
//   Elegance     (retail/boutique)        750,000 🌙/payout
//   Nova Empire  (sector unspecified)     900,000 🌙/payout   (+20%)
//   Chez Adélu   (restaurant/fine dining) 1,100,000 🌙/payout (+22.2%)

const MAJORS = {

    "elegance": {
        name: "Elegance",
        industry: "retail",
        income: 750000,
        positions: {
            "sales associate":    { rate: 0.20, maxSlots: 10 },
            "cashier":            { rate: 0.25, maxSlots: 10 },
            "security personnel": { rate: 0.30, maxSlots: 10 },
            "visual merchandiser":{ rate: 0.50, maxSlots: 5 },
            "personal shopper":   { rate: 0.80, maxSlots: 3 },
            "head tailor":        { rate: 1.20, maxSlots: 1 }
        }
    },

    "nova empire": {
        name: "Nova Empire",
        industry: null, // FLAGGED — sector never specified, see header comment
        income: 900000,
        positions: {
            "receptionist":       { rate: 0.20, maxSlots: 10 },
            "security personnel": { rate: 0.30, maxSlots: 10 },
            "analyst":            { rate: 0.55, maxSlots: 5 },
            "account manager":    { rate: 0.80, maxSlots: 3 },
            "director":           { rate: 1.30, maxSlots: 1 }
        }
    },

    "chez adélu": {
        name: "Chez Adélu",
        industry: "food",
        income: 1100000,
        positions: {
            "kitchen porter": { rate: 0.20, maxSlots: 10 },
            "host/hostess":   { rate: 0.25, maxSlots: 10 },
            "server":         { rate: 0.35, maxSlots: 5 },
            "sommelier":      { rate: 0.90, maxSlots: 3 },
            "head chef":      { rate: 1.40, maxSlots: 1 }
        }
    }

};

// Tunable here rather than a magic number buried in commands/jobs.js.
const MAJOR_APPLICATION_DELAY_MS = 30 * 1000;
const MAJOR_APPLICATION_SUCCESS_RATE = 0.90;

// Attendance enforcement for HIRED major employees — separate from the
// application roll above. Idle time is measured from their last .duty
// check-in (or hiredAt if they've never checked in), NOT calendar days,
// same convention as every other timing rule in this codebase.
const MAJOR_ATTENDANCE_WARN_MS = 2 * 24 * 60 * 60 * 1000;   // 2 days idle -> PR warning DM
const MAJOR_ATTENDANCE_FIRE_MS = 3 * 24 * 60 * 60 * 1000;   // 3 days idle -> auto-fired
const MAJOR_ATTENDANCE_CHECK_INTERVAL_MS = 30 * 60 * 1000;  // how often the sweep runs

function isMajor(name) {
    return Object.prototype.hasOwnProperty.call(MAJORS, (name || "").toLowerCase());
}

function getMajor(name) {
    return MAJORS[(name || "").toLowerCase()];
}

function listMajors() {
    return Object.entries(MAJORS).map(([key, m]) => ({ key, ...m }));
}

function isValidMajorPosition(majorKey, positionName) {
    const major = getMajor(majorKey);
    if (!major) return false;
    return Object.prototype.hasOwnProperty.call(major.positions, (positionName || "").toLowerCase());
}

function majorPositionRate(majorKey, positionName) {
    const major = getMajor(majorKey);
    if (!major) return null;
    const def = major.positions[(positionName || "").toLowerCase()];
    return def ? def.rate : null;
}

function getMajorMaxSlots(majorKey, positionName) {
    const major = getMajor(majorKey);
    if (!major) return null;
    const def = major.positions[(positionName || "").toLowerCase()];
    return def ? def.maxSlots : null;
}

module.exports = {
    MAJORS,
    MAJOR_APPLICATION_DELAY_MS,
    MAJOR_APPLICATION_SUCCESS_RATE,
    isMajor,
    getMajor,
    listMajors,
    isValidMajorPosition,
    majorPositionRate,
    getMajorMaxSlots
};