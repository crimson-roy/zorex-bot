// commands/mem.js

const {
    getRelationship,
    getTier
} = require('../lib/relationshipStore');

const {
    CHLOE_SYSTEM_PROMPT
} = require('../lib/chloePersona');

const {
    callAI
} = require('../lib/textAIClient');


const BOT_DISPLAY_NAME = 'Chloe';


function buildMemPrompt(
    senderName,
    rel,
    tier
) {

    const observationsList =
        rel.observations.length
            ? rel.observations
                .map(o => `- ${o}`)
                .join('\n')
            : '- (nothing notable observed yet)';


    return `
You are writing Chloe's private internal reflection on one specific person,
${senderName}, for a ".mem" command.

This is Chloe's own head-space, not a message to them directly.

Current stats:
- Status: ${tier.label}
- Trust: ${rel.trust.toFixed(1)}/10
- Affection: ${rel.affection.toFixed(1)}/10
- Conversations so far: ${rel.conversations}

Real observations noted from actual exchanges with this person:
${observationsList}

Write in EXACTLY this structure:

[One line matching the emotional tone of the current trust/affection level]

* [one line about the state of the bond/trust itself]
* [one line referencing a REAL observation from the list above]
* [one line of character analysis of this specific person]
* [one closing personal remark]

Rules:

- If observations are empty, admit Chloe doesn't know them well enough yet.
- Do not invent memories or events.
- Keep every bullet short.
- Guarded and clipped when trust is low.
- Warmer, teasing or affectionate as trust rises.
- Match Chloe's established personality.
- Do NOT include the numerical stat block yourself.
- Do NOT use markdown code fences.
`.trim();

}


async function memCommand(
    sock,
    msg
) {

    const chatId =
        msg.key.remoteJid;

    const userId =
        msg.key.participant ||
        msg.key.remoteJid;

    const senderName =
        msg.pushName ||
        'this person';


    const rel =
        getRelationship(userId);

    const tier =
        getTier(rel.trust);


    const header =
`💭 ${BOT_DISPLAY_NAME}'s Thoughts on ${senderName}:
📊 Status: ${tier.label}
🤝 Trust: ${rel.trust.toFixed(1)}/10 (${Math.round(rel.trust * 10)}%)
💕 Affection: ${rel.affection.toFixed(1)}/10 (${Math.round(rel.affection * 10)}%)`;


    try {

        const reflection =
            await callAI(
                CHLOE_SYSTEM_PROMPT,
                [
                    {
                        role: 'user',
                        content:
                            buildMemPrompt(
                                senderName,
                                rel,
                                tier
                            )
                    }
                ]
            );


        await sock.sendMessage(
            chatId,
            {
                text:
                    `${header}\n\n${reflection}`
            },
            {
                quoted: msg
            }
        );


    } catch (err) {

        console.error(
            '[mem] Azure AI call failed:',
            err.message
        );


        await sock.sendMessage(
            chatId,
            {
                text:
                    `${header}\n\n(couldn't gather her thoughts just now — try again in a sec)`
            },
            {
                quoted: msg
            }
        );

    }

}


module.exports = {
    memCommand
};
