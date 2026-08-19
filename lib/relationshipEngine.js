// relationshipEngine.js
//
// After Chloe replies to someone, this evaluates the exchange and nudges
// trust/affection.
//
// IMPORTANT DESIGN:
// - Every genuine Chloe exchange gets a small baseline progression.
// - The AI judge can add to or subtract from that baseline.
// - If the AI judge fails/rate-limits, the baseline still applies.
// - Progress remains capped at 0..10 by relationshipStore.js.
//

const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL =
    process.env.AI_MODEL || "openai/gpt-oss-120b";


// ============================================================
// TUNING
// ============================================================
//
// Baseline progression prevents the relationship from completely
// freezing when the judge AI is unavailable.
//
// These are intentionally small because they apply to EVERY
// successful Chloe exchange.
//

const BASE_TRUST_DELTA = 0.03;
const BASE_AFFECTION_DELTA = 0.02;


// ============================================================
// AI JUDGE PROMPT
// ============================================================

const JUDGE_SYSTEM_PROMPT = `
You are a silent scorer watching a conversation between a character named
Chloe and one specific person.

Based ONLY on the most recent exchange, decide how this exchange should
affect Chloe's trust and affection toward that person.

The relationship is already given a small baseline increase by the code,
so your job is to decide whether this specific exchange deserves:

- no additional change
- a small positive adjustment
- a meaningful positive adjustment
- a small negative adjustment
- a meaningful negative adjustment

Rules:

1. trustDelta must be between -0.12 and +0.18.
2. affectionDelta must be between -0.12 and +0.18.

3. Ordinary friendly conversation:
   - usually around 0.00 to +0.04
   - do NOT reward every message heavily.

4. Genuine warmth, honesty, curiosity, vulnerability, remembering details,
   helping Chloe, asking about her as a person, or showing consistent care:
   - usually +0.05 to +0.15.

5. A particularly meaningful or emotionally important exchange:
   - may approach +0.18.

6. Rudeness, dishonesty, dismissiveness, manipulation, hostility, or ignoring
   Chloe repeatedly:
   - use negative values where appropriate.

7. Neutral messages should usually remain near zero rather than being forced
   positive or negative.

8. Do not punish someone simply for being brief.

9. Do not use the person's relationship tier as a reason to award points.
   Judge the actual exchange.

10. observation:
    ONE short phrase under 12 words describing a real behavioral detail
    from THIS exchange.
    Examples:
    "asked about Chloe's day unprompted"
    "kept the conversation focused on himself"
    "remembered something she mentioned earlier"

    Use null when nothing genuinely notable happened.

Respond with ONLY raw JSON:

{
  "trustDelta": <number>,
  "affectionDelta": <number>,
  "observation": <string or null>
}
`.trim();


// ============================================================
// HELPERS
// ============================================================

function clampDelta(value, min, max) {

    const number =
        Number(value);

    if (!Number.isFinite(number)) {
        return 0;
    }

    return Math.max(
        min,
        Math.min(
            max,
            number
        )
    );

}


// ============================================================
// FALLBACK
// ============================================================
//
// If Groq fails, the exchange still receives the baseline
// relationship progression.
//

function fallbackResult() {

    return {
        trustDelta:
            BASE_TRUST_DELTA,

        affectionDelta:
            BASE_AFFECTION_DELTA,

        observation:
            null
    };

}


// ============================================================
// MAIN JUDGE
// ============================================================

/**
 * @param {string} senderName
 * @param {string} userMessage
 * @param {string} chloeReply
 *
 * @returns {Promise<{
 *   trustDelta: number,
 *   affectionDelta: number,
 *   observation: string|null
 * }>}
 */

async function judgeExchange(
    senderName,
    userMessage,
    chloeReply
) {

    const fallback =
        fallbackResult();


    if (!AI_API_KEY) {
        return fallback;
    }


    try {

        const response =
            await fetch(
                "https://api.groq.com/openai/v1/chat/completions",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",

                        "Authorization":
                            `Bearer ${AI_API_KEY}`
                    },

                    body:
                        JSON.stringify({
                            model:
                                AI_MODEL,

                            max_tokens:
                                150,

                            temperature:
                                0.2,

                            messages: [

                                {
                                    role:
                                        "system",

                                    content:
                                        JUDGE_SYSTEM_PROMPT
                                },

                                {
                                    role:
                                        "user",

                                    content:
`Person: ${senderName}

They said:
"${userMessage}"

Chloe replied:
"${chloeReply}"`
                                }

                            ]
                        })
                }
            );


        // ----------------------------------------------------
        // AI FAILED / RATE LIMITED
        // ----------------------------------------------------

        if (!response.ok) {

            const errorText =
                await response
                    .text()
                    .catch(() => "");

            console.error(
                "[relationshipEngine] AI judge failed:",
                response.status,
                errorText
            );

            return fallback;

        }


        const data =
            await response.json();


        const text =
            data
                .choices?.[0]
                ?.message
                ?.content;


        if (!text) {
            return fallback;
        }


        // ----------------------------------------------------
        // CLEAN JSON
        // ----------------------------------------------------

        const cleaned =
            text
                .replace(
                    /```json|```/gi,
                    ""
                )
                .trim();


        let parsed;

        try {

            parsed =
                JSON.parse(
                    cleaned
                );

        } catch (err) {

            console.error(
                "[relationshipEngine] Invalid judge JSON:",
                cleaned
            );

            return fallback;

        }


        // ----------------------------------------------------
        // COMBINE BASELINE + AI ADJUSTMENT
        // ----------------------------------------------------

        const aiTrust =
            clampDelta(
                parsed.trustDelta,
                -0.12,
                0.18
            );

        const aiAffection =
            clampDelta(
                parsed.affectionDelta,
                -0.12,
                0.18
            );


        // Baseline is always earned simply by having
        // a genuine completed Chloe exchange.
        //
        // AI then modifies that result.

        const finalTrust =
            clampDelta(
                BASE_TRUST_DELTA +
                aiTrust,
                -0.12,
                0.21
            );

        const finalAffection =
            clampDelta(
                BASE_AFFECTION_DELTA +
                aiAffection,
                -0.12,
                0.20
            );


        return {

            trustDelta:
                finalTrust,

            affectionDelta:
                finalAffection,

            observation:
                typeof parsed.observation === "string" &&
                parsed.observation.trim()
                    ? parsed.observation.trim()
                    : null

        };


    } catch (err) {

        console.error(
            "[relationshipEngine] judge call failed:",
            err.message
        );

        return fallback;

    }

}


module.exports = {
    judgeExchange
};