"use strict";

function normalizeText(input) {
    return String(input ?? "").normalize("NFKC");
}

function classifyCharacter(character) {
    if (/\p{L}/u.test(character)) return "letter";
    if (/\p{M}/u.test(character)) return "mark";
    if (/\p{N}/u.test(character)) return "number";
    if (/\s/u.test(character)) return "space";
    if (/\p{P}/u.test(character)) return "punctuation";
    if (/\p{S}/u.test(character)) return "symbol";
    return "other";
}

function inspectText(input) {
    const text = normalizeText(input);
    const characters = Array.from(text).map((character, index) => ({
        character,
        type: classifyCharacter(character),
        index
    }));

    const tokens = [];
    const pattern = /[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*|\p{N}+(?:[.,]\p{N}+)?|[^\s]/gu;

    for (const match of text.matchAll(pattern)) {
        const value = match[0];
        const type = /^[\p{L}\p{M}]/u.test(value)
            ? "word"
            : /^\p{N}/u.test(value)
                ? "number"
                : classifyCharacter(value);

        tokens.push({
            text: value,
            type,
            start: match.index,
            end: match.index + value.length
        });
    }

    const letterCount = characters.filter(item => item.type === "letter").length;
    const numberCount = characters.filter(item => item.type === "number").length;
    const words = tokens.filter(item => item.type === "word").map(item => item.text);

    return {
        text,
        characters,
        tokens,
        words,
        counts: {
            characters: characters.length,
            letters: letterCount,
            numbers: numberCount,
            words: words.length,
            tokens: tokens.length
        }
    };
}

function letterFrequency(input) {
    const inspection = inspectText(input);
    const frequency = new Map();

    for (const item of inspection.characters) {
        if (item.type !== "letter") continue;
        const key = item.character.toLocaleLowerCase();
        frequency.set(key, (frequency.get(key) || 0) + 1);
    }

    return [...frequency.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([letter, count]) => ({ letter, count }));
}

module.exports = {
    normalizeText,
    classifyCharacter,
    inspectText,
    letterFrequency
};
