"use strict";

const { WordNetDictionary } = require("../lib/wordNet");

const dictionary = new WordNetDictionary();

if (!dictionary.isAvailable()) {
    console.error("[Ari WordNet] Dictionary files not found.");
    console.error("[Ari WordNet] Expected a dict folder containing index.noun and data.noun.");
    console.error("[Ari WordNet] On Windows, check C:\\Program Files (x86)\\WordNet\\2.1\\dict.");
    console.error("[Ari WordNet] You can set WORDNET_DICT_DIR to the full dict folder.");
    process.exitCode = 1;
} else {
    console.log("[Ari WordNet] Dictionary found at: " + dictionary.getDirectory());

    for (const term of ["persistence", "persistenca"]) {
        const result = dictionary.lookup(term);
        console.log("\nQuery: " + term);

        if (!result.senses.length) {
            console.log("No matching entry found.");
            continue;
        }

        if (result.corrected) {
            console.log("Suggested correction: " + result.lemma);
        }

        for (const sense of result.senses.slice(0, 3)) {
            console.log("- (" + sense.pos + ") " + sense.definition);
        }
    }

    console.log("\n[Ari WordNet] Local dictionary check complete. No AI API was used.");
}
