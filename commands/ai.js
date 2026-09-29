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
const { readDocument } = require("../lib/documentReader");
const { extractDocumentPages } = require("./teach"); // requires the teach.js export change above
const { startProgress } = require("../lib/progressIndicator");
const { setPending, getPending, clearPending } = require("../lib/pendingRequests");
const { buildDocx, buildXlsx, buildPptx, buildPdf } = require("../lib/fileBuilders");
const { generateImageFromPrompt } = require("./image");
const { generateVideoFromPrompt } = require("./video");
const { ZOREX_AI_SYSTEM_PROMPT } = require("../lib/zorexPersona");
const { authorizeAiRequest } = require("../lib/aiAuth");
const {
    appendHistory,
    getHistory,
    getConversationMessages
} = require("../lib/aiUserStore");
const {
    normalizeCommandPlan,
    bindCommandContext,
    calculateExposure,
    requiresConfirmation,
    describePlan,
    executeAiCommandPlan
} = require("../lib/aiCommandExecutor");

const CHUNK_CHARS = 2500;
const MESSAGE_CHARS = 3500;

const ROUTING_SYSTEM_PROMPT = `
You are a routing classifier for Zorex, a WhatsApp bot. Given a user's
prompt (and a note about attached media), decide whether they want a
normal AI answer, a generated file/image/video, or one or more supported Zorex
actions executed.

Reply with STRICT JSON ONLY, no markdown, matching exactly one shape:

{"action":"answer"}
{"action":"generate_image"}
{"action":"generate_video"}
{"action":"generate_file","format":"docx"}
{"action":"generate_file","format":"xlsx"}
{"action":"generate_file","format":"pptx"}
{"action":"generate_file","format":"pdf"}
{"action":"execute_commands","commands":[...]}

For execute_commands, commands may ONLY use these exact schemas:
{"name":"balance"}
{"name":"profile"}
{"name":"company"}
{"name":"inventory","index":1}
{"name":"collection","index":1}
{"name":"deposit","amount":50000}
{"name":"deposit","amount":"all"}
{"name":"withdraw","amount":50000}
{"name":"withdraw","amount":"all"}
{"name":"daily"}
{"name":"work","tier":1}
{"name":"company_upgrade"}
{"name":"transfer","amount":250000}
{"name":"shop_buy","item":"fishing rod","quantity":1}
{"name":"cshop_buy","slot":6}
{"name":"set_welcome","message":"Welcome to the group 😹"}
{"name":"set_leave","message":"Bye bye 😭"}
{"name":"group_open"}
{"name":"group_close"}
{"name":"add_owner"}
{"name":"promote_user"}
{"name":"demote_user"}
{"name":"mute_user","duration":"","kick_if_spam":false,"spam_limit":5,"spam_window_seconds":30}
{"name":"unmute_user"}
{"name":"kick_user"}
{"name":"mute_all"}
{"name":"unmute_all"}
{"name":"card_search","query":"card name","tier":"SSR"}
{"name":"series_search","query":"series name"}
{"name":"casino","amount":5000,"repeats":10}
{"name":"slots","amount":5000,"repeats":10}
{"name":"video_depth","mist":"none"}
{"name":"video_depth","mist":"soft"}
{"name":"video_depth","mist":"mist"}
{"name":"video_depth","mist":"heavy"}
{"name":"video_upscale","scale":4,"quality":true}

Rules:
- Use execute_commands only when the user wants Zorex to PERFORM or SHOW
  one of those supported actions.
- "show my balance" => balance.
- "show my profile" => profile.
- "show my company" => company.
- "show my inventory" => inventory with no index.
- "show inventory item 3" => inventory index 3.
- "show my collection" => collection with no index.
- "show collection item 2" => collection index 2.
- "deposit 50000" => deposit amount 50000.
- "deposit all" => deposit amount "all".
- "withdraw 20000" => withdraw amount 20000.
- "withdraw all" => withdraw amount "all".
- "claim daily" or "claim my daily reward" => daily.
- "work" => work tier 1.
- "work tier 2" or "do work 2" => work tier 2.
- "upgrade my company" => company_upgrade.
- "send 250000 to @user" or a transfer request made while replying to a
  recipient => transfer amount 250000. Do NOT invent or output a target JID;
  the executor binds the recipient from the actual WhatsApp mention/reply.
- "buy shovel" => shop_buy item "shovel" quantity 1.
- "buy fishing rod" => shop_buy item "fishing rod" quantity 1.
- "buy 5 raffle tickets" => shop_buy item "raffle ticket" quantity 5.
- "buy shovel and fishing rod" => TWO shop_buy commands, one for each item.
- "buy cshop 6", "buy card shop 6", or "buy card-shop slot 6" =>
  cshop_buy slot 6.
- Never invent a shop price, card ID, or CShop card name. The executor reads
  the current catalog/rotation and computes the real cost itself.
- "set welcome to Welcome to the group" or "setwelcome Welcome to the group"
  => set_welcome with the requested message. Preserve the user's message text.
- "set leave to Bye everyone" or "setleave Bye everyone" => set_leave with
  the requested message. Preserve the user's message text.
- "close the group", "close this group", or "make this group admin only"
  => group_close.
- "open the group", "open this group", or "let everyone send messages"
  => group_open.
- These group actions apply ONLY to the current WhatsApp group. Never invent
  or accept a target group ID/name. The executor uses the real current chat
  and the real command handlers perform owner/admin permission checks.
- "addowner @user", "add @user as owner", or the same request while replying
  to a user => add_owner. Never output a target JID; the executor binds the
  target from the real WhatsApp mention/reply. Only the real MAIN_OWNER
  permission check may authorize this action.
- "promote @user", "make @user admin", or the same request while replying to
  a user => promote_user. Never output a target JID; the executor binds the
  target from the real WhatsApp mention/reply and the real group handler
  checks current admin/owner permissions.
- "demote @user", "remove @user as admin", or the same request while replying
  to a user => demote_user. Never output a target JID; the executor binds the
  target from the real WhatsApp mention/reply and the real group handler
  checks current admin/owner permissions.
- "mute @user" or the same request while replying to a user => mute_user.
  If a duration is given, preserve it in compact form such as "30mins",
  "2hr", or "1d". If omitted, use an empty duration.
- "mute @user and kick him if he keeps spamming" => ONE mute_user action
  with kick_if_spam true. Unless the user gives a threshold, use
  spam_limit 5 and spam_window_seconds 30. This means mute immediately,
  then kick only if they send 5 messages within 30 seconds while muted.
- "unmute @user" or the same request while replying => unmute_user.
- "kick @user" or "remove @user from the group" => kick_user.
- "mute all" => mute_all.
- "unmute all" => unmute_all.
- Never invent a mute/unmute/kick target JID. Bind the target only from the
  real WhatsApp mention/reply. The executor calls the real group handlers,
  so actual WhatsApp admin permissions still decide whether the action works.
- "search Rem SSR" or "find Rem SSR card" => card_search, query "Rem",
  tier "SSR".
- "show JJK cards" or "search JJK series" => series_search.
- "casino 5000 10 times" => casino amount 5000 repeats 10.
- "casino and slots 5000 10 times each" => TWO commands, casino then slots.
- If repeats are omitted, use 1.
- When the user replies to a video and asks for a depth video, depth map,
  or says "apply depth", use video_depth with mist "none".
- When the user replies to a video and asks for depth plus mist/fog, use
  video_depth. Use mist "soft" for subtle/light mist, "heavy" for dense/
  strong mist, otherwise use "mist".
- "make this video depth with heavy mist" => video_depth mist "heavy".
- When the user replies to a video and asks to upscale/enhance its resolution,
  use video_upscale. Use scale 4 unless they explicitly request 2x or 8x.
- Requests for "best quality", "maximum quality", "quality over speed", or
  "take as long as needed" => video_upscale quality true.
- These media actions ONLY operate on the real replied WhatsApp video.
  Never invent a URL, file path, or shell/FFmpeg command.
- Never create owner/admin commands, arbitrary shell commands, raw command
  strings, company creation, employee management, moderation actions other
  than the explicitly listed set_welcome, set_leave, group_open, group_close,
  add_owner, promote_user, demote_user, mute_user, unmute_user, kick_user,
  mute_all and unmute_all actions, direct item/card IDs not supplied by the
  user, or any command not listed above.
- Asking "how does casino work?" is answer, NOT execute_commands.
- Asking what a command does is answer, NOT execute_commands.
- If the user requests an unsupported Zorex action, use answer rather than
  inventing a command.

Pick generate_image when the user clearly asks to create, generate, draw,
render, design, or make a NEW image. Do not pick it merely because an image
is attached for analysis.

Pick generate_video when the user clearly asks to create, generate, animate,
or make a VIDEO. If an image is attached/replied and the user asks to animate
it or turn it into a video, use generate_video. Do not pick generate_video
for ordinary video analysis or when the user is only asking how video
generation works.

Only pick generate_file if the user clearly wants a downloadable document.
Summarizing, explaining, solving, or answering is answer unless one of the
supported Zorex execution actions above is clearly requested.
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

    if (
        routing?.action === "generate_file" ||
        routing?.action === "generate_image" ||
        routing?.action === "generate_video"
    ) {
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

function shortHistoryText(value, max = 90) {
    const text =
        String(value || "")
            .replace(/\s+/g, " ")
            .trim();

    if (text.length <= max) {
        return text;
    }

    return (
        text.slice(
            0,
            Math.max(
                1,
                max - 1
            )
        ) +
        "…"
    );
}

function formatHistoryTime(value) {
    const date =
        new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return "Unknown time";
    }

    try {
        return date.toLocaleString(
            "en-GB",
            {
                timeZone:
                    "Africa/Lagos",
                day:
                    "2-digit",
                month:
                    "short",
                hour:
                    "2-digit",
                minute:
                    "2-digit"
            }
        );
    } catch (_) {
        return date
            .toISOString()
            .slice(0, 16)
            .replace("T", " ");
    }
}

async function showAiHistory(
    sock,
    msg,
    profileId,
    body
) {
    const requested =
        Number(
            String(body || "")
                .trim()
                .split(/\s+/)[1]
        );

    const limit =
        Number.isInteger(requested) &&
        requested > 0
            ? Math.min(
                requested,
                25
            )
            : 10;

    const entries =
        getHistory(
            profileId,
            limit
        );

    if (!entries.length) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    "🧠 *Zorex AI History*\n\nYou don't have any saved AI history yet."
            },
            {
                quoted: msg
            }
        );
    }

    const lines =
        entries
            .slice()
            .reverse()
            .map(
                (entry, index) => {
                    const label =
                        entry.type === "image"
                            ? "🖼️ Image"
                            : entry.type === "file"
                                ? "📄 File"
                                : entry.type === "vision"
                                    ? "👁️ Vision"
                                    : entry.type === "document"
                                        ? "📚 Document"
                                        : "💬 Chat";

                    return (
                        `${index + 1}. *${label}* — ${formatHistoryTime(entry.time)}\n` +
                        `> ${shortHistoryText(entry.user)}`
                    );
                }
            );

    return await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
                `🧠 *Zorex AI History*\n\n${lines.join("\n\n")}\n\n> Showing your latest ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.`
        },
        {
            quoted: msg
        }
    );
}

function unwrapMessage(message) {
    let current =
        message;

    for (
        let depth = 0;
        depth < 6 &&
        current;
        depth++
    ) {

        const wrapped =
            current.ephemeralMessage?.message ||
            current.viewOnceMessage?.message ||
            current.viewOnceMessageV2?.message ||
            current.viewOnceMessageV2Extension?.message ||
            current.documentWithCaptionMessage?.message;

        if (!wrapped) {
            break;
        }

        current =
            wrapped;
    }

    return current || message;
}

function findNestedMessageNode(
    value,
    keyName,
    depth = 0,
    seen = new Set()
) {
    if (
        !value ||
        typeof value !== "object" ||
        depth > 8 ||
        seen.has(value)
    ) {
        return null;
    }

    seen.add(value);

    if (
        Object.prototype.hasOwnProperty.call(
            value,
            keyName
        ) &&
        value[keyName]
    ) {
        return value[keyName];
    }

    for (const child of Object.values(value)) {
        if (
            child &&
            typeof child === "object"
        ) {
            const found =
                findNestedMessageNode(
                    child,
                    keyName,
                    depth + 1,
                    seen
                );

            if (found) {
                return found;
            }
        }
    }

    return null;
}

function messageHasQuotedMedia(
    message
) {
    const context =
        getMessageContextInfo(
            message
        );

    const quoted =
        context?.quotedMessage;

    if (!quoted) {
        return false;
    }

    return Boolean(
        findNestedMessageNode(
            quoted,
            "imageMessage"
        ) ||
        findNestedMessageNode(
            quoted,
            "documentMessage"
        )
    );
}

function messageHasQuotedVideo(message) {
    const context =
        getMessageContextInfo(
            message
        );

    const quoted =
        context?.quotedMessage;

    if (!quoted) {
        return false;
    }

    return Boolean(
        findNestedMessageNode(
            quoted,
            "videoMessage"
        )
    );
}

function messageText(message) {
    if (!message) return "";

    const inner =
        unwrapMessage(
            message
        );

    return String(
        inner.conversation ||
        inner.extendedTextMessage?.text ||
        inner.imageMessage?.caption ||
        inner.documentMessage?.caption ||
        inner.videoMessage?.caption ||
        ""
    ).trim();
}

function findContextInfoRecursive(
    value,
    depth = 0,
    seen = new Set()
) {
    if (
        !value ||
        typeof value !== "object" ||
        depth > 8 ||
        seen.has(value)
    ) {
        return null;
    }

    seen.add(value);

    if (value.contextInfo) {
        return value.contextInfo;
    }

    if (value.messageContextInfo?.quotedMessage) {
        return value.messageContextInfo;
    }

    for (const child of Object.values(value)) {
        if (child && typeof child === "object") {
            const found =
                findContextInfoRecursive(
                    child,
                    depth + 1,
                    seen
                );

            if (found) {
                return found;
            }
        }
    }

    return null;
}

function getMessageContextInfo(message) {
    if (!message) return null;

    const inner =
        unwrapMessage(
            message
        );

    return (
        inner.extendedTextMessage?.contextInfo ||
        inner.imageMessage?.contextInfo ||
        inner.documentMessage?.contextInfo ||
        inner.videoMessage?.contextInfo ||
        inner.stickerMessage?.contextInfo ||
        inner.messageContextInfo ||
        message.messageContextInfo ||
        findContextInfoRecursive(inner) ||
        findContextInfoRecursive(message) ||
        null
    );
}

async function downloadMessageBuffer(
    messageInfo
) {
    const downloadMediaMessage =
        await getDownloadMediaMessage();

    return await downloadMediaMessage(
        messageInfo,
        "buffer",
        {}
    );
}

async function downloadMediaNodeBuffer(
    mediaNode,
    mediaType
) {
    const {
        downloadContentFromMessage
    } =
        await import(
            "@whiskeysockets/baileys"
        );

    const stream =
        await downloadContentFromMessage(
            mediaNode,
            mediaType
        );

    const chunks =
        [];

    for await (
        const chunk of
        stream
    ) {
        chunks.push(
            Buffer.from(
                chunk
            )
        );
    }

    return Buffer.concat(
        chunks
    );
}

/**
 * Finds the source material for an .ai request.
 *
 * Priority:
 * 1. Replied/quoted message (text, image, document)
 * 2. Media attached directly to the current .ai message
 *
 * @returns {Promise<
 *   | {type:"text", text:string, quoted:boolean}
 *   | {type:"image", buffer:Buffer, mimeType:string, fileName:string, sourceText:string, quoted:boolean}
 *   | {type:"pdf"|"document", buffer:Buffer, mimeType:string, fileName:string, sourceText:string, quoted:boolean}
 *   | null
 * >}
 */
function safeObjectKeys(value) {
    try {
        return value && typeof value === "object"
            ? Object.keys(value)
            : [];
    } catch (_) {
        return [];
    }
}

function logAiQuotedMediaDebug(msg, stage = "unknown") {
    try {
        const root = msg?.message;
        const context = getMessageContextInfo(root);
        const quoted = context?.quotedMessage;
        const quotedVideo = quoted
            ? findNestedMessageNode(quoted, "videoMessage")
            : null;
        const quotedImage = quoted
            ? findNestedMessageNode(quoted, "imageMessage")
            : null;
        const quotedDocument = quoted
            ? findNestedMessageNode(quoted, "documentMessage")
            : null;

        console.log("[AI DEBUG]", {
            stage,
            messageKeys: safeObjectKeys(root),
            hasContextInfo: Boolean(context),
            contextKeys: safeObjectKeys(context),
            hasQuotedMessage: Boolean(quoted),
            quotedKeys: safeObjectKeys(quoted),
            quotedHasVideo: Boolean(quotedVideo),
            quotedHasImage: Boolean(quotedImage),
            quotedHasDocument: Boolean(quotedDocument),
            quotedVideoMime: quotedVideo?.mimetype || null,
            quotedVideoSeconds: quotedVideo?.seconds || null,
            stanzaId: context?.stanzaId || null,
            participant: context?.participant || null
        });
    } catch (err) {
        console.error("[AI DEBUG] failed to inspect quoted media:", err.message);
    }
}

async function getAiSource(
    sock,
    msg
) {
    logAiQuotedMediaDebug(msg, "getAiSource:start");

    const context =
        getMessageContextInfo(
            msg.message
        );

    const quoted =
        context?.quotedMessage;

    const quotedInner =
        unwrapMessage(
            quoted
        );

    const quotedImage =
        quoted
            ? findNestedMessageNode(
                quoted,
                "imageMessage"
            )
            : null;

    const quotedDocument =
        quoted
            ? findNestedMessageNode(
                quoted,
                "documentMessage"
            )
            : null;

    const quotedVideo =
        quoted
            ? findNestedMessageNode(
                quoted,
                "videoMessage"
            )
            : null;

    if (quoted) {
        console.log("[AI DEBUG] getAiSource quoted media candidates:", {
            quotedImage: Boolean(quotedImage),
            quotedDocument: Boolean(quotedDocument),
            quotedVideo: Boolean(quotedVideo),
            quotedText: Boolean(messageText(quotedInner))
        });

        const sourceText =
            messageText(
                quotedInner
            );

        const fakeMsg = {
            key: {
                remoteJid:
                    msg.key.remoteJid,
                id:
                    context.stanzaId,
                participant:
                    context.participant,
                fromMe:
                    false
            },
            message:
                quotedInner
        };

        if (quotedImage) {
            console.log(
                "[AI SOURCE] Quoted image detected."
            );

            let buffer;

            try {
                buffer =
                    await downloadMediaNodeBuffer(
                        quotedImage,
                        "image"
                    );
            } catch (directErr) {
                console.warn(
                    "[AI SOURCE] Direct quoted image download failed; trying full-message fallback:",
                    directErr.message
                );

                buffer =
                    await downloadMessageBuffer(
                        fakeMsg
                    );
            }

            if (
                !Buffer.isBuffer(buffer) ||
                buffer.length === 0
            ) {
                throw new Error(
                    "Quoted image download returned an empty buffer."
                );
            }

            console.log(
                "[AI SOURCE] Quoted image downloaded:",
                buffer.length,
                "bytes"
            );

            return {
                type:
                    "image",
                buffer,
                mimeType:
                    quotedImage
                        .mimetype ||
                    "image/jpeg",
                fileName:
                    quotedImage
                        .fileName ||
                    "image",
                sourceText,
                quoted:
                    true
            };
        }

        if (quotedDocument) {
            const buffer =
                await downloadMediaNodeBuffer(
                    quotedDocument,
                    "document"
                );

            const mimeType =
                quotedDocument
                    .mimetype ||
                "application/octet-stream";

            const fileName =
                quotedDocument
                    .fileName ||
                "document";

            return {
                type:
                    mimeType.includes(
                        "pdf"
                    )
                        ? "pdf"
                        : "document",
                buffer,
                mimeType,
                fileName,
                sourceText,
                quoted:
                    true
            };
        }

        if (quotedVideo) {
            console.log("[AI DEBUG] getAiSource selected quoted VIDEO");

            return {
                type:
                    "video",
                mimeType:
                    quotedVideo.mimetype ||
                    "video/mp4",
                fileName:
                    quotedVideo.fileName ||
                    "video.mp4",
                sourceText,
                quoted:
                    true
            };
        }

        if (sourceText) {
            console.log("[AI DEBUG] getAiSource selected quoted TEXT");

            return {
                type:
                    "text",
                text:
                    sourceText,
                quoted:
                    true
            };
        }
    }

    const directInner =
        unwrapMessage(
            msg.message
        );

    const directImage =
        findNestedMessageNode(
            msg.message,
            "imageMessage"
        );

    const directDocument =
        findNestedMessageNode(
            msg.message,
            "documentMessage"
        );

    const directVideo =
        findNestedMessageNode(
            msg.message,
            "videoMessage"
        );

    if (directImage) {
        const buffer =
            await downloadMediaNodeBuffer(
                directImage,
                "image"
            );

        return {
            type:
                "image",
            buffer,
            mimeType:
                directImage
                    .mimetype ||
                "image/jpeg",
            fileName:
                directImage
                    .fileName ||
                "image",
            sourceText:
                "",
            quoted:
                false
        };
    }

    if (directDocument) {
        const buffer =
            await downloadMediaNodeBuffer(
                directDocument,
                "document"
            );

        const mimeType =
            directDocument
                .mimetype ||
            "application/octet-stream";

        const fileName =
            directDocument
                .fileName ||
            "document";

        return {
            type:
                mimeType.includes(
                    "pdf"
                )
                    ? "pdf"
                    : "document",
            buffer,
            mimeType,
            fileName,
            sourceText:
                "",
            quoted:
                false
        };
    }

    if (directVideo) {
        return {
            type:
                "video",
            mimeType:
                directVideo.mimetype ||
                "video/mp4",
            fileName:
                directVideo.fileName ||
                "video.mp4",
            sourceText:
                directVideo.caption ||
                "",
            quoted:
                false
        };
    }

    return null;
}

function chunkSourceText(
    value,
    size = 5000
) {
    const text =
        String(value || "")
            .trim();

    if (!text) return [];

    const chunks = [];

    for (
        let i = 0;
        i < text.length;
        i += size
    ) {
        chunks.push(
            text.slice(
                i,
                i + size
            )
        );
    }

    return chunks;
}

async function answerFromExtractedDocument(
    prompt,
    extractedText,
    fileName,
    progress
) {
    const chunks =
        chunkSourceText(
            extractedText,
            5000
        );

    if (!chunks.length) {
        throw new Error(
            "No readable document text was extracted."
        );
    }

    const partials = [];

    for (
        let i = 0;
        i < chunks.length;
        i++
    ) {
        if (progress) {
            await progress.update(
                `📄 Reading document... ${i + 1}/${chunks.length}`
            );
        }

        const result =
            await callAI(
                "Answer the user's question using only the supplied document excerpt. Preserve the document's terminology and do not fill unsupported gaps with outside knowledge.",
                [
                    {
                        role:
                            "user",
                        content:
`Document: ${fileName || "attached document"}

User's request:
${prompt}

Excerpt ${i + 1} of ${chunks.length}:
${chunks[i]}`
                    }
                ]
            );

        partials.push(
            result
        );
    }

    if (
        partials.length === 1
    ) {
        return partials[0];
    }

    return await callAI(
        "Combine the excerpt-level answers into one cohesive response. Use only what the document excerpts support. If the document does not support a requested point, say so.",
        [
            {
                role:
                    "user",
                content:
`User's request:
${prompt}

Document:
${fileName || "attached document"}

Partial findings:
${partials.join("\n\n---\n\n")}`
            }
        ]
    );
}

function isPureImageTextExtractionRequest(prompt) {
    const value =
        String(prompt || "")
            .trim()
            .toLowerCase();

    return /\b(ocr|extract(?: all)? text|copy(?: all)? text|transcribe(?: all)? text|read(?: all)? the text|what text is (?:in|on) (?:this|the) image)\b/i
        .test(value);
}

async function handleAnswer(
    sock,
    msg,
    chatId,
    prompt,
    media,
    progress,
    showThinking,
    profileId
) {

    if (media && media.type === "text") {

        if (showThinking) {
            await progress.update("🧠 Thinking...");
        }

        const conversation =
            getConversationMessages(
                profileId,
                8
            );

        const combinedPrompt =
            [
                "The user replied to this WhatsApp message:",
                "---",
                media.text,
                "---",
                "",
                "The user's current request:",
                prompt,
                "",
                "Treat the quoted message as the claim, statement, or context the user is referring to. Answer the user's current request normally using your own general knowledge, just as you would for any ordinary .ai question. If the user asks whether the quoted claim is true, assess it using your knowledge, explain what appears correct or incorrect, and mention uncertainty where appropriate. Do not assume the quoted claim is true merely because it was quoted. Only treat the quoted text as source-only evidence if the user explicitly asks you to answer strictly from that text."
            ].join("\n");

        const answer =
            await callAI(
                ZOREX_AI_SYSTEM_PROMPT,
                [
                    ...conversation,
                    {
                        role: "user",
                        content: combinedPrompt
                    }
                ]
            );

        await splitAndSend(
            sock,
            chatId,
            answer,
            msg
        );

        appendHistory(
            profileId,
            {
                type: "answer",
                user:
                    "Quoted: " +
                    media.text.slice(0, 1200) +
                    "\nQuestion: " +
                    prompt,
                assistant: answer
            }
        );

        return;
    }
    if (media && media.type === "image") {

        await progress.update("🖼️ Reviewing the image...");

        if (
            isPureImageTextExtractionRequest(
                prompt
            )
        ) {
            await progress.update(
                "🔤 Extracting image text..."
            );

            const extracted =
                await readDocument(
                    media.buffer,
                    {
                        mimeType:
                            media.mimeType,
                        fileName:
                            media.fileName ||
                            "image"
                    }
                );

            const output =
                "📝 *Extracted text*\n\n" +
                extracted.text;

            await splitAndSend(
                sock,
                chatId,
                output,
                msg
            );

            appendHistory(
                profileId,
                {
                    type:
                        "vision",
                    user:
                        prompt,
                    assistant:
                        output
                }
            );

            return;
        }

        if (showThinking) {
            await progress.update("🧠 Thinking...");
        }

        const imagePrompt =
            [
                media.sourceText
                    ? "Text/caption attached to the quoted image:\n" +
                        media.sourceText
                    : "",
                "User's request:\n" +
                    (
                        prompt ||
                        "Describe and analyze this image."
                    )
            ]
                .filter(Boolean)
                .join("\n\n");

        const answer = await callVision(
            ZOREX_AI_SYSTEM_PROMPT +
                "\n\nThe CURRENT attached/replied image is the primary subject of this request. Analyze that image directly and answer the user's request about it. Do not continue an older conversation topic unless the user explicitly asks you to connect it. Read visible text when relevant, but also use visual context, layout, diagrams, objects and relationships shown in the image.",
            imagePrompt,
            media.buffer,
            media.mimeType
        );
        await splitAndSend(sock, chatId, answer, msg);

        appendHistory(
            profileId,
            {
                type: "vision",
                user: prompt,
                assistant: answer
            }
        );

        return;
    }

    if (media && media.type === "document") {

        await progress.update(
            "📄 Extracting document text..."
        );

        const extracted =
            await readDocument(
                media.buffer,
                {
                    mimeType:
                        media.mimeType,
                    fileName:
                        media.fileName
                }
            );

        if (showThinking) {
            await progress.update(
                "🧠 Thinking..."
            );
        }

        const documentPrompt =
            media.sourceText
                ? (
                    "Quoted message/caption:\n" +
                    media.sourceText +
                    "\n\nUser's request:\n" +
                    prompt
                )
                : prompt;

        const answer =
            await answerFromExtractedDocument(
                documentPrompt,
                extracted.text,
                media.fileName,
                progress
            );

        await splitAndSend(
            sock,
            chatId,
            answer,
            msg
        );

        appendHistory(
            profileId,
            {
                type: "document",
                user:
                    (media.fileName || "document") +
                    ": " +
                    prompt,
                assistant:
                    answer
            }
        );

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

        appendHistory(
            profileId,
            {
                type: "document",
                user: prompt,
                assistant: merged
            }
        );

        return;

    }

    if (showThinking) {
        await progress.update("🧠 Thinking...");
    }

    const conversation =
        getConversationMessages(
            profileId,
            8
        );

    const answer = await callAI(
        ZOREX_AI_SYSTEM_PROMPT +
            "\n\nUse the recent conversation to resolve follow-up references such as 'it', 'that', 'the show', 'him', or 'her'. Treat earlier assistant answers as conversational context, not as guaranteed factual authority. The current user message has priority.",
        [
            ...conversation,
            {
                role: "user",
                content: prompt
            }
        ]
    );
    await splitAndSend(sock, chatId, answer, msg);

    appendHistory(
        profileId,
        {
            type: "answer",
            user: prompt,
            assistant: answer
        }
    );

}

async function handleGenerateFile(
    sock,
    msg,
    chatId,
    senderId,
    profileId,
    prompt,
    format,
    media,
    progress
) {

    const label = FORMAT_LABELS[format] || format;
    let sourceContext = "";
    const sourceImages = [];

    if (media && media.type === "text") {

        sourceContext =
            media.text;

    } else if (media && media.type === "document") {

        await progress.update(
            "📄 Reviewing the attached document..."
        );

        const extracted =
            await readDocument(
                media.buffer,
                {
                    mimeType:
                        media.mimeType,
                    fileName:
                        media.fileName
                }
            );

        sourceContext =
            extracted.text;

    } else if (media && media.type === "image") {

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

    setPending(
        chatId,
        senderId,
        {
            kind: "file",
            profileId,
            prompt,
            format,
            sourceContext,
            sourceImages
        }
    );

    await sock.sendMessage(chatId, {
        text: `📄 This looks like a request to generate a *${label}*.\n\nReply *.ai yes* to go ahead, or *.ai no* to cancel.`
    }, { quoted: msg });

}

async function handleConfirmedGeneration(sock, msg, chatId, pendingReq) {

    const {
        profileId,
        prompt,
        format,
        sourceContext,
        sourceImages
    } = pendingReq;
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

        appendHistory(
            profileId,
            {
                type: "file",
                user: prompt,
                assistant:
                    `${FORMAT_LABELS[format] || format} generated and sent.`
            }
        );

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

    const auth =
        await authorizeAiRequest(
            sock,
            msg,
            body
        );

    if (!auth.allowed) {
        return;
    }

    const profileId =
        auth.profileId;

    if (/^history(?:\s+\d+)?$/i.test(body)) {
        return await showAiHistory(
            sock,
            msg,
            profileId,
            body
        );
    }

    if (/^(yes|y)$/i.test(body)) {
        const pendingReq =
            getPending(
                chatId,
                senderId
            );

        if (!pendingReq) {
            return await sock.sendMessage(
                chatId,
                {
                    text:
                        "⚠️ I don't have a pending AI action for you to confirm."
                },
                {
                    quoted: msg
                }
            );
        }

        clearPending(
            chatId,
            senderId
        );

        if (
            pendingReq.kind ===
            "commands"
        ) {
            const confirmationProgress =
                await startProgress(
                    sock,
                    msg,
                    "⚙️ Executing approved Zorex actions..."
                );

            try {
                const result =
                    await executeAiCommandPlan(
                        sock,
                        msg,
                        pendingReq.registeredUserId ||
                            auth.registeredUserId,
                        pendingReq.commands
                    );

                appendHistory(
                    pendingReq.profileId ||
                        profileId,
                    {
                        type:
                            "command",
                        user:
                            pendingReq.prompt ||
                            body,
                        assistant:
                            "Executed approved Zorex actions:\n" +
                            result.summary
                    }
                );

                await confirmationProgress.succeed(
                    "✅ Approved actions complete"
                );

                return;
            } catch (err) {
                console.error(
                    "[.ai] confirmed command execution failed:",
                    err.message
                );

                await confirmationProgress.fail(
                    "❌ Action execution failed"
                );

                return await sock.sendMessage(
                    chatId,
                    {
                        text:
                            "⚠️ I couldn't complete those approved Zorex actions."
                    },
                    {
                        quoted: msg
                    }
                );
            }
        }

        return await handleConfirmedGeneration(
            sock,
            msg,
            chatId,
            pendingReq
        );
    }

    if (/^(no|n|cancel)$/i.test(body)) {
        const pendingReq =
            getPending(
                chatId,
                senderId
            );

        if (!pendingReq) {
            return await sock.sendMessage(
                chatId,
                {
                    text:
                        "⚠️ I don't have a pending AI action for you to cancel."
                },
                {
                    quoted: msg
                }
            );
        }

        clearPending(
            chatId,
            senderId
        );

        return await sock.sendMessage(
            chatId,
            {
                text:
                    pendingReq.kind === "commands"
                        ? "❌ Cancelled — no Zorex actions were executed."
                        : "❌ Cancelled — no file was created."
            },
            {
                quoted: msg
            }
        );
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
            media =
                await getAiSource(
                    sock,
                    msg
                );
        } catch (err) {
            console.error(
                "[.ai] failed to read attached/quoted source:",
                err.message
            );

            if (
                messageHasQuotedMedia(
                    msg.message
                )
            ) {
                await progress.fail(
                    "❌ Couldn't read the replied media"
                );

                return await sock.sendMessage(
                    chatId,
                    {
                        text:
                            "⚠️ I can see that you replied to an image/file, but WhatsApp wouldn't let me download it. Please resend the image normally, then reply with .ai explain this."
                    },
                    {
                        quoted:
                            msg
                    }
                );
            }

            media = null;
        }

        // Image analysis should never depend on the text router. Once an
        // image source is present, analyze it directly unless the user is
        // explicitly asking to generate/animate something from it.
        const explicitMediaGeneration =
            /\b(generate|create|make|draw|render|animate|turn|convert)\b[\s\S]*\b(image|picture|photo|video|animation)\b|\b(image|picture|photo|video)\b[\s\S]*\b(generate|create|make|animate|turn|convert)\b/i
                .test(body);

        if (
            media?.type === "image" &&
            !explicitMediaGeneration
        ) {
            const directThinking =
                requestNeedsThinking(
                    body,
                    media,
                    {
                        action:
                            "answer"
                    }
                );

            await handleAnswer(
                sock,
                msg,
                chatId,
                body,
                media,
                progress,
                directThinking,
                profileId
            );

            await progress.succeed(
                "✅ Response ready"
            );

            return;
        }

        console.log("[AI DEBUG] getAiSource result:", media
            ? {
                type: media.type,
                quoted: Boolean(media.quoted),
                mimeType: media.mimeType || null,
                hasBuffer: Buffer.isBuffer(media.buffer),
                bufferBytes: Buffer.isBuffer(media.buffer) ? media.buffer.length : 0,
                sourceTextLength: String(media.sourceText || media.text || "").length
            }
            : null
        );

        const mediaDescription =
            media?.type === "video"
                ? (
                    media.quoted
                        ? "the user replied to a video source"
                        : "a video source is attached"
                )
                : media
                    ? (
                        media.type === "text"
                            ? "the user replied to a text message"
                            : media.quoted
                                ? `the user replied to an ${media.type} source`
                                : `an ${media.type} source is attached`
                    )
                    : messageHasQuotedVideo(msg.message)
                        ? "the user replied to a video source"
                        : "nothing is attached";

        console.log("[AI DEBUG] router mediaDescription:", mediaDescription);
        console.log("[AI DEBUG] router prompt:", body);

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

        console.log("[AI DEBUG] router raw response:", routingRaw);

        const routing =
            safeParseJson(routingRaw);

        console.log("[AI DEBUG] router parsed response:", routing);

        const showThinking =
            requestNeedsThinking(
                body,
                media,
                routing
            );

        if (
            routing?.action ===
            "execute_commands"
        ) {
            const commands =
                bindCommandContext(
                    normalizeCommandPlan(
                        routing.commands
                    ),
                    msg
                );

            if (commands.length > 0) {
                const exposure =
                    calculateExposure(
                        commands,
                        auth.registeredUserId
                    );

                if (
                    requiresConfirmation(
                        commands,
                        auth.registeredUserId
                    )
                ) {
                    setPending(
                        chatId,
                        senderId,
                        {
                            kind:
                                "commands",
                            profileId,
                            registeredUserId:
                                auth.registeredUserId,
                            prompt:
                                body,
                            commands
                        }
                    );

                    await sock.sendMessage(
                        chatId,
                        {
                            text:
`⚠️ *Confirm Zorex AI actions*

${describePlan(
    commands,
    auth.registeredUserId
)}

This request exceeds the *5,000,000 🌙* confirmation threshold.

> Reply \`.ai yes\` to execute.
> Reply \`.ai no\` to cancel.`
                        },
                        {
                            quoted: msg
                        }
                    );

                    await progress.succeed(
                        "✅ Plan ready — awaiting confirmation"
                    );

                    return;
                }

                await progress.update(
                    exposure > 0
                        ? "🎮 Running Zorex actions..."
                        : "⚙️ Fetching Zorex data..."
                );

                const result =
                    await executeAiCommandPlan(
                        sock,
                        msg,
                        auth.registeredUserId,
                        commands
                    );

                appendHistory(
                    profileId,
                    {
                        type:
                            "command",
                        user:
                            body,
                        assistant:
                            "Executed Zorex actions:\n" +
                            result.summary
                    }
                );

                await progress.succeed(
                    "✅ Zorex actions complete"
                );

                return;
            }
        }

        if (
            routing?.action === "generate_image"
        ) {

            await progress.update(
                "🎨 Preparing image generation..."
            );

            await generateImageFromPrompt(
                sock,
                msg,
                body,
                {
                    progress,
                    source: "ai"
                }
            );

            appendHistory(
                profileId,
                {
                    type: "image",
                    user: body,
                    assistant:
                        "Image generation request completed."
                }
            );

            return;
        }

        if (
            routing?.action === "generate_video"
        ) {

            await progress.update(
                "🎬 Preparing video generation..."
            );

            await generateVideoFromPrompt(
                sock,
                msg,
                body,
                {
                    progress,
                    source: "ai"
                }
            );

            appendHistory(
                profileId,
                {
                    type: "video",
                    user: body,
                    assistant:
                        "Video generation request completed."
                }
            );

            return;
        }

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
                showThinking,
                profileId
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
            profileId,
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