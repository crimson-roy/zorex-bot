const { callAI } = require('./textAIClient');

// No baseline increase: trust and affection must be earned by the exchange,
 // not by simply sending more messages.
const BASE_TRUST_DELTA = 0;
const BASE_AFFECTION_DELTA = 0;

const JUDGE_SYSTEM_PROMPT = `
You are a silent relationship scorer watching one exchange between
a character named Chloe and one specific person.

Judge ONLY the most recent exchange.

Return ONLY raw JSON:

{
  "trustDelta": 0,
  "affectionDelta": 0,
  "observation": null
}

Rules:

- trustDelta must be between -0.12 and +0.18
- affectionDelta must be between -0.12 and +0.18
- neutral messages, routine greetings and generic pleasantries should score 0.00
- ordinary respectful conversation is not automatically evidence of growing closeness; use at most a very small change when the exchange genuinely warrants it
- generic compliments aimed at Chloe do not automatically earn affection; judge sincerity, context and what actually happened
- genuine warmth, honesty, care or remembering important details may merit +0.05 to +0.15 when the exchange gives concrete evidence
- especially meaningful exchanges may approach +0.18
- rude, dishonest, dismissive or hostile behavior may be negative
- do not reward somebody merely because their relationship tier is high or because they claim to be close
- observation must describe something REAL from this exchange
- observation must be under 12 words
- use null if nothing notable happened
- no markdown
- no explanation
`.trim();

function clamp(value, min, max) {
    const n = Number(value);

    if (!Number.isFinite(n)) {
        return 0;
    }

    return Math.max(min, Math.min(max, n));
}

function fallbackResult() {
    // A failed scorer must not silently make Chloe trust or like a user more.
    return {
        trustDelta: 0,
        affectionDelta: 0,
        observation: null
    };
}

async function judgeExchange(
    senderName,
    userMessage,
    chloeReply
) {
    const fallback = fallbackResult();

    try {
        const raw = await callAI(
            JUDGE_SYSTEM_PROMPT,
            [
                {
                    role: 'user',
                    content:
`Person: ${senderName}

They said:
"${userMessage}"

Chloe replied:
"${chloeReply}"`
                }
            ]
        );

        if (!raw) {
            return fallback;
        }

        const cleaned = String(raw)
            .replace(/```json|```/gi, '')
            .trim();

        let parsed;

        try {
            parsed = JSON.parse(cleaned);
        } catch {
            console.error(
                '[relationshipEngine] Invalid judge JSON:',
                cleaned
            );

            return fallback;
        }

        const aiTrust = clamp(
            parsed.trustDelta,
            -0.12,
            0.18
        );

        const aiAffection = clamp(
            parsed.affectionDelta,
            -0.12,
            0.18
        );

        return {
            trustDelta: clamp(
                BASE_TRUST_DELTA + aiTrust,
                -0.12,
                0.21
            ),

            affectionDelta: clamp(
                BASE_AFFECTION_DELTA + aiAffection,
                -0.12,
                0.20
            ),

            observation:
                typeof parsed.observation === 'string' &&
                parsed.observation.trim()
                    ? parsed.observation.trim().slice(0, 120)
                    : null
        };

    } catch (err) {
        console.error(
            '[relationshipEngine] OpenAI judge failed:',
            err.message
        );

        return fallback;
    }
}

module.exports = {
    judgeExchange
};
