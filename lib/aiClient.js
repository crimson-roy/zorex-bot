// aiClient.js
// Uses Groq's free API (OpenAI-compatible format). Get a free key with no
// credit card at https://console.groq.com/keys
//
// Swap the guts of callAI() here if you switch providers later — nothing
// else in the codebase needs to change as long as this still returns a
// plain string.
//
// Expects env vars: AI_API_KEY, and optionally AI_MODEL.

const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-oss-120b';

/**
 * @param {string} systemPrompt - Chloe's persona prompt
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages - recent turns
 * @returns {Promise<string>} Chloe's reply text
 */
async function callAI(systemPrompt, messages) {
  if (!AI_API_KEY) {
    throw new Error('AI_API_KEY is not set. Add it to your .env file.');
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature: 0.8,
      max_tokens: 800,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`AI API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;

  return text ? text.trim() : "...";
}

module.exports = { callAI };