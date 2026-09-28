// commands/ai.js
//
// .ai <prompt>
// -------------
// 1. Answer a question/instruction — plain text, vision-aware if replying
//    to an image, or .teach-style page-by-page reading if replying to a PDF.
// 2. Generate a real file (docx/xlsx/pptx/pdf) — but ONLY after the user
//    confirms via ".ai yes" once asked. Nothing is built before that.
//
// Routing (answer vs generate_file) is a small Azure AI classification
// call, separate from the "real" answer/draft call — a malformed
// classification response safely defaults to "answer".
//
// NOTE: assumes downloadMediaMessage's usual (message, type, options)
// signature — worth a quick real-world test since Baileys versions vary.

"use strict";

const fs = require("fs");
const path = require("path");
async function getDownloadMediaMessage() {
    const baileys = await import("@whiskeysockets/baileys");
    return baileys.downloadMediaMessage;
}

const { callAI } = require("../lib/textAIClient");
const { callVision } = require("../lib/visionClient");
const { extractDocumentPages } = require("./teach"); // requires the teach.js export change above
const { startProgress } = require("../lib/progressIndicator");
const { setPending, getPending, clearPending } = require("../lib/pendingRequests");
const { buildDocx, buildXlsx, buildPptx, buildPdf } = require("../lib/fileBuilders");

const CHUNK_CHARS = 2500;
const MESSAGE_CHARS = 3500;

const ROUTING_SYSTEM_PROMPT = `
You are a routing classifier for a WhatsApp bot command. Given a user's
prompt (and a note about what, if anything, they replied to), decide
whether they want a normal answer, or a generated downloadable file.

Reply with STRICT JSON ONLY, no markdown, exactly one of:
{"action":"answer"}
{"action":"generate_file","format":"docx"}
{"action":"generate_file","format":"xlsx"}
{"action":"generate_file","format":"pptx"}
{"action":"generate_file","format":"pdf"}

Only pick generate_file if the user clearly wants a document produced —
e.g. "put this in a word doc", "make a spreadsheet of these", "turn this
into a PDF", "create a slide deck about X". Summarizing, explaining,
solving, or answering something is "answer", even if a file was the
source rather than the destination.
`.trim();

const DRAFT_SYSTEM_PROMPT = `
You are drafting real content for a generated document, based on the
user's request and (if provided) real extracted source content. Only use
information present in the prompt or source content — never invent
facts, numbers, or figures. Reply with STRICT JSON ONLY, no markdown
fences, matching exactly the schema given.
`.trim();

const DRAFT_SCHEMAS = {
    docx: `Schema: {"title":"string","sections":[{"heading":"string","body":"string"}]}`,
    pdf: `Schema: {"title":"string","sections":[{"heading":"string","body":"string"}]}`,
    pptx: `Schema: {"title":"string","slides":[{"title":"string","bullets":["string"]}]}`,
    xlsx: `Schema: {"sheets":[{"name":"string","headers":["string"],"rows":[["cell"]]}]}`
};

const FORMAT_LABELS = { docx: "Word document", xlsx: "Excel spreadsheet", pptx: "PowerPoint presentation", pdf: "PDF document" };

const MIME_TYPES = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pdf: "application/pdf"
};

function safeParseJson(str) {
    try {
        return JSON.parse(str.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
    } catch (err) {
        return null;
    }
}

// Keep quick questions visually lightweight. Longer/analytical prompts,
// attached media and file-generation requests get a second "Thinking" stage.
function requestNeedsThinking(prompt, media, routing = null) {

    if (media) return true;

    if (routing?.action === "generate_file") {
        return true;
    }

    const value = String(prompt || "");

    if (value.length >= 180) {
        return true;
    }

    return /\b(analy[sz]e|compare|debug|solve|calculate|reason|review|summari[sz]e|plan|research|step[- ]?by[- ]?step|explain why|how does|write|create|design)\b/i
        .test(value);
}

async function splitAndSend(sock, chatId, text, quoted) {
    for (let i = 0; i < text.length; i += MESSAGE_CHARS) {
        const piece = text.slice(i, i + MESSAGE_CHARS);
        await sock.sendMessage(chatId, { text: piece }, i === 0 ? { quoted } : undefined);
    }
}

/**
 * Pulls the quoted message's media (image or PDF) out of a .ai reply.
 * Returns null if the reply isn't to media, or isn't a reply at all.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
 * @returns {Promise<{type:'image'|'pdf', buffer:Buffer, mimeType:string}|null>}
 */
async function getQuotedMedia(sock, msg) {

    const context = msg.message?.extendedTextMessage?.contextInfo;
    const quoted = context?.quotedMessage;

    if (!quoted) return null;

    const fakeMsg = {
        key: {
            remoteJid: msg.key.remoteJid,
            id: context.stanzaId,
            participant: context.participant,
            fromMe: false
        },
        message: quoted
    };

   if (quoted.imageMessage) {
    const downloadMediaMessage = await getDownloadMediaMessage();
    const buffer = await downloadMediaMessage(fakeMsg, "buffer", {});

    return {
        type: "image",
        buffer,
        mimeType: quoted.imageMessage.mimetype || "image/jpeg"
    };
}

if (quoted.documentMessage && (quoted.documentMessage.mimetype || "").includes("pdf")) {
    const downloadMediaMessage = await getDownloadMediaMessage();
    const buffer = await downloadMediaMessage(fakeMsg, "buffer", {});

    return {
        type: "pdf",
        buffer,
        mimeType: "application/pdf"
    };
}

return null;

}

async function handleAnswer(sock, msg, chatId, prompt, media, progress, showThinking) {

    if (media && media.type === "image") {

        await progress.update("🖼️ Reviewing the image...");

        if (showThinking) {
            await progress.update("🧠 Thinking...");
        }

        const answer = await callVision(
            "You are a helpful assistant. Answer the user's request about the attached image directly and accurately.",
            prompt || "Describe and analyze this image.",
            media.buffer,
            media.mimeType
        );
        await splitAndSend(sock, chatId, answer, msg);
        return;
    }

    if (media && media.type === "pdf") {

        await progress.update("📄 Reviewing the document...");

        const pages = await extractDocumentPages(media.buffer);
        const partials = [];

        for (let i = 0; i < pages.length; i++) {

            await progress.update(
                `📄 Reviewing document... ${i + 1}/${pages.length}`
            );

            const { text, images } = pages[i];
            const trimmedText = text.slice(0, CHUNK_CHARS);

            if (images.length > 0) {

                for (const imageBuffer of images) {
                    try {
                        const result = await callVision(
                            "You are reading a page from a document to answer the user's request.",
                            `User's request: ${prompt}\n\nPage ${i + 1} of ${pages.length}. Text on this page:\n${trimmedText}`,
                            imageBuffer,
                            "image/png"
                        );
                        partials.push(result);
                    } catch (err) {
                        console.error("[.ai] vision call failed on a PDF page:", err.message);
                    }
                }

            } else if (trimmedText) {

                const result = await callAI(
                    "You are reading a page from a document to answer the user's request.",
                    [{ role: "user", content: `User's request: ${prompt}\n\nPage ${i + 1} of ${pages.length}:\n${trimmedText}` }]
                );
                partials.push(result);

            }

        }

        if (partials.length === 0) {
            await sock.sendMessage(chatId, { text: "⚠️ Could not extract any readable content from that PDF." }, { quoted: msg });
            return;
        }

        if (showThinking) {
            await progress.update("🧠 Thinking...");
        }

        const merged = partials.length === 1
            ? partials[0]
            : await callAI(
                "Combine partial answers from consecutive document pages into one cohesive final answer.",
                [{ role: "user", content: `User's request: ${prompt}\n\nCombine these partial findings:\n\n${partials.join("\n\n---\n\n")}` }]
            );

        await splitAndSend(sock, chatId, merged, msg);
        return;

    }

    if (showThinking) {
        await progress.update("🧠 Thinking...");
    }

    const answer = await callAI("You are a helpful, direct assistant.", [{ role: "user", content: prompt }]);
    await splitAndSend(sock, chatId, answer, msg);

}

async function handleGenerateFile(sock, msg, chatId, senderId, prompt, format, media, progress) {

    const label = FORMAT_LABELS[format] || format;
    let sourceContext = "";
    const sourceImages = [];

    if (media && media.type === "image") {

        await progress.update("🖼️ Reviewing the attached image...");

        sourceImages.push({ buffer: media.buffer, mimeType: media.mimeType });

        try {
            sourceContext = await callVision(
                "Describe the factual content of this image plainly, for use as source material in a document.",
                "Describe this image in detail.",
                media.buffer,
                media.mimeType
            );
        } catch (err) {
            console.error("[.ai] vision pre-read for file generation failed:", err.message);
        }

    } else if (media && media.type === "pdf") {

        await progress.update("📄 Reviewing the attached document...");

        const pages = await extractDocumentPages(media.buffer);
        const textParts = [];

        for (const page of pages) {
            if (page.text) textParts.push(page.text.slice(0, CHUNK_CHARS));
            for (const img of page.images.slice(0, 3)) sourceImages.push({ buffer: img, mimeType: "image/png" });
        }

        sourceContext = textParts.join("\n\n");

    }

    await progress.update("🧠 Thinking...");

    setPending(chatId, senderId, { prompt, format, sourceContext, sourceImages });

    await sock.sendMessage(chatId, {
        text: `📄 This looks like a request to generate a *${label}*.\n\nReply *.ai yes* to go ahead, or *.ai no* to cancel.`
    }, { quoted: msg });

}

async function handleConfirmedGeneration(sock, msg, chatId, pendingReq) {

    const { prompt, format, sourceContext, sourceImages } = pendingReq;
    const progress = await startProgress(sock, msg, "🔎 Reviewing your request...");

    let filePath;

    try {

        const draftPromptParts = [
            `User's request: ${prompt}`,
            sourceContext ? `Real source content to base this on:\n${sourceContext.slice(0, 6000)}` : "",
            DRAFT_SCHEMAS[format]
        ].filter(Boolean).join("\n\n");

        await progress.update("🧠 Thinking...");

        const draftRaw = await callAI(DRAFT_SYSTEM_PROMPT, [{ role: "user", content: draftPromptParts }]);
        const draft = safeParseJson(draftRaw);

        if (!draft) throw new Error("AI draft response was not valid JSON");

        await progress.update("📄 Building file...");

        if (format === "docx") filePath = await buildDocx(draft, sourceImages);
        else if (format === "pdf") filePath = await buildPdf(draft, sourceImages);
        else if (format === "pptx") filePath = await buildPptx(draft, sourceImages);
        else if (format === "xlsx") filePath = await buildXlsx(draft);
        else throw new Error(`Unsupported format: ${format}`);

        await sock.sendMessage(chatId, {
            document: { url: filePath },
            fileName: path.basename(filePath),
            mimetype: MIME_TYPES[format]
        }, { quoted: msg });

        await progress.succeed("✅ File ready");

    } catch (err) {

        console.error("[.ai] file generation failed:", err.message);
        await progress.fail();

    } finally {

        if (filePath) fs.unlink(filePath, () => {});

    }

}

async function aiCommand(sock, msg, text) {

    const chatId = msg.key.remoteJid;
    const senderId = msg.key.participant || msg.key.remoteJid;
    const body = text.replace(/^\.ai/i, "").trim();

    if (/^(yes|y)$/i.test(body)) {
        const pendingReq = getPending(chatId, senderId);
        if (!pendingReq) return await sock.sendMessage(chatId, { text: "⚠️ I don't have a pending file request from you to confirm." }, { quoted: msg });
        clearPending(chatId, senderId);
        return await handleConfirmedGeneration(sock, msg, chatId, pendingReq);
    }

    if (/^(no|n|cancel)$/i.test(body)) {
        const pendingReq = getPending(chatId, senderId);
        if (!pendingReq) return await sock.sendMessage(chatId, { text: "⚠️ I don't have a pending file request from you to cancel." }, { quoted: msg });
        clearPending(chatId, senderId);
        return await sock.sendMessage(chatId, { text: "❌ Cancelled — no file was created." }, { quoted: msg });
    }

    if (!body) return await sock.sendMessage(chatId, { text: "Usage: .ai <your question or request>" }, { quoted: msg });

    const progress =
        await startProgress(
            sock,
            msg,
            "🔎 Reviewing your prompt..."
        );

    try {

        let media;

        try {
            media = await getQuotedMedia(sock, msg);
        } catch (err) {
            console.error("[.ai] failed to download quoted media:", err.message);
            media = null;
        }

        const mediaDescription =
            media
                ? `an ${media.type} is attached`
                : "nothing is attached";

        const routingRaw =
            await callAI(
                ROUTING_SYSTEM_PROMPT,
                [
                    {
                        role: "user",
                        content:
                            `Prompt: ${body}\n\n(${mediaDescription})`
                    }
                ]
            );

        const routing =
            safeParseJson(routingRaw);

        const showThinking =
            requestNeedsThinking(
                body,
                media,
                routing
            );

        if (
            !routing ||
            routing.action !== "generate_file" ||
            !DRAFT_SCHEMAS[routing.format]
        ) {

            await handleAnswer(
                sock,
                msg,
                chatId,
                body,
                media,
                progress,
                showThinking
            );

            await progress.succeed(
                "✅ Response ready"
            );

            return;
        }

        await handleGenerateFile(
            sock,
            msg,
            chatId,
            senderId,
            body,
            routing.format,
            media,
            progress
        );

        await progress.succeed(
            "✅ Request reviewed — awaiting confirmation"
        );

    } catch (err) {

        console.error(
            "[.ai] request failed:",
            err.message
        );

        await progress.fail(
            "❌ AI request failed"
        );

        await sock.sendMessage(
            chatId,
            {
                text:
                    "⚠️ I couldn't complete that AI request right now."
            },
            {
                quoted: msg
            }
        );

    }

}

module.exports = { aiCommand };