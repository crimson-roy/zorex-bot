// lib/visionClient.js
//
// Uses Gemini's REST API (the only genuinely multimodal key already in
// .env — GEMINI_API_KEY). Kept completely separate from lib/aiClient.js
// so Chloe's text-only setup is never touched by this.
//
// Same philosophy as aiClient.js: swap the guts of callVision() here if
// you switch vision providers later — callers just need a plain string
// back given a prompt + image buffer.
//
// Expects env vars: GEMINI_API_KEY, and optionally GEMINI_MODEL.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const GEMINI_ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/**
 * Sends a system prompt + user text + one image to Gemini and returns
 * the model's plain-text reply.
 *
 * @param {string} systemPrompt - persona/instruction prompt
 * @param {string} userText - the actual question/instruction for this call
 * @param {Buffer} imageBuffer - raw image bytes (PNG/JPEG)
 * @param {string} mimeType - e.g. "image/png", "image/jpeg"
 * @returns {Promise<string>}
 */
async function callVision(systemPrompt, userText, imageBuffer, mimeType) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set. Add it to your .env file.');
  }

  const base64Data = imageBuffer.toString('base64');

  const response = await fetch(
    `${GEMINI_ENDPOINT(GEMINI_MODEL)}?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mimeType, data: base64Data } },
              { text: userText },
            ],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();

  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();

  if (!text) {
    // Gemini returns no candidates at all for prompts it refuses (safety
    // filters, etc.) — surface that distinctly rather than returning "...".
    const blockReason = data.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(`Gemini declined to process this image (${blockReason})`);
    }
    return '...';
  }

  return text;
}

module.exports = { callVision };
