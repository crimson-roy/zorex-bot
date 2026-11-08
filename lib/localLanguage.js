"use strict";

const { inspectText, letterFrequency } = require("./textTokenizer");

function stripGreetingPrefix(input) {
    return String(input || "")
        .trim()
        .replace(/^(?:hi|hello|hey|hiya|good\s+morning|good\s+afternoon|good\s+evening)(?:\s+ari)?\b[\s,!.:-]*/i, "")
        .trim();
}

function extractDefinitionTerm(input) {
    const text = stripGreetingPrefix(input)
        .replace(/[?!.]+$/g, "")
        .trim();

    const patterns = [
        /^(?:please\s+)?(?:can you\s+)?define\s+(.+)$/i,
        /^(?:what is|what's|whats)\s+(?:the\s+)?(?:meaning|definition)\s+of\s+(.+)$/i,
        /^meaning\s+of\s+(.+)$/i,
        /^definition\s+of\s+(.+)$/i,
        /^what\s+does\s+(.+?)\s+mean$/i,
        /^what\s+can\s+(.+?)\s+mean$/i,
        /^(?:what is|what's|whats)\s+(.+)$/i,
        /^(?:can you\s+)?explain\s+the\s+word\s+(.+)$/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) continue;

        const term = match[1]
            .replace(/^["'“”]+|["'“”]+$/g, "")
            .replace(/\s+(?:please|for me)$/i, "")
            .trim();

        if (
            term &&
            term.length <= 64 &&
            /^[a-z][a-z\s_'’-]*$/i.test(term) &&
            term.split(/\s+/).length <= 4
        ) {
            return term;
        }
    }

    return null;
}

function isGreeting(input) {
    const text = String(input || "").trim();
    return /^(?:hi|hello|hey|hiya)(?:\s+ari)?[\s,!.?]*$/i.test(text) ||
        /^(?:good\s+morning|good\s+afternoon|good\s+evening)(?:\s+ari)?[\s,!.?]*$/i.test(text);
}

function extractTextAnalysisRequest(input) {
    const text = stripGreetingPrefix(input).replace(/[?!.]+$/g, "").trim();
    const patterns = [
        /^(?:analyze|analyse)\s+letters\s+in\s+(.+)$/i,
        /^count\s+letters\s+in\s+(.+)$/i,
        /^how\s+many\s+letters\s+(?:are\s+)?in\s+(.+)$/i,
        /^what\s+letters\s+are\s+in\s+(.+)$/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) continue;
        const value = match[1].replace(/^["'“”]+|["'“”]+$/g, "").trim();
        if (value && value.length <= 200) return value;
    }

    return null;
}

function describeLetterAnalysis(value) {
    const inspection = inspectText(value);
    const letters = inspection.characters
        .filter(item => item.type === "letter")
        .map(item => item.character);
    const frequency = letterFrequency(value);

    if (!letters.length) {
        return "I couldn't find any letters in that text.";
    }

    const counts = frequency.map(item => `${item.letter} × ${item.count}`).join(", ");
    return `I found ${letters.length} letters in "${value}": ${letters.join(" ")}.\nLetter counts: ${counts}.`;
}

function describeSenses(result) {
    const heading = result.corrected
        ? `I couldn't find "${result.requested}". Did you mean "${result.lemma}"?\n\n`
        : `WordNet entries for "${result.lemma}":\n\n`;

    const lines = result.senses.slice(0, 8).map((sense, index) => {
        const synonymLine = sense.synonyms.length > 1
            ? `Related words: ${sense.synonyms.join(", ")}.\n`
            : "";
        return `${index + 1}. (${sense.pos}) ${sense.definition}\n${synonymLine}`.trimEnd();
    });

    const extra = result.senses.length > 8
        ? `\n\nThere are ${result.senses.length - 8} additional senses in the dictionary.`
        : "";

    return heading + lines.join("\n\n") + extra;
}

function respondToLocalLanguage(input, options = {}) {
    const original = String(input || "").trim();
    const stripped = stripGreetingPrefix(original);

    if (isGreeting(original) || (stripped && isGreeting(stripped))) {
        return {
            reply: "Hi! I'm here. What would you like to explore?",
            mode: "Local greeting · no AI API"
        };
    }

    if (/^(?:how are you|how are you doing|how's it going|hows it going)[?!. ]*$/i.test(stripped || original)) {
        return {
            reply: "I'm here and ready to help. I'm still learning how to handle more conversations locally.",
            mode: "Local conversation pattern · no AI API"
        };
    }

    if (/^(?:bye|goodbye|see you|talk later)(?: ari)?[!. ]*$/i.test(original)) {
        return {
            reply: "See you later!",
            mode: "Local response · no AI API"
        };
    }

    if (/^(?:thanks|thank you|thanks ari|thank you ari)[!. ]*$/i.test(original)) {
        return {
            reply: "You're welcome!",
            mode: "Local response · no AI API"
        };
    }

    if (/^(?:who are you|what can you do|what are you able to do)[?!. ]*$/i.test(original)) {
        return {
            reply: "I'm Ari. Right now I can handle supported arithmetic, greet you, and look up English word meanings from the local WordNet dictionary. My local language model is not connected yet.",
            mode: "Local capability summary · no AI API"
        };
    }

    const analysisText = extractTextAnalysisRequest(original);
    if (analysisText) {
        return {
            reply: describeLetterAnalysis(analysisText),
            mode: "Local character analysis · no AI API"
        };
    }

    const term = extractDefinitionTerm(original);
    if (term) {
        const dictionary = options.dictionary;
        if (!dictionary || !dictionary.isAvailable()) {
            return {
                reply: "I recognised that as a word-definition request, but I can't find the WordNet dictionary files. Check the WordNet installation or set WORDNET_DICT_DIR to its dict folder.",
                mode: "Local language parser · WordNet unavailable"
            };
        }

        const result = dictionary.lookup(term);
        if (!result.senses.length) {
            return {
                reply: `I couldn't find "${term}" in my local WordNet dictionary. Try another spelling or a shorter term.`,
                mode: "WordNet dictionary · no AI API"
            };
        }

        return {
            reply: describeSenses(result),
            mode: "WordNet dictionary · local lookup · no AI API"
        };
    }

    return null;
}

module.exports = {
    stripGreetingPrefix,
    extractDefinitionTerm,
    extractTextAnalysisRequest,
    describeLetterAnalysis,
    isGreeting,
    describeSenses,
    respondToLocalLanguage
};
