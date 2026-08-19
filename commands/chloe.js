// commands/chloe.js
//
// Chloe AI companion for Zorex.
//
// Called once for every incoming message.
// Chloe decides internally whether she should reply.
//
// Important:
// - Chloe never blocks the main command router.
// - AI history is deliberately capped to keep Groq token usage low.
// - Only one Chloe AI request may run per chat at a time.
// - The rest of Chloe's personality / relationship / sticker system
//   remains unchanged.

const fs = require("fs");

const { CHLOE_SYSTEM_PROMPT } =
    require("../lib/chloePersona");

const memory =
    require("../lib/chloeMemory");

const { callAI } =
    require("../lib/aiClient");

const { judgeExchange } =
    require("../lib/relationshipEngine");

const {
    recordExchange,
    getRelationship,
    getTier
} = require("../lib/relationshipStore");

const { pickSticker } =
    require("../lib/chloeStickers");

const { MAIN_OWNER } =
    require("../config");

// PERSISTENCE
const dataPath =
    require("../lib/dataPath");

const OWNERS_FILE =
    dataPath("owners.json");

const BOT_NAME = "chloe";


// ============================================================
// TOKEN / HISTORY LIMITS
// ============================================================
//
// These limits are deliberately conservative because Chloe's
// old version could send thousands of input tokens to Groq.
//
// 6 messages is enough for short-term conversational context.
// Individual messages are also truncated so one huge message
// cannot consume the entire request.
//

const MAX_HISTORY_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 700;


// ============================================================
// TIER-SPECIFIC BEHAVIOR
// ============================================================

const TIER_INSTRUCTIONS = {

    stranger:
        "RIGHT NOW: You just met this person, or barely know them. Be measured, " +
        "reserved, a little distant — you're watching them, not opening up. Do " +
        "NOT use emojis (none, or at most one plain one in a whole reply, and " +
        "only rarely). No teasing, no inside jokes, no calling them by cute " +
        "nicknames. Keep replies short and a bit guarded. You are testing " +
        "whether they'll treat you like a person or like a title — don't hand " +
        "out warmth for free.",

    acquaintance:
        "RIGHT NOW: You're starting to warm up to this person, but still " +
        "cautious. Emojis are rare — use one occasionally, not in every " +
        "message. You can ask a few more real questions about them, but keep " +
        "some distance. Still not playful yet.",

    friend:
        "RIGHT NOW: A real friendship has formed. You're comfortable and " +
        "starting to be playful and curious about them. Emojis show up " +
        "naturally now, a modest amount per message — not spammed. Light " +
        "teasing is fine.",

    bestfriend:
        "RIGHT NOW: This is one of your closest people. Be playful, teasing, " +
        "genuinely warm, and open — share little things about yourself " +
        "unprompted. Emojis flow freely and often here.",

    crush:
        "RIGHT NOW: There's something more here, unspoken. Be warm, a little " +
        "softer and more vulnerable than usual, still playful and teasing. " +
        "Emojis are frequent and expressive.",

    couple:
        "RIGHT NOW: This is your person. Full warmth, full affection, fully " +
        "yourself with them. Emojis are frequent and expressive."

};


// ============================================================
// MOOD TAG
// ============================================================

const MOOD_TAG_INSTRUCTION =
    "At the very end of your reply, on its own new line, add exactly: " +
    "[mood: X] where X is ONE of these exact words and no others: neutral, " +
    "happy, laughing, loving, pouty, angry, sad, shy, teasing, special — " +
    "whichever best matches your actual emotional tone in THIS reply. This " +
    "tag is stripped before the person sees your message, so it's just for " +
    "internal bookkeeping — always include it, every single reply, no " +
    "exceptions, and never use a mood word outside this list.";

const MOOD_TAG_REGEX =
    /\n?\[mood:\s*(\w+)\]\s*$/i;

const VALID_MOODS = new Set([
    "neutral",
    "happy",
    "laughing",
    "loving",
    "pouty",
    "angry",
    "sad",
    "shy",
    "teasing",
    "special"
]);


// ============================================================
// AI REQUEST LOCK
// ============================================================
//
// Prevent multiple Chloe requests from running at the same
// time in one chat.
//
// This is especially useful now that index.js calls Chloe
// without `await`, because several messages can arrive while
// an earlier AI request is still processing.
//

const AI_IN_FLIGHT = new Set();


// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(userId) {

    const rel =
        getRelationship(userId);

    const tier =
        getTier(rel.trust);

    const tierInstructions =
        TIER_INSTRUCTIONS[tier.key] ||
        TIER_INSTRUCTIONS.stranger;

    return (
        `${CHLOE_SYSTEM_PROMPT}\n\n` +
        `${tierInstructions}\n\n` +
        `${MOOD_TAG_INSTRUCTION}`
    );

}


// ============================================================
// BOT JID TRACKING
// ============================================================
//
// WhatsApp's LID system means Chloe can be referenced by more
// than one JID format.
//

let BOT_JIDS =
    process.env.BOT_JID
        ? [process.env.BOT_JID]
        : [];


