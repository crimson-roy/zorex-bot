// commands/relation.js
const { getRelationship, getTier, getNextTierInfo } = require('../lib/relationshipStore');

const BOT_DISPLAY_NAME = 'Chloe';

async function relationCommand(sock, msg) {
  const chatId = msg.key.remoteJid;
  const userId = msg.key.participant || msg.key.remoteJid;

  const rel = getRelationship(userId);
  const tier = getTier(rel.trust);
  const next = getNextTierInfo(rel.trust);

  const nextLine = next
    ? `Next: ${next.label} at ${next.thresholdTrust} trust`
    : 'Next: max level reached';

  const text = `💞 *Relationship with ${BOT_DISPLAY_NAME}*
Status: ${tier.label} ${tier.emoji}
Trust: ${rel.trust.toFixed(2)}/10
Affection: ${rel.affection.toFixed(2)}/10
Description: ${tier.description}
Conversations: ${rel.conversations}
${nextLine}`;

  await sock.sendMessage(chatId, { text }, { quoted: msg });
}

module.exports = { relationCommand };