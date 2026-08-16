// lib/geminiTextClient.js
//
// Gemini text-chat client for Chloe — drop-in replacement for
// aiClient.js's callAI(systemPrompt, messages) signature, so chloe.js
// only needs to change its import line, nothing else.
//
// Expects env vars: GEMINI_API_KEY (already set — same key visionClient.js
// uses), and optionally GEMINI_TEXT_MODEL.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.0-flash';

const GEMINI_ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/**
 * @param {string} systemPrompt
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages
 * @returns {Promise<string>}
 */
async function callAI(systemPrompt, messages) {

  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set. Add it to your .env file.');
  }

  // Gemini has no "assistant" role — it uses "model" instead.
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const response = await fetch(`${GEMINI_ENDPOINT(GEMINI_TEXT_MODEL)}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.8, maxOutputTokens: 800 },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();

  return text || '...';
}

module.exports = { callAI };