function setBotJid(jids) {

    BOT_JIDS =
        (
            Array.isArray(jids)
                ? jids
                : [jids]
        )
        .filter(Boolean);

}


// ============================================================
// OWNER CHECK
// ============================================================

function isOwner(userId) {

    if (userId === MAIN_OWNER) {
        return true;
    }

    try {

        const owners =
            JSON.parse(
                fs.readFileSync(
                    OWNERS_FILE,
                    "utf8"
                )
            );

        return owners.includes(userId);

    } catch (err) {

        return false;

    }

}


// ============================================================
// MESSAGE HELPERS
// ============================================================

function extractText(msg) {

    const m =
        msg.message || {};

    return (
        m.conversation ||
        (
            m.extendedTextMessage &&
            m.extendedTextMessage.text
        ) ||
        (
            m.imageMessage &&
            m.imageMessage.caption
        ) ||
        ""
    );

}


function getContextInfo(msg) {

    const m =
        msg.message || {};

    return (
        m.extendedTextMessage &&
        m.extendedTextMessage.contextInfo
    ) || {};

}


function isNameMentioned(text) {

    return new RegExp(
        `\\b${BOT_NAME}\\b`,
        "i"
    ).test(text);

}


function isTagged(msg) {

    const ctx =
        getContextInfo(msg);

    const mentioned =
        ctx.mentionedJid || [];

    return mentioned.some(
        jid =>
            BOT_JIDS.includes(jid)
    );

}


function isReplyToBot(msg) {

    const ctx =
        getContextInfo(msg);

    return (
        !!ctx.quotedMessage &&
        BOT_JIDS.includes(
            ctx.participant
        )
    );

}


function isSummonCommand(text) {

    return (
        /^\.chaton\b/i.test(
            text.trim()
        ) ||
        /^\.chatoff\b/i.test(
            text.trim()
        )
    );

}


// ============================================================
// HISTORY COMPRESSION
// ============================================================
//
// Keep only recent messages and cap their size.
//
// This is the main token-usage fix.
//

function buildCompactHistory(
    chatId,
    userId
) {

    const history =
        memory.getHistory(
            chatId,
            userId
        ) || [];

    const recent =
        history.slice(
            -MAX_HISTORY_MESSAGES
        );

    return recent.map(h => {

        let content =
            String(
                h.content || ""
            );

        if (
            content.length >
            MAX_MESSAGE_CHARS
        ) {

            content =
                content.slice(
                    0,
                    MAX_MESSAGE_CHARS
                ) +
                "…";

        }

        return {

            role:
                h.role === "assistant"
                    ? "assistant"
                    : "user",

            content:
                h.senderName &&
                h.role === "user"
                    ? `${h.senderName}: ${content}`
                    : content

        };

    });

}


// ============================================================
// SAFE AI CALL
// ============================================================
//
// If a request is already running in this chat, we don't start
// another one. This prevents several large requests from being
// fired simultaneously and making the rate-limit problem worse.
//

async function runAIForChat(
    chatId,
    userId,
    systemPrompt
) {

    if (
        AI_IN_FLIGHT.has(chatId)
    ) {

        return null;

    }

    AI_IN_FLIGHT.add(chatId);

    try {

        const messagesForAI =
            buildCompactHistory(
                chatId,
                userId
            );

        const reply =
            await callAI(
                systemPrompt,
                messagesForAI
            );

        return reply;

    } finally {

        AI_IN_FLIGHT.delete(
            chatId
        );

    }

}


// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================

