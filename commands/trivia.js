const fs = require("fs");
const dataPath = require("../lib/dataPath");
const { QUESTIONS, CATEGORY_ALIASES } = require("../data/triviaQuestions");

// PERSISTENCE FIX: routed through dataPath() for consistency with the rest
// of the codebase. Lower stakes than most of the others here — a round is
// only 30s long and isStale() already recovers gracefully if the bot
// restarts mid-round — but there's no reason for it to be the one file
// still writing to the ephemeral disk.
const TRIVIA_FILE = dataPath("trivia.json");
const ROUND_TIME_MS = 30000; // 30 seconds per round, per the spec

// setTimeout handles can't survive a process restart or be stored in JSON,
// so they live in memory only. See isStale() below for how we recover if
// the bot restarts mid-round and this map is lost.
const activeTimers = new Map();

function loadTrivia() {
    if (!fs.existsSync(TRIVIA_FILE)) fs.writeFileSync(TRIVIA_FILE, "{}");
    return JSON.parse(fs.readFileSync(TRIVIA_FILE, "utf8"));
}

function saveTrivia(data) {
    fs.writeFileSync(TRIVIA_FILE, JSON.stringify(data, null, 4));
}

// If the bot restarted mid-round, the in-memory timer that would have
// ended it is gone, but the "active" flag in trivia.json would otherwise
// live forever and permanently block .trivia in that chat. Anything older
// than the round length plus a grace window is treated as abandoned.
function isStale(game) {
    return Date.now() - game.startedAt > ROUND_TIME_MS + 5000;
}

function pickQuestion(categoryFilter) {

    if (!categoryFilter) {
        return QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
    }

    const canonical = CATEGORY_ALIASES[categoryFilter.toLowerCase().trim()];

    const pool = canonical
        ? QUESTIONS.filter(q => q.category === canonical)
        : [];

    if (pool.length === 0) {
        // Unknown/empty category — fall back to a fully random question
        // rather than erroring out on the user.
        return {
            question: QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)],
            unknownCategory: true
        };
    }

    return { question: pool[Math.floor(Math.random() * pool.length)] };
}

function formatQuestion(game) {

    return `🧠 *ZOREX TRIVIA*

Category: ${game.category}

${game.question}

A. ${game.options[0]}
B. ${game.options[1]}
C. ${game.options[2]}
D. ${game.options[3]}

Reply with A, B, C, or D.
⏳ Time Remaining: 30 seconds.`;

}

// ---------- .trivia [category] ----------
async function triviaCommand(sock, msg, text) {

    const chatId = msg.key.remoteJid;
    const trivia = loadTrivia();
    const existing = trivia[chatId];

    if (existing && existing.status === "active" && !isStale(existing)) {

        return await sock.sendMessage(chatId, {
            text: `⚠️ A trivia round is already running in this chat.\n\nAnswer with A, B, C, or D to join in.`
        }, { quoted: msg });

    }

    const categoryArg = text.split(" ").slice(1).join(" ").trim();

    let picked;
    let unknownCategory = false;

    if (categoryArg) {

        const result = pickQuestion(categoryArg);

        if (result.unknownCategory) {
            picked = result.question;
            unknownCategory = true;
        } else {
            picked = result.question;
        }

    } else {

        picked = pickQuestion(null);

    }

    const game = {
        status: "active",
        category: picked.category,
        question: picked.question,
        options: picked.options,
        answer: picked.answer,
        startedAt: Date.now()
    };

    trivia[chatId] = game;
    saveTrivia(trivia);

    const prefix = unknownCategory
        ? `⚠️ Didn't recognize that category — picking a random question instead.\n\n`
        : "";

    await sock.sendMessage(chatId, {
        text: prefix + formatQuestion(game)
    }, { quoted: msg });

    const timer = setTimeout(async () => {
        await endRound(sock, chatId, null);
    }, ROUND_TIME_MS);

    activeTimers.set(chatId, timer);

}

// ---------- Ends the round, with or without a winner ----------
async function endRound(sock, chatId, winnerId) {

    const trivia = loadTrivia();
    const game = trivia[chatId];

    if (!game || game.status !== "active") return;

    const existingTimer = activeTimers.get(chatId);
    if (existingTimer) {
        clearTimeout(existingTimer);
        activeTimers.delete(chatId);
    }

    delete trivia[chatId];
    saveTrivia(trivia);

    const correctText = `${game.answer}. ${game.options["ABCD".indexOf(game.answer)]}`;

    if (winnerId) {

        await sock.sendMessage(chatId, {
            text: `🎉 *Correct!*\n\n@${winnerId.split("@")[0]} got it right!\n\n✅ The answer was ${correctText}`,
            mentions: [winnerId]
        });

    } else {

        await sock.sendMessage(chatId, {
            text: `⌛ *Time's up!*\n\nNobody answered correctly.\n\n✅ The answer was ${correctText}`
        });

    }

}

// ---------- Fed every incoming message so bare A/B/C/D replies work ----------
// No-op (and cheap) if there's no active round in this chat.
async function triviaAnswer(sock, msg, text) {

    const chatId = msg.key.remoteJid;
    const trivia = loadTrivia();
    const game = trivia[chatId];

    if (!game || game.status !== "active") return;

    if (isStale(game)) {
        delete trivia[chatId];
        saveTrivia(trivia);
        return;
    }

    const guess = text.trim().toUpperCase().replace(/\.$/, "");

    if (!["A", "B", "C", "D"].includes(guess)) return;

    const userId = msg.key.participant || msg.key.remoteJid;

    if (guess === game.answer) {

        await endRound(sock, chatId, userId);

    } else {

        // Wrong answer — react instead of sending a new message, so a busy
        // round doesn't spam the chat with "wrong!" texts.
        try {
            await sock.sendMessage(chatId, {
                react: { text: "❌", key: msg.key }
            });
        } catch (err) {
            // Reactions aren't critical — ignore failures silently.
        }

    }

}

module.exports = {
    triviaCommand,
    triviaAnswer
};