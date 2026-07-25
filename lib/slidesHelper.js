// slidesHelper.js
// Shared course-folder logic used by both commands/slides.js and
// commands/teach.js, so course resolution/listing behaves identically in
// both places instead of being duplicated and potentially drifting apart.

const fs = require("fs");
const path = require("path");

const SLIDES_DIR = path.join(__dirname, "..", "data", "slides");

function ensureSlidesDir() {
    if (!fs.existsSync(SLIDES_DIR)) {
        fs.mkdirSync(SLIDES_DIR, { recursive: true });
    }
}

function listCourseFolders() {
    ensureSlidesDir();
    return fs
        .readdirSync(SLIDES_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
}

// Splits a filename into text/number chunks so "Lecture2" sorts before
// "Lecture10" instead of lexicographic order putting "Lecture10" first.
function naturalCompare(a, b) {
    const chunk = s => s.match(/\d+|\D+/g) || [];
    const ac = chunk(a);
    const bc = chunk(b);

    for (let i = 0; i < Math.max(ac.length, bc.length); i++) {
        const av = ac[i] || "";
        const bv = bc[i] || "";

        const an = Number(av);
        const bn = Number(bv);

        if (!isNaN(an) && !isNaN(bn) && av !== "" && bv !== "") {
            if (an !== bn) return an - bn;
        } else if (av !== bv) {
            return av < bv ? -1 : 1;
        }
    }

    return 0;
}

function listPdfFiles(courseFolder) {
    const dir = path.join(SLIDES_DIR, courseFolder);
    try {
        return fs
            .readdirSync(dir)
            .filter(f => f.toLowerCase().endsWith(".pdf"))
            .sort(naturalCompare);
    } catch (err) {
        return [];
    }
}

// Resolves a typed course string ("PHY", "phy102") to exactly one real
// folder name. Returns { resolved: "PHY102" } | { ambiguous: [...] } | { none: true }
function resolveCourse(input) {
    const folders = listCourseFolders();
    const target = input.toUpperCase();

    // Exact match (case-insensitive) always wins outright, even if it also
    // happens to be a prefix of other folders (e.g. "PHY1" vs "PHY10").
    const exact = folders.find(f => f.toUpperCase() === target);
    if (exact) return { resolved: exact };

    const prefixMatches = folders.filter(f => f.toUpperCase().startsWith(target));

    if (prefixMatches.length === 0) return { none: true };
    if (prefixMatches.length === 1) return { resolved: prefixMatches[0] };
    return { ambiguous: prefixMatches };
}

module.exports = {
    SLIDES_DIR,
    listCourseFolders,
    listPdfFiles,
    resolveCourse,
};
