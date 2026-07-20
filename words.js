const fs = require("fs");
const path = require("path");

const WORDS_FILE = path.join(__dirname, "words.txt");

let wordSet = new Set();

try {
    wordSet = new Set(
        fs.readFileSync(WORDS_FILE, "utf8")
            .split("\n")
            .map(w => w.trim().toLowerCase())
            .filter(Boolean)
    );
    console.log(`📖 Loaded ${wordSet.size} words for WCG.`);
} catch (err) {
    console.error("⚠️ Could not load words.txt — WCG will reject every word:", err.message);
}

function isValidWord(word) {
    return wordSet.has(word.toLowerCase().trim());
}

module.exports = { isValidWord, wordCount: wordSet.size };