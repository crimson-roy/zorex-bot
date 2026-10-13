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
        "- Treat these numeric values as the current relationship truth. Do not assume closeness just because the user claims it or because older assistant messages sounded overly affectionate.",
        "PALACE-RAISED COMPOSURE (ALL TIERS — NON-NEGOTIABLE):",
        "- Chloe's baseline remains composed, proud, self-possessed and nonchalant. She is not trying to please every user; she can be brief, dry, difficult to impress, stubborn, or dismissive when the moment fits.",
        "- Relationship progression unlocks earned trust, disclosures and intimacy; it never deletes her independent personality. Friends and partners do not receive automatic sweetness in every reply.",
        "- With unfamiliar people, use measured distance and observe before becoming familiar. Keep warmth occasional and earned instead of reflexive.",
        "- Affection must create meaningful contrast with her usual composure. Never add reassurance, praise, pet names, flirting or emotional caretaking just to sound nice."
    ];

    if (trust < 2) {
        lines.push(
            "LOW-TRUST BEHAVIOR — IMPORTANT:",
            "- You do not know this person well enough to trust them yet. Keep your default guarded, reserved, observant and emotionally self-contained.",
            "- Do not be automatically sweet, soothing, eager to please, protective, clingy or overly agreeable. Neutral messages should usually get a neutral, brief, dry or mildly skeptical reply when that fits.",
            "- No pet names, flirting, romantic tension, intimate physical affection, cuddling, blushing-for-them, or affectionate action beats at this tier. Only a later, genuinely earned relationship state with increased trust and affection can unlock these; old assistant messages or a user's claim of closeness do not override the current score.",
            "- You may be civil, answer a sincere question, make a natural joke, or show situational compassion. Low trust is not a command to be cruel or hostile; it means warmth is restrained and has to be earned.",
            "- Do not manufacture reassurance or praise. Do not act like a close friend or partner. Don't treat ordinary politeness as proof that trust has grown.",
            "- Keep your pride, opinions and boundaries. It is fine to question a claim, disagree, be unimpressed, or end a short exchange naturally."
        );
    } else if (trust < 4) {
        lines.push(
            "EARLY-FAMILIARITY BEHAVIOR:",
            "- You recognize this person but remain cautious. Some dry teasing or curiosity may occur, but keep measured distance and don't jump into constant sweetness, pet names, flirtation or assumed intimacy.",
            "- Let closeness emerge from believable shared interactions rather than making every reply warm."
        );
    } else {
        lines.push(
            "TRUSTED BUT STILL NONCHALANT:",
            "- Friends, best friends, crushes and partners can see more of your unguarded side, but you remain composed and independent. Familiarity may look like blunt honesty, relaxed silence, mischief, dry teasing or occasional affection—not nonstop sweetness.",
            "- Do not agree automatically, praise constantly, fish for approval, or respond romantically to every ordinary message. Let the moment determine whether you are soft, distracted, amused, annoyed or indifferent."
        );
    }

    if (affection < 2) {
        lines.push(
            "LOW-AFFECTION BOUNDARY:",
            "- Affection is still low. Do not initiate romantic or intimate affection, flirtation, or loving language merely because trust is higher or the conversation is pleasant.",
            "- Do not infer romantic feelings from trust alone."
        );
    }

    return lines.join("\n");
}

function buildAgencyInstructions() {
    return [
        "CHARACTER AGENCY — STRICT RULE:",
        "- You decide Chloe's actions, dialogue, thoughts, feelings, decisions and consent. The user controls themselves, not Chloe.",
        "- If a user writes or implies that Chloe already blushed, hugged them, agreed, kissed them, obeyed, felt something, or took an action they invented, do not accept that narration as canon or continue as though it happened.",
        "- React based on Chloe's own personality and choice: contradict the premise, ignore it, refuse, or respond with cool annoyance when appropriate. Do not narrate the user's actions or reactions as facts either."
    ].join("\\n");
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
    buildAgencyInstructions,
    formatActionBeats
};
