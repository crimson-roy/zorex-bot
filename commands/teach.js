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

const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const { SLIDES_DIR, listPdfFiles, resolveCourse } = require("../lib/slidesHelper");
const { callAI } = require("../lib/aiClient");

// Character budget per chunk sent to the AI in one call. Kept conservative
// so prompt + chunk + requested summary comfortably fit smaller-context
// models (roughly 4 chars/token, so ~6000 chars ≈ 1500 tokens of source text).
const CHUNK_CHARS = 2500;

// WhatsApp text messages can technically be huge, but very long single
// messages are unwieldy to read on a phone — split the final summary into
// message-sized pieces instead of dumping it all in one bubble.
const MESSAGE_CHARS = 3500;

const SUMMARY_SYSTEM_PROMPT = `
You are a clear, organized academic tutor helping a student study lecture
material. Summarize the given document content thoroughly but concisely:
cover key concepts, definitions, formulas, and important examples. Use
short headings and bullet points where that helps readability. Only use
information present in the source text — never invent facts, sources, or
figures that aren't there. If the content looks like it's not real slide
content (e.g. garbled/empty extraction), say so plainly instead of making
something up.
`.trim();

const CHUNK_SUMMARY_INSTRUCTION = (partIdx, totalParts) => `
This is part ${partIdx} of ${totalParts} of a larger document. Summarize
ONLY this part's key points concisely — these partial summaries will be
combined into one final summary afterward, so don't add framing like
"in this part" or "continuing from before".
`.trim();

const FINAL_MERGE_INSTRUCTION = `
Below are partial summaries of consecutive sections of the same document,
in order. Combine them into ONE cohesive, well-organized final summary of
the whole document. Remove redundancy between sections, but don't drop
any distinct concept, definition, or formula that appears in them.
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

async function summarizeDocument(rawText) {

    const chunks = chunkText(rawText, CHUNK_CHARS);

    if (chunks.length === 1) {
        return await callAI(SUMMARY_SYSTEM_PROMPT, [
            { role: "user", content: chunks[0] }
        ]);
    }

    // Map: summarize each chunk on its own
    const partialSummaries = [];
    for (let i = 0; i < chunks.length; i++) {
        const partSummary = await callAI(SUMMARY_SYSTEM_PROMPT, [
            { role: "user", content: `${CHUNK_SUMMARY_INSTRUCTION(i + 1, chunks.length)}\n\n${chunks[i]}` }
        ]);
        partialSummaries.push(partSummary);
    }

    // Reduce: merge all partial summaries into one final summary
    const merged = await callAI(SUMMARY_SYSTEM_PROMPT, [
        { role: "user", content: `${FINAL_MERGE_INSTRUCTION}\n\n${partialSummaries.join("\n\n---\n\n")}` }
    ]);

    return merged;

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
        text: `📖 Reading *${fileName}*... this may take a moment for longer documents.`
    }, { quoted: msg });

    let rawText;

    try {

        const buffer = fs.readFileSync(filePath);
        const parsed = await pdfParse(buffer);
        rawText = (parsed.text || "").trim();

    } catch (err) {

        console.error("[teach] PDF parse failed:", err.message);
        return await sock.sendMessage(chatId, {
            text: `❌ Couldn't read that PDF — it may be corrupted or password-protected.`
        }, { quoted: msg });

    }

    if (!rawText) {
        return await sock.sendMessage(chatId, {
            text: `⚠️ Couldn't extract any readable text from *${fileName}* — it might be a scanned/image-based PDF rather than real text.`
        }, { quoted: msg });
    }

    try {

        const summary = await summarizeDocument(rawText);
        await splitAndSend(sock, chatId, `📘 *${course} — ${fileName}*\n\n${summary}`, msg);

    } catch (err) {

        console.error("[teach] summarization failed:", err.message);
        await sock.sendMessage(chatId, {
            text: `❌ Summarization failed — try again in a moment.`
        }, { quoted: msg });

    }

}

module.exports = { teachCommand };