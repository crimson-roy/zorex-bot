// commands/slides.js
//
// .slides <course>              -> list PDFs in that course's folder
// .slides <course> <number>     -> send that specific slide PDF
// .slides <course> all          -> send every PDF in that course's folder
//
// Course folders live in data/slides/<COURSECODE>/*.pdf — e.g.
//   data/slides/PHY102/Lecture1.pdf
//   data/slides/PHY104/Lecture1.pdf
//   data/slides/CHM101/Intro.pdf
//
// <course> can be typed as an exact code ("PHY102") or a shortened prefix
// ("PHY") — if the prefix matches more than one folder, the bot asks you
// to pick the exact one instead of guessing.

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

async function slidesCommand(sock, msg, text) {

    const args = text.replace(/^\.slides/i, "").trim().split(/\s+/).filter(Boolean);

    if (args.length === 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text:
`⚠️ Usage:

.slides <course>            — list slides for a course
.slides <course> <number>   — send one specific slide
.slides <course> all        — send every slide for that course

Example:
.slides PHY102
.slides PHY102 3
.slides PHY102 all`
        }, { quoted: msg });
    }

    const courseInput = args[0];
    const secondArg = args[1]; // number | "all" | undefined

    const result = resolveCourse(courseInput);

    if (result.none) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ No course folder found matching "${courseInput}".`
        }, { quoted: msg });
    }

    if (result.ambiguous) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Please select a course:\n\n${result.ambiguous.map(c => `• ${c}`).join("\n")}`
        }, { quoted: msg });
    }

    const course = result.resolved;
    const files = listPdfFiles(course);

    if (files.length === 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `📂 No slides uploaded yet for *${course}*.`
        }, { quoted: msg });
    }

    // --- .slides <course>  (just list) ---
    if (!secondArg) {
        const listText = files.map((f, i) => `${i + 1}. ${f}`).join("\n");
        return await sock.sendMessage(msg.key.remoteJid, {
            text:
`📚 *${course} Slides* (${files.length})

${listText}

Send a specific one:
.slides ${course} <number>

Or all of them:
.slides ${course} all`
        }, { quoted: msg });
    }

    // --- .slides <course> all ---
    if (secondArg.toLowerCase() === "all") {

        await sock.sendMessage(msg.key.remoteJid, {
            text: `📤 Sending all ${files.length} slide(s) for *${course}*...`
        }, { quoted: msg });

        for (const fileName of files) {
            const filePath = path.join(SLIDES_DIR, course, fileName);
            await sock.sendMessage(msg.key.remoteJid, {
                document: fs.readFileSync(filePath),
                mimetype: "application/pdf",
                fileName: fileName
            });
        }

        return;

    }

    // --- .slides <course> <number> ---
    const index = Number(secondArg);

    if (!Number.isInteger(index) || index < 1 || index > files.length) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Invalid slide number. *${course}* has ${files.length} slide(s) — use 1-${files.length}, or "all".`
        }, { quoted: msg });
    }

    const fileName = files[index - 1];
    const filePath = path.join(SLIDES_DIR, course, fileName);

    await sock.sendMessage(msg.key.remoteJid, {
        document: fs.readFileSync(filePath),
        mimetype: "application/pdf",
        fileName: fileName
    }, { quoted: msg });

}

module.exports = { slidesCommand };