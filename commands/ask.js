"use strict";

const { callAI } = require("../lib/textAIClient");
const { startProgress } = require("../lib/progressIndicator");
const { buildKnowledgeContext } = require("../lib/commandRegistry");
const { buildAskSystemPrompt } = require("../lib/zorexPersona");

const MAX_MESSAGE_CHARS = 3500;

async function splitAndSend(sock, chatId, value, quoted) {
    const text = String(value || "").trim();

    for (let i = 0; i < text.length; i += MAX_MESSAGE_CHARS) {
        const piece =
            text.slice(
                i,
                i + MAX_MESSAGE_CHARS
            );

        await sock.sendMessage(
            chatId,
            { text: piece },
            i === 0
                ? { quoted }
                : undefined
        );
    }
}

async function askCommand(sock, msg, text) {
    const chatId =
        msg.key.remoteJid;

    const question =
        String(text || "")
            .replace(/^\.ask\b/i, "")
            .trim();

    if (!question) {
        return await sock.sendMessage(
            chatId,
            {
                text:
`🤖 *Zorex Ask*

Ask me how Zorex works.

> \`.ask how do I register?\`
> \`.ask what does .companyupgrade do?\`
> \`.ask explain the company system\`
> \`.ask what is Racing Life?\``
            },
            {
                quoted: msg
            }
        );
    }

    const progress =
        await startProgress(
            sock,
            msg,
            "🔎 Checking Zorex knowledge..."
        );

    try {
        const {
            context,
            hasSpecificKnowledge
        } =
            buildKnowledgeContext(
                question
            );

        if (!hasSpecificKnowledge) {
            await progress.succeed(
                "✅ Checked Zorex knowledge"
            );

            return await sock.sendMessage(
                chatId,
                {
                    text:
`🤖 I couldn't find reliable public Zorex documentation for that yet.

> Try asking about a specific command, a command category, or Racing Life.

I won't invent missing bot rules just to produce an answer.`
                },
                {
                    quoted: msg
                }
            );
        }

        await progress.update(
            "🧠 Preparing answer..."
        );

        const answer =
            await callAI(
                buildAskSystemPrompt(
                    context
                ),
                [
                    {
                        role: "user",
                        content: question
                    }
                ]
            );

        await splitAndSend(
            sock,
            chatId,
            answer,
            msg
        );

        await progress.succeed(
            "✅ Answer ready"
        );

    } catch (err) {
        console.error(
            "[.ask] failed:",
            err.message
        );

        await progress.fail(
            "❌ Ask failed"
        );

        return await sock.sendMessage(
            chatId,
            {
                text:
                    "⚠️ I couldn't check Zorex knowledge right now."
            },
            {
                quoted: msg
            }
        );
    }
}

module.exports = {
    askCommand
};
