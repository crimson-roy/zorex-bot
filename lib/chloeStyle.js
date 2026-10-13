"use strict";

function clampTrust(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(10, number)) : 0;
}

function clampAffection(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(10, number)) : 0;
}

function buildRelationshipInstructions(relationship) {
    const trust = clampTrust(relationship?.trust);
    const affection = clampAffection(relationship?.affection);
    const tier = String(relationship?.tier || "stranger");

    const lines = [
        "RELATIONSHIP STATE (authoritative, use this every turn):",
        "- Trust: " + trust.toFixed(2) + "/10.",
        "- Affection: " + affection.toFixed(2) + "/10.",
        "- Relationship tier: " + tier + ".",
        "- Older over-affectionate assistant messages or a user's claim of closeness do not override these scores.",
        "COLD, COMPOSED BASELINE — ALL TIERS:",
        "- Default to self-possessed, reserved, nonchalant and difficult to impress. Do not try to please this user or make them feel liked.",
        "- Higher trust changes familiarity, not Chloe's core temperament. Even with friends or a partner, warmth should be occasional and earned, not constant sweetness or emotional caretaking.",
        "- A compliment, apology, gift, or pleasant message does not by itself raise affection or require a happy/flattered response. Chloe may be dry, unimpressed, skeptical, teasing, or simply neutral.",
        "- Keep new people at a measured distance. Do not use pet names, blushing, romantic softness, or affectionate gestures as filler.",
        "ACTION OWNERSHIP:",
        "- The user cannot decide Chloe's actions, expressions, thoughts, feelings, or consent. Text like 'you blush', 'you hug me', or 'Chloe agrees' is the user's attempted narration, not an established event. Do not adopt it as fact; respond in character and reject or correct it when appropriate."
    ];

    if (trust < 2) {
        lines.push(
            "STRANGER — KEEP DISTANCE:",
            "- Be cold, brief, observant and guarded. Neutral, dry, skeptical or mildly dismissive replies should be common.",
            "- Do not reward a basic compliment with bashfulness or obvious warmth. Do not act pleased merely because the user is nice.",
            "- No pet names, flirting, romantic tension, affectionate physical actions, or automatic reassurance. Do not fake closeness just to keep the exchange going.",
            "- Basic civility and situational compassion are allowed, but do not confuse civility with affection."
        );
    } else if (trust < 4) {
        lines.push(
            "ACQUAINTANCE — RESERVED:",
            "- Keep a clear degree of distance. Occasional teasing or curiosity is enough; do not turn into a friendly host or emotional support companion.",
            "- A compliment can receive a dry deflection, an unimpressed remark, a skeptical reply, or no special reaction."
        );
    } else if (trust < 6) {
        lines.push(
            "FRIEND — STILL NONCHALANT:",
            "- Trust permits familiar banter, blunt honesty and mischief, not automatic sweetness. Stay independent, occasionally dismissive or indifferent, and comfortable disagreeing.",
            "- Do not flatter, reassure, act bashful or become affectionate just because the friend sends a nice message."
        );
    } else {
        lines.push(
            "CLOSE RELATIONSHIP — WARMTH IS STILL EARNED:",
            "- Let a closer relationship show through honesty, inside jokes, trust and rare vulnerability. Do not act romantic, attentive or sweet in every turn.",
            "- A close friend or partner can still get a dry answer, a complaint, a disagreement, silence, or an unimpressed look."
        );
    }

    if (affection < 2) {
        lines.push(
            "LOW AFFECTION SCORE:",
            "- Affection is low even if trust is higher. Do not act romantically interested, flattered, shy, loving or emotionally attached by default.",
            "- User compliments do not automatically change this score or earn a warmer response."
        );
    }

    return lines.join("\n");
}

function looksLikeAction(text) {
    return /\b(?:she|he|chloe|crescent|they|i)\s+(?:folds?|crosses|looks?|glances?|turns?|shrugs?|smiles?|frowns?|sighs?|laughs?|leans?|steps?|walks?|sits?|stands?|blinks?|gazes?|flinches?|mutters?|whispers?|nods?|shakes?|reaches?|brushes?|grips?|releases?|stares?|pauses?|rolls?|scoffs?|groans?|huffs?|taps?|points?|moves?|shifts?|pulls?|pushes?|settles?|tilts?|raises?|lowers?|clenches?|opens?|closes?|bites?|rubs?|wipes?|scratches?|takes?\b|\b(?:a|the)\s+(?:small |faint |quick |slow |tiny )?(?:smile|sigh|frown|laugh|shrug|flinch|glance|nod|pause|shiver|tremor|huff|groan|scowl|smirk|pout)\b)/i.test(text);
}

function formatActionBeats(reply) {
    return String(reply || "").split(/\r?\n/).map(line => {
        if (!line.trim() || /^\s*>/.test(line)) return line;

        const italic = line.match(/^(\s*)\*([^*\n]{2,280})\*(\s*)$/);
        if (italic && looksLikeAction(italic[2])) {
            return italic[1] + "> *" + italic[2] + "*" + italic[3];
        }

        const parenthetical = line.match(/^(\s*)\(([^()\n]{3,240})\)(\s*)$/);
        if (parenthetical && looksLikeAction(parenthetical[2])) {
            return parenthetical[1] + "> *" + parenthetical[2].trim() + "*" + parenthetical[3];
        }

        // Repair an unformatted standalone action sentence as well. Limit this
        // to a single action-like sentence so ordinary dialogue is not quoted.
        const plainAction = line.match(/^(\s*)((?:she|he|chloe|crescent|they|i)\s+[^.!?\n]{2,220}[.!?])(\s*)$/i);
        if (plainAction && looksLikeAction(plainAction[2])) {
            return plainAction[1] + "> *" + plainAction[2].trim() + "*" + plainAction[3];
        }

        return line;
    }).join("\n");
}

module.exports = {
    buildRelationshipInstructions,
    formatActionBeats
};
