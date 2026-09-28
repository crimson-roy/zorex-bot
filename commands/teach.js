// commands/teach.js
//
// .teach <course> <number>   -> reads that ONE slide PDF and sends back an
//                                AI-generated summary of its contents.
// .teach <course> all        -> rejected on purpose. Summarizing several
//                                documents at once burns way more tokens
//                                and produces a worse, muddier summary than
//                                doing them one at a time.
//
// Reuses the exact same course-folder resolution as .slides (lib/slidesHelper.js)
// so course names/numbers behave identically between the two commands.
//
// IMAGE HANDLING (this is the part that changed):
// Previously this used pdf-parse, which only ever sees embedded TEXT — any
// page that's a diagram, scanned figure, or screenshot pasted into the
// slide came back blank. Now this uses pdfjs-dist per page:
//   - every page's embedded raster images (paintImageXObject /
//     paintJpegXObject operators) are detected and pulled out
//   - a page with no embedded images -> its text goes to Azure text AI
//   - a page WITH embedded image(s) -> those images (rendered to real PNG
//     buffers via the `canvas` package) are sent to Azure multimodal vision
//     (lib/visionClient.js), along with any of the page's own text as
//     context, so a slide with both a diagram AND a caption/heading gets
//     both taken into account
// Known limitation, accepted on purpose: this catches actual embedded
// pictures (screenshots, photos, scanned figures) — the overwhelming
// majority of real slide images. It won't "see" a diagram drawn purely
// with native PDF vector-line operators rather than pasted in as a
// picture. Full-page rasterization would catch that too, at the cost of
// a much heavier per-page render step — worth revisiting only if that
// turns out to be a real problem in practice.

const fs = require("fs");
const path = require("path");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { createCanvas } = require("canvas");

const { SLIDES_DIR, listPdfFiles, resolveCourse } = require("../lib/slidesHelper");
const { callAI } = require("../lib/textAIClient");
const { callVision } = require("../lib/visionClient");

// Character budget per page's text sent to the AI in one call. Kept
// conservative so prompt + text + requested summary comfortably fit
// smaller-context models (roughly 4 chars/token, so ~2500 chars ≈ 600
// tokens of source text per page).
const CHUNK_CHARS = 2500;

// WhatsApp text messages can technically be huge, but very long single
// messages are unwieldy to read on a phone — split the final summary into
// message-sized pieces instead of dumping it all in one bubble.
const MESSAGE_CHARS = 3500;

// Embedded images smaller than this (in either dimension) are almost
// always decorative — bullet icons, logos, small dividers — not actual
// diagrams/figures worth a vision call. Skipped to avoid wasting Azure
// vision calls on decorative noise.
const MIN_IMAGE_DIMENSION = 80;

const SUMMARY_SYSTEM_PROMPT = `
You are a clear, organized academic tutor helping a student study lecture
material. Summarize the given document content thoroughly but concisely:
cover key concepts, definitions, formulas, and important examples. Use
short headings and bullet points where that helps readability. Only use
information present in the source content — never invent facts, sources,
or figures that aren't there. If the content looks like it's not real
slide content (e.g. garbled/empty extraction), say so plainly instead of
making something up.
`.trim();

const PAGE_SUMMARY_INSTRUCTION = (pageIdx, totalPages) => `
This is page ${pageIdx} of ${totalPages} of a larger document. Summarize
ONLY this page's key points concisely — these partial summaries will be
combined into one final summary afterward, so don't add framing like
"on this page" or "continuing from before".
`.trim();

const VISION_PAGE_INSTRUCTION = (pageIdx, totalPages, contextText) => `
${PAGE_SUMMARY_INSTRUCTION(pageIdx, totalPages)}

${contextText ? `Text extracted from this same slide:\n${contextText}\n\n` : ""}Describe and summarize the key educational content shown in the attached image(s) from this slide, in the context of any text above. If the image is purely decorative (a logo, a background, a divider) and carries no educational content, say so briefly instead of over-describing it.
`.trim();

const FINAL_MERGE_INSTRUCTION = `
Below are partial summaries of consecutive pages of the same document, in
order. Combine them into ONE cohesive, well-organized final summary of the
whole document. Remove redundancy between pages, but don't drop any
distinct concept, definition, or formula that appears in them.
`.trim();

function chunkText(text, size) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
    }
    return chunks;
}

async function splitAndSend(sock, chatId, text, quoted) {
    for (let i = 0; i < text.length; i += MESSAGE_CHARS) {
        const piece = text.slice(i, i + MESSAGE_CHARS);
        await sock.sendMessage(chatId, { text: piece }, i === 0 ? { quoted } : undefined);
    }
}

/**
 * Resolves a pdf.js page object reference (page.objs.get) as a Promise,
 * supporting both the callback-based and (when already resolved) the
 * synchronous-return forms different pdfjs-dist versions have used.
 *
 * @param {any} page
 * @param {string} objId
 * @returns {Promise<any>}
 */
function getPageObject(page, objId) {
    return new Promise((resolve, reject) => {
        try {
            const maybeSync = page.objs.get(objId, (obj) => resolve(obj));
            if (maybeSync !== undefined) resolve(maybeSync);
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Converts a pdf.js decoded image object (raw pixel data) into a real
 * PNG buffer via the `canvas` package, so it's something an actual
 * vision API can accept. Handles the two pixel layouts pdf.js commonly
 * hands back (RGB with no alpha, and RGBA). Returns null for anything
 * else (e.g. a 1-bit stencil mask) rather than guessing at a conversion.
 *
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} img
 * @returns {Buffer|null}
 */
function pdfImageToPngBuffer(img) {
    const { width, height, data } = img;

    if (!width || !height || !data) return null;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(width, height);

    if (data.length === width * height * 4) {
        // Already RGBA.
        imageData.data.set(data);
    } else if (data.length === width * height * 3) {
        // RGB with no alpha channel — expand to RGBA.
        for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
            imageData.data[j] = data[i];
            imageData.data[j + 1] = data[i + 1];
            imageData.data[j + 2] = data[i + 2];
            imageData.data[j + 3] = 255;
        }
    } else {
        // Unsupported pixel format (e.g. a 1bpp mask) — skip rather than
        // risk rendering garbage.
        return null;
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas.toBuffer("image/png");
}

/**
 * Finds every embedded raster image on a page (skipping anything below
 * MIN_IMAGE_DIMENSION in either dimension, since those are almost always
 * decorative), returning each as a ready-to-send PNG buffer.
 *
 * @param {any} page - a pdfjs-dist page object
 * @returns {Promise<Buffer[]>}
 */
async function extractPageImages(page) {

    const opList = await page.getOperatorList();
    const buffers = [];

    for (let i = 0; i < opList.fnArray.length; i++) {

        const fn = opList.fnArray[i];

        if (fn !== pdfjsLib.OPS.paintImageXObject && fn !== pdfjsLib.OPS.paintJpegXObject) {
            continue;
        }

        const objId = opList.argsArray[i][0];

        try {

            const img = await getPageObject(page, objId);

            if (!img || !img.width || !img.height) continue;
            if (img.width < MIN_IMAGE_DIMENSION || img.height < MIN_IMAGE_DIMENSION) continue;

            const buffer = pdfImageToPngBuffer(img);
            if (buffer) buffers.push(buffer);

        } catch (err) {

            console.error(`[teach] failed to extract an embedded image (objId=${objId}):`, err.message);

        }

    }

    return buffers;

}

/**
 * Extracts every page of a PDF as { text, images } — text via pdf.js's
 * normal text-content extraction, images via extractPageImages() above.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<Array<{ text: string, images: Buffer[] }>>}
 */
async function extractDocumentPages(pdfBuffer) {

    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) });
    const pdfDoc = await loadingTask.promise;

    const pages = [];

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {

        const page = await pdfDoc.getPage(pageNum);

        const textContent = await page.getTextContent();
        const text = textContent.items.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim();

        const images = await extractPageImages(page);

        pages.push({ text, images });

    }

    return pages;

}

/**
 * Summarizes a single page: text-only pages go through Azure text AI;
 * pages with embedded image(s) go through Azure multimodal vision, with
 * the page's own text passed along as context. If vision fails for
 * every image on an image-page (API error, etc.), falls back to
 * summarizing whatever text is on that page rather than dropping it
 * silently. Returns null only for a genuinely empty page (no text, no
 * usable images).
 *
 * @param {{ text: string, images: Buffer[] }} pageInfo
 * @param {number} pageIdx - 1-based
 * @param {number} totalPages
 * @returns {Promise<string|null>}
 */
async function summarizePage(pageInfo, pageIdx, totalPages) {

    const { text, images } = pageInfo;
    const trimmedText = text.slice(0, CHUNK_CHARS);

    if (images.length === 0) {

        if (!trimmedText) return null;

        return await callAI(SUMMARY_SYSTEM_PROMPT, [
            { role: "user", content: `${PAGE_SUMMARY_INSTRUCTION(pageIdx, totalPages)}\n\n${trimmedText}` }
        ]);

    }

    const visionPrompt = VISION_PAGE_INSTRUCTION(pageIdx, totalPages, trimmedText);
    const imageSummaries = [];

    for (const imageBuffer of images) {

        try {

            const result = await callVision(SUMMARY_SYSTEM_PROMPT, visionPrompt, imageBuffer, "image/png");
            imageSummaries.push(result);

        } catch (err) {

            console.error("[teach] vision call failed for an embedded image:", err.message);

        }

    }

    if (imageSummaries.length > 0) {
        return imageSummaries.join("\n\n");
    }

    // Every vision call failed — fall back to text-only for this page
    // rather than silently losing it from the summary.
    if (trimmedText) {
        return await callAI(SUMMARY_SYSTEM_PROMPT, [
            { role: "user", content: `${PAGE_SUMMARY_INSTRUCTION(pageIdx, totalPages)}\n\n${trimmedText}` }
        ]);
    }

    return null;

}

/**
 * Map-reduce over every page: summarize each page individually (map),
 * then merge all page summaries into one cohesive final summary
 * (reduce) — same two-phase pattern as before, just page-driven instead
 * of fixed-character-chunk-driven.
 *
 * @param {Array<{ text: string, images: Buffer[] }>} pages
 * @returns {Promise<string>}
 */
async function summarizeDocument(pages) {

    const partials = [];

    for (let i = 0; i < pages.length; i++) {

        const summary = await summarizePage(pages[i], i + 1, pages.length);
        if (summary) partials.push(summary);

    }

    if (partials.length === 0) {
        throw new Error("no summarizable text or images were found in this document");
    }

    if (partials.length === 1) {
        return partials[0];
    }

    return await callAI(SUMMARY_SYSTEM_PROMPT, [
        { role: "user", content: `${FINAL_MERGE_INSTRUCTION}\n\n${partials.join("\n\n---\n\n")}` }
    ]);

}

async function teachCommand(sock, msg, text) {

    const chatId = msg.key.remoteJid;

    const args = text.replace(/^\.teach/i, "").trim().split(/\s+/).filter(Boolean);

    if (args.length === 0) {
        return await sock.sendMessage(chatId, {
            text:
`⚠️ Usage:

.teach <course> <number>   — summarize one specific document

Example:
.teach PHY102 3

.teach <course> all is not supported — pick one document at a time.`
        }, { quoted: msg });
    }

    const courseInput = args[0];
    const secondArg = args[1];

    const result = resolveCourse(courseInput);

    if (result.none) {
        return await sock.sendMessage(chatId, {
            text: `❌ No course folder found matching "${courseInput}".`
        }, { quoted: msg });
    }

    if (result.ambiguous) {
        return await sock.sendMessage(chatId, {
            text: `⚠️ Please select a course:\n\n${result.ambiguous.map(c => `• ${c}`).join("\n")}`
        }, { quoted: msg });
    }

    const course = result.resolved;
    const files = listPdfFiles(course);

    if (files.length === 0) {
        return await sock.sendMessage(chatId, {
            text: `📂 No slides uploaded yet for *${course}*.`
        }, { quoted: msg });
    }

    if (!secondArg) {
        return await sock.sendMessage(chatId, {
            text: `⚠️ Please specify which document, e.g. .teach ${course} 1\n\nUse .slides ${course} to see the list.`
        }, { quoted: msg });
    }

    if (secondArg.toLowerCase() === "all") {
        return await sock.sendMessage(chatId, {
            text: `⚠️ Please choose a specific document — .teach can only summarize one document at a time.`
        }, { quoted: msg });
    }

    const index = Number(secondArg);

    if (!Number.isInteger(index) || index < 1 || index > files.length) {
        return await sock.sendMessage(chatId, {
            text: `⚠️ Invalid document number. *${course}* has ${files.length} document(s) — use 1-${files.length}.`
        }, { quoted: msg });
    }

    const fileName = files[index - 1];
    const filePath = path.join(SLIDES_DIR, course, fileName);

    await sock.sendMessage(chatId, {
        text: `📖 Reading *${fileName}*... this may take a moment for longer or image-heavy documents.`
    }, { quoted: msg });

    let pages;

    try {

        const buffer = fs.readFileSync(filePath);
        pages = await extractDocumentPages(buffer);

    } catch (err) {

        console.error("[teach] PDF parse failed:", err.message);
        return await sock.sendMessage(chatId, {
            text: `❌ Couldn't read that PDF — it may be corrupted or password-protected.`
        }, { quoted: msg });

    }

    const hasAnyContent = pages.some((p) => p.text || p.images.length > 0);

    if (!hasAnyContent) {
        return await sock.sendMessage(chatId, {
            text: `⚠️ Couldn't extract any readable text or images from *${fileName}*.`
        }, { quoted: msg });
    }

    try {

        const summary = await summarizeDocument(pages);
        await splitAndSend(sock, chatId, `📘 *${course} — ${fileName}*\n\n${summary}`, msg);

    } catch (err) {

        console.error("[teach] summarization failed:", err.message);
        await sock.sendMessage(chatId, {
            text: `❌ Summarization failed — try again in a moment.`
        }, { quoted: msg });

    }

}

module.exports = {
    teachCommand,
    extractDocumentPages
};