async function handleMessage(
    sock,
    msg
) {

    if (
        !msg.message ||
        msg.key.fromMe
    ) {

        return;

    }

    const chatId =
        msg.key.remoteJid;

    const text =
        extractText(msg).trim();

    const senderName =
        msg.pushName ||
        "Someone";

    const userId =
        msg.key.participant ||
        msg.key.remoteJid;


    if (!text) {
        return;
    }


    // --------------------------------------------------------
    // Ignore every non-Chloe command.
    // --------------------------------------------------------

    if (
        /^\./.test(text) &&
        !/^\.(chaton|chatoff|chloe)\b/i.test(text)
    ) {

        return;

    }


    // --------------------------------------------------------
    // CHATON
    // --------------------------------------------------------

    if (
        /^\.chaton\b/i.test(text)
    ) {

        if (
            !isOwner(userId)
        ) {

            await sock.sendMessage(
                chatId,
                {
                    text:
                        "❌ Only my owners can do that."
                },
                {
                    quoted: msg
                }
            );

            return;

        }

        memory.setActive(
            chatId,
            true
        );

        await sock.sendMessage(
            chatId,
            {
                text:
                    "hey, I'm here 🙂"
            }
        );

        return;

    }


    // --------------------------------------------------------
    // CHATOFF
    // --------------------------------------------------------

    if (
        /^\.chatoff\b/i.test(text)
    ) {

        if (
            !isOwner(userId)
        ) {

            await sock.sendMessage(
                chatId,
                {
                    text:
                        "❌ Only my owners can do that."
                },
                {
                    quoted: msg
                }
            );

            return;

        }

        memory.setActive(
            chatId,
            false
        );

        await sock.sendMessage(
            chatId,
            {
                text:
                    "okay, going quiet. ping me anytime."
            }
        );

        return;

    }


    const active =
        memory.isActive(chatId);


    console.log(
        "[CHLOE] Active:",
        active
    );

    console.log(
        "[CHLOE] BOT_JIDS:",
        BOT_JIDS
    );

    console.log(
        "[CHLOE] Text:",
        text
    );


    // --------------------------------------------------------
    // EXPLICIT .chloe
    // --------------------------------------------------------

    const summonMatch =
        text.match(
            /^\.chloe\s+([\s\S]+)/i
        );

    const isExplicitSummon =
        !!summonMatch;


    let shouldReply =
        false;

    let effectiveText =
        text;


    if (
        isExplicitSummon
    ) {

        shouldReply = true;

        effectiveText =
            summonMatch[1].trim();

    } else if (
        active
    ) {

        const byName =
            isNameMentioned(text);

        const byTag =
            isTagged(msg);

        const byReply =
            isReplyToBot(msg);


        console.log(
            "[CHLOE] Name:",
            byName
        );

        console.log(
            "[CHLOE] Tag:",
            byTag
        );

        console.log(
            "[CHLOE] Reply:",
            byReply
        );


        shouldReply =
            byName ||
            byTag ||
            byReply;

    }


    // --------------------------------------------------------
    // NOT A CHLOE MESSAGE
    // --------------------------------------------------------

    if (
        !shouldReply
    ) {

        if (
            active
        ) {

            memory.appendMessage(
                chatId,
                userId,
                "user",
                text,
                senderName
            );

        }

        return;

    }


    // --------------------------------------------------------
    // STORE USER MESSAGE
    // --------------------------------------------------------

    memory.appendMessage(
        chatId,
        userId,
        "user",
        effectiveText,
        senderName
    );


    // --------------------------------------------------------
    // CALL AI
    // --------------------------------------------------------

    try {

        const systemPrompt =
            buildSystemPrompt(
                userId
            );


        const rawReply =
            await runAIForChat(
                chatId,
                userId,
                systemPrompt
            );


        // Another Chloe request is already running.
        // Don't send a second AI response.
        if (
            rawReply === null
        ) {

            return;

        }


        const moodMatch =
            String(rawReply)
                .match(
                    MOOD_TAG_REGEX
                );

        const rawMood =
            moodMatch
                ? moodMatch[1].toLowerCase()
                : "neutral";

        const mood =
            VALID_MOODS.has(
                rawMood
            )
                ? rawMood
                : "neutral";


        const reply =
            String(rawReply)
                .replace(
                    MOOD_TAG_REGEX,
                    ""
                )
                .trim();


        if (
            !reply
        ) {

            return;

        }


        // ----------------------------------------------------
        // STORE CHLOE RESPONSE
        // ----------------------------------------------------

        memory.appendMessage(
            chatId,
            userId,
            "assistant",
            reply,
            null
        );


        // ----------------------------------------------------
        // SEND TEXT RESPONSE
        // ----------------------------------------------------

        await sock.sendMessage(
            chatId,
            {
                text: reply
            },
            {
                quoted: msg
            }
        );


        // ----------------------------------------------------
        // STICKER
        // ----------------------------------------------------

        try {

            const rel =
                getRelationship(
                    userId
                );

            const tier =
                getTier(
                    rel.trust
                );

            const stickerPath =
                pickSticker(
                    tier.key,
                    mood
                );

            if (
                stickerPath
            ) {

                await sock.sendMessage(
                    chatId,
                    {
                        sticker:
                            fs.readFileSync(
                                stickerPath
                            )
                    }
                );

            }

        } catch (err) {

            console.error(
                "[chloe] sticker send failed:",
                err.message
            );

        }


        // ----------------------------------------------------
        // RELATIONSHIP UPDATE
        // ----------------------------------------------------

        judgeExchange(
            senderName,
            effectiveText,
            reply
        )
            .then(
                delta =>
                    recordExchange(
                        userId,
                        delta
                    )
            )
            .catch(
                err =>
                    console.error(
                        "[chloe] relationship update failed:",
                        err.message
                    )
            );


    } catch (err) {

        console.error(
            "[chloe] AI call failed:",
            err.message
        );


        // Specific handling for Groq rate limits.
        if (
            String(err.message)
                .includes("429")
        ) {

            await sock.sendMessage(
                chatId,
                {
                    text:
                        "😵‍💫 My AI brain is being rate-limited right now. Give me a moment and try again."
                },
                {
                    quoted: msg
                }
            );

            return;

        }


        await sock.sendMessage(
            chatId,
            {
                text:
                    "ugh, my head just went blank — try again in a sec?"
            },
            {
                quoted: msg
            }
        );

    }

}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    handleMessage,
    setBotJid
};