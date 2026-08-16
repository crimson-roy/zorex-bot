// lib/dutyFlavor.js
//
// One random flavor line per .duty check-in, keyed by position (lowercase,
// matching lib/industries.js's catalog keys). "security personnel" is
// shared across all three industries since it's the one position name
// that repeats — every other key here is unique to a single industry.

const DUTY_FLAVOR = {

    // ---- Animation / Anime Studio ----
    "receptionist": [
        "greeted every visitor and kept the front desk running without a hitch",
        "fielded a flood of calls and kept the studio's schedule straight"
    ],
    "security personnel": [
        "patrolled the premises without incident",
        "stopped two thugs from harassing a worker at the gate",
        "checked every badge at the entrance, no exceptions"
    ],
    "background artist": [
        "painted three new background plates for the next episode",
        "touched up the studio's key background art ahead of deadline"
    ],
    "in-between animator": [
        "filled in a full sequence of in-between frames",
        "smoothed out a rough animation cut frame by frame"
    ],
    "colorist": [
        "color-graded a full scene ahead of schedule",
        "fixed a palette inconsistency the animators missed"
    ],
    "sound engineer": [
        "mixed the audio track for the latest cut",
        "cleaned up a noisy dialogue recording in post"
    ],
    "voice actor": [
        "nailed a full recording session in one take",
        "re-recorded a scene's dialogue after director notes"
    ],
    "editor": [
        "cut together the latest episode's rough edit",
        "trimmed a full act down to pace"
    ],
    "key animator": [
        "drew the key poses for the episode's climax",
        "locked in the keyframes for a new action sequence"
    ],
    "storyboard artist": [
        "boarded out a full new scene",
        "revised the storyboard after a director's note"
    ],

    // ---- Retail / Fashion ----
    "sales associate": [
        "closed three sales on the floor today",
        "helped a difficult customer find exactly what they needed"
    ],
    "cashier": [
        "ran the register all shift without a single error",
        "balanced the till to the last coin at close"
    ],
    "stock clerk": [
        "restocked the shelves and cleared the back room",
        "filed the week's inventory paperwork"
    ],
    "driver": [
        "completed every delivery on today's route on time",
        "hauled a full shipment in from the warehouse"
    ],
    "visual merchandiser": [
        "redid the front window display",
        "reorganized a whole floor section for the new season"
    ],
    "tailor's assistant": [
        "pinned and prepped three garments for alteration",
        "helped finish a rush order ahead of pickup"
    ],
    "personal shopper": [
        "curated a full outfit for a VIP client",
        "helped a client build out a season's wardrobe"
    ],
    "head tailor": [
        "finished a bespoke piece ahead of schedule",
        "fitted a client for a custom order"
    ],

    // ---- Food / Fine Dining ----
    "kitchen porter": [
        "scrubbed the kitchen down top to bottom",
        "kept the dish line moving all through service"
    ],
    "host/hostess": [
        "managed the reservation book without a single mix-up",
        "smoothed over a walk-in rush at the door"
    ],
    "server": [
        "ran a full section without dropping an order",
        "handled a packed dinner rush solo for twenty minutes"
    ],
    "valet": [
        "parked every car without a scratch during the rush",
        "kept the valet line moving during a packed evening"
    ],
    "line cook": [
        "held down the line through a full dinner rush",
        "prepped every station ahead of service"
    ],
    "sommelier": [
        "paired wines for a full tasting menu table",
        "restocked and catalogued the cellar"
    ],
    "sous chef": [
        "ran the kitchen while the head chef was out",
        "plated an entire tasting menu service"
    ],
    "head chef": [
        "developed a new dish for next season's menu",
        "ran service and kept every ticket on time"
    ]

};

const GENERIC_FLAVOR = [
    "put in a solid shift",
    "handled everything that came up today"
];

function getDutyFlavor(positionKey) {
    const pool = DUTY_FLAVOR[(positionKey || "").toLowerCase()] || GENERIC_FLAVOR;
    return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { getDutyFlavor };
