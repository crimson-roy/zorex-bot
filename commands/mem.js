// commands/mem.js
const { getRelationship, getTier } = require('../lib/relationshipStore');
const { CHLOE_SYSTEM_PROMPT } = require('../lib/chloePersona');

const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';

const BOT_DISPLAY_NAME = 'Chloe';

function buildMemPrompt(senderName, rel, tier) {
  const observationsList = rel.observations.length
    ? rel.observations.map(o => `- ${o}`).join('\n')
    : '- (nothing notable observed yet)';

  return `
You are writing Chloe's private internal reflection on one specific person,
${senderName}, for a ".mem" command. This is Chloe's own head-space, not a
message to them directly.

Current stats:
- Status: ${tier.label}
- Trust: ${rel.trust.toFixed(1)}/10
- Affection: ${rel.affection.toFixed(1)}/10
- Conversations so far: ${rel.conversations}

Real observations noted from actual exchanges with this person:
${observationsList}

Write in EXACTLY this structure (no extra headers, no markdown fences):

[One line matching the emotional tone of the current trust/affection level —
guarded and clipped if trust is low, warmer/teasing if trust is high]
* [one line about the state of the bond/trust itself]
* [one line referencing a REAL observation from the list above — if the list
  is empty, note that she doesn't know them well enough yet to say]
* [one line of character analysis of this specific person]
* [one closing personal remark — dry/distant if trust is low, fond/teasing
  or intimate if trust is high]

Match Chloe's voice from her persona exactly. Keep each bullet to one short
line. Do not include the stat header block (status/trust/affection numbers)
— that's added separately, just write the reflection text itself.
`.trim();
}

async function memCommand(sock, msg) {
  const chatId = msg.key.remoteJid;
  const userId = msg.key.participant || msg.key.remoteJid;
  const senderName = msg.pushName || 'this person';

  const rel = getRelationship(userId);
  const tier = getTier(rel.trust);

  const header = `💭 ${BOT_DISPLAY_NAME}'s Thoughts on ${senderName}:
📊 Status: ${tier.label}
🤝 Trust: ${rel.trust.toFixed(1)}/10 (${Math.round(rel.trust * 10)}%)
💕 Affection: ${rel.affection.toFixed(1)}/10 (${Math.round(rel.affection * 10)}%)`;

  if (!AI_API_KEY) {
    await sock.sendMessage(
      chatId,
      { text: `${header}\n\n(AI_API_KEY not set — can't generate her reflection right now.)` },
      { quoted: msg }
    );
    return;
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 300,
        messages: [
          { role: 'system', content: CHLOE_SYSTEM_PROMPT },
          { role: 'user', content: buildMemPrompt(senderName, rel, tier) },
        ],
      }),
    });

    if (!response.ok) throw new Error(`AI API error ${response.status}`);

    const data = await response.json();
    const reflection = data.choices?.[0]?.message?.content?.trim() || '...';

    await sock.sendMessage(chatId, { text: `${header}\n${reflection}` }, { quoted: msg });
  } catch (err) {
    console.error('[mem] AI call failed:', err.message);
    await sock.sendMessage(
      chatId,
      { text: `${header}\n\n(couldn't gather her thoughts just now — try again in a sec)` },
      { quoted: msg }
    );
  }
}

module.exports = { memCommand };