"use strict";

const fs = require("fs");
const path = require("path");
const dataPath = require("./dataPath");
const { CHLOE_SYSTEM_PROMPT } = require("./chloePersona");

const SELECTION_PATH = dataPath("selectedCharacters.json");

const CHARACTERS = Object.freeze({
    chloe: Object.freeze({
        id: "chloe",
        name: "Chloe",
        status: "ready",
        systemPrompt: CHLOE_SYSTEM_PROMPT
    }),
    crescent: Object.freeze({
        id: "crescent",
        name: "Crescent",
        status: "provisional",
        systemPrompt:
            "You are Crescent, a distinct NPC companion in Zorex. " +
            "Use only character facts explicitly supplied in the current " +
            "world and any approved Crescent profile. This starter profile " +
            "does not define her canon, biography, appearance, powers, or " +
            "relationships: do not invent those facts or contradict supplied " +
            "facts. Speak naturally and distinctly from Chloe. In roleplay, " +
            "control only your own NPC actions and dialogue; never narrate " +
            "human participants' actions, thoughts, emotions, or speech."
    })
});

function normalizeJid(value) {
    if (typeof value !== "string") return null;

    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/:\d+(?=@)/, "");

    if (!normalized) return null;
    return normalized;
}

function normalizeAliases(values) {
    const list = Array.isArray(values) ? values : [values];
    const aliases = [...new Set(
        list.map(normalizeJid).filter(value => value && !value.endsWith("@g.us"))
    )];
    const lid = aliases.find(value => value.endsWith("@lid"));
    return lid
        ? [lid, ...aliases.filter(value => value !== lid)]
        : aliases;
}

function getIdentityAliases(source) {
    if (Array.isArray(source) || typeof source === "string") {
        return normalizeAliases(source);
    }

    const key = source?.key || {};
    const remote = normalizeJid(key.remoteJid);
    const isGroup = Boolean(remote && remote.endsWith("@g.us"));

    return normalizeAliases(
        isGroup
            ? [key.participantAlt, key.participant]
            : [
                key.remoteJidAlt,
                key.remoteJid,
                key.participantAlt,
                key.participant
            ]
    );
}

function primaryIdentity(aliases) {
    return normalizeAliases(aliases)[0] || null;
}

function readSelections() {
    if (!fs.existsSync(SELECTION_PATH)) return {};

    const parsed = JSON.parse(fs.readFileSync(SELECTION_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Selected-character store has an invalid shape.");
    }
    return parsed;
}

function writeSelections(selections) {
    fs.mkdirSync(path.dirname(SELECTION_PATH), { recursive: true });

    const temp = SELECTION_PATH + "." + process.pid + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(selections, null, 2) + "\n", {
        mode: 0o600
    });
    fs.renameSync(temp, SELECTION_PATH);
    fs.chmodSync(SELECTION_PATH, 0o600);
}

function getCharacter(idOrName) {
    const id = String(idOrName || "").trim().toLowerCase();
    if (CHARACTERS[id]) return CHARACTERS[id];

    return Object.values(CHARACTERS).find(
        item => item.name.toLowerCase() === id
    ) || null;
}

function listCharacters() {
    return Object.values(CHARACTERS);
}

function getSelectedCharacter(aliases) {
    const selections = readSelections();

    for (const alias of normalizeAliases(aliases)) {
        const selectedId = selections[alias];
        if (selectedId && CHARACTERS[selectedId]) {
            return CHARACTERS[selectedId];
        }
    }

    // Existing users continue to use Chloe unless they select a companion.
    return CHARACTERS.chloe;
}

function setSelectedCharacter(aliases, idOrName) {
    const ids = normalizeAliases(aliases);
    const character = getCharacter(idOrName);

    if (!ids.length) {
        throw new Error("I couldn't identify your WhatsApp account.");
    }
    if (!character) {
        throw new Error("That character is not configured in Zorex yet.");
    }

    const selections = readSelections();
    for (const id of ids) selections[id] = character.id;
    writeSelections(selections);

    return character;
}

module.exports = {
    CHARACTERS,
    getCharacter,
    listCharacters,
    getSelectedCharacter,
    setSelectedCharacter,
    getIdentityAliases,
    normalizeAliases,
    normalizeJid,
    primaryIdentity
};
