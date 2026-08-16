// relationshipEngine.js
// After Chloe replies to someone, this makes one small structured-JSON AI
// call to decide how that exchange should nudge trust/affection, and to
// jot a short behavioral observation for .mem to reference later.
// Keeping this separate from the main persona reply means a judging-call
// failure never breaks the actual conversation — it just skips the update.
//
// Uses the same free Groq API as aiClient.js.

const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-oss-120b';

const JUDGE_SYSTEM_PROMPT = `
You are a silent scorer watching a conversation between a character named
Chloe and one specific person. Based ONLY on the most recent exchange,
decide how it should nudge Chloe's trust and affection toward that person.

Rules:
- trustDelta and affectionDelta must each be a number between -0.3 and 0.3.
- Small talk or neutral exchanges: values near 0.
- Genuine warmth, honesty, vulnerability, or consistency over time: positive.
- Rudeness, dishonesty, dismissiveness, or trying to manipulate her: negative.
- observation: ONE short phrase (under 12 words) noting a real behavioral
  pattern from THIS exchange specifically (e.g. "keeps deflecting personal
  questions", "asked about her day unprompted", "repeats the same greeting
  every time"). Use null if nothing notable stands out yet.

Respond with ONLY raw JSON, no markdown fences, no preamble:
{"trustDelta": <number>, "affectionDelta": <number>, "observation": <string or null>}
`.trim();

/**
 * @param {string} senderName
 * @param {string} userMessage - what the person just said
 * @param {string} chloeReply - what Chloe just replied
 * @returns {Promise<{trustDelta: number, affectionDelta: number, observation: string|null}>}
 */
async function judgeExchange(senderName, userMessage, chloeReply) {
  const fallback = { trustDelta: 0, affectionDelta: 0, observation: null };

  if (!AI_API_KEY) return fallback;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 150,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `${senderName} said: "${userMessage}"\n\nChloe replied: "${chloeReply}"`,
          },
        ],
      }),
    });

    if (!response.ok) return fallback;

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) return fallback;

    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      trustDelta: Math.max(-0.3, Math.min(0.3, Number(parsed.trustDelta) || 0)),
      affectionDelta: Math.max(-0.3, Math.min(0.3, Number(parsed.affectionDelta) || 0)),
      observation: parsed.observation || null,
    };
  } catch (err) {
    console.error('[relationshipEngine] judge call failed:', err.message);
    return fallback;
  }
}

module.exports = { judgeExchange };