// commands/antilink.js
//
// .antilink on / .antilink off — per-group toggle (default: off)
// .setwarnings <number>       — per-group warning limit before a kick, capped at 5
// .resetwarnings [all|@user]  — clears link-warning counts
//
// Also exports checkAntilink(sock, msg, text), the per-message watcher.
// This is NOT wired into the main message loop by this file — like
// triviaAnswer()/handleWCGMessage() elsewhere in this bot, it needs to be
// called once per incoming message from index.js's messages.upsert
// handler. It's a no-op (returns false, does nothing) whenever antilink
// is off for the chat or the message isn't in a group, so it's always
// safe to call unconditionally.
//
// Storage is two files, both routed through dataPath() from the start
// (this is new runtime state, so it was never at risk of the ephemeral-
// disk bug — it's just built the same persistent way from day one):
//   - antilink.json     — { [groupId]: { enabled: bool, limit: number } }
//   - linkwarnings.json — { [groupId]: { [userId]: warningCount } }
//
// Permission model for the three commands below (.antilink, .setwarnings,
// .resetwarnings) mirrors .d: group admin OR bot owner.

const fs = require("fs");

const { MAIN_OWNER } = require("../config");
const dataPath = require("../lib/dataPath");

const ANTILINK_FILE = dataPath("antilink.json");
const WARNINGS_FILE = dataPath("linkwarnings.json");

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 5;

// Antilink now runs as an ALLOWLIST, not a blocklist: only links to these
// specific platforms are permitted. Anything else that looks like a link
// (WhatsApp invites, Facebook, Instagram, Telegram, shorteners, random
// domains, etc.) is treated as a violation.
//
// Each entry matches that exact hostname AND any subdomain of it — e.g.
// "youtube.com" also allows "www.youtube.com", "m.youtube.com", and
// "music.youtube.com". "music.apple.com" is listed on its own (not
// "apple.com") so only Apple Music links are allowed — apps.apple.com or
// other apple.com subdomains are still blocked. Add more entries here as
// needed; no other code changes required.
const ALLOWED_DOMAINS = [
    "tiktok.com",       // covers vm.tiktok.com, vt.tiktok.com, www.tiktok.com
    "youtube.com",      // covers www./m./music.youtube.com
    "youtu.be",
    "spotify.com",      // covers open.spotify.com (the real share-link domain)
    "soundcloud.com",   // covers on.soundcloud.com
    "music.apple.com",  // deliberately NOT "apple.com" — only Apple Music links
    "audiomack.com",
    "docs.google.com"   // deliberately NOT "google.com" — only Google Docs links
];

// ---------- Owner check (same pattern as delete.js) ----------

function loadOwners() {

    const ownersFile = dataPath("owners.json");

    if (!fs.existsSync(ownersFile)) {
        fs.writeFileSync(ownersFile, JSON.stringify([], null, 4));
    }

    return JSON.parse(fs.readFileSync(ownersFile, "utf8"));

}

function isOwner(userId) {

    if (!userId) return false;

    if (MAIN_OWNER && userId === MAIN_OWNER) return true;

    return loadOwners().includes(userId);

}

// ---------- antilink.json (per-group settings) ----------

function loadAntilinkSettings() {

    if (!fs.existsSync(ANTILINK_FILE)) {
        fs.writeFileSync(ANTILINK_FILE, JSON.stringify({}, null, 4));
    }

    return JSON.parse(fs.readFileSync(ANTILINK_FILE, "utf8"));

}

function saveAntilinkSettings(data) {

    fs.writeFileSync(ANTILINK_FILE, JSON.stringify(data, null, 4));

}

function getGroupSettings(groupId) {

    const settings = loadAntilinkSettings();
    const group = settings[groupId];

    return {
        enabled: group?.enabled || false,
        limit: group?.limit || DEFAULT_LIMIT
    };

}

function setAntilinkState(groupId, enabled) {

    const settings = loadAntilinkSettings();

    if (!settings[groupId]) settings[groupId] = {};

    settings[groupId].enabled = enabled;

    saveAntilinkSettings(settings);

}

function setWarningLimit(groupId, limit) {

    const settings = loadAntilinkSettings();

    if (!settings[groupId]) settings[groupId] = {};

    settings[groupId].limit = limit;

    saveAntilinkSettings(settings);

}

// ---------- linkwarnings.json (per-group-per-user counts) ----------

function loadWarnings() {

    if (!fs.existsSync(WARNINGS_FILE)) {
        fs.writeFileSync(WARNINGS_FILE, JSON.stringify({}, null, 4));
    }

    return JSON.parse(fs.readFileSync(WARNINGS_FILE, "utf8"));

}

function saveWarnings(data) {

    fs.writeFileSync(WARNINGS_FILE, JSON.stringify(data, null, 4));

}

function incrementWarning(groupId, userId) {

    const warnings = loadWarnings();

    if (!warnings[groupId]) warnings[groupId] = {};

    warnings[groupId][userId] = (warnings[groupId][userId] || 0) + 1;

    saveWarnings(warnings);

    return warnings[groupId][userId];

}

function resetWarning(groupId, userId) {

    const warnings = loadWarnings();

    if (warnings[groupId]) {
        delete warnings[groupId][userId];
        saveWarnings(warnings);
    }

}

function resetAllWarnings(groupId) {

    const warnings = loadWarnings();

    warnings[groupId] = {};

    saveWarnings(warnings);

}

// ---------- Link detection (allowlist model) ----------
//
// A "link candidate" is either:
//   (a) anything starting with http:// or https://, no matter what follows, or
//   (b) a bare domain-looking string (one or more "label." segments plus a
//       TLD) that's immediately followed by a "/path" — e.g. "tiktok.com/x".
// A bare domain with NO path (e.g. someone just typing "node.js" or
// "socket.io" in conversation) is deliberately NOT treated as a link
// candidate — that would false-positive on ordinary text.
const LINK_CANDIDATE_PATTERN = /(https?:\/\/\S+)|((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}\/\S*)/gi;

function extractLinkCandidates(text) {

    return text.match(LINK_CANDIDATE_PATTERN) || [];

}

// Resolves a link candidate string down to its bare hostname (lowercased,
// "www." stripped) so it can be checked against ALLOWED_DOMAINS. Returns
// null if the candidate isn't actually a parseable URL.
function extractHostname(rawCandidate) {

    try {

        const withScheme = /^https?:\/\//i.test(rawCandidate)
            ? rawCandidate
            : `https://${rawCandidate}`;

        return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");

    } catch (err) {

        return null;

    }

}

// A hostname is allowed if it exactly matches an ALLOWED_DOMAINS entry, or
// is a subdomain of one (e.g. "open.spotify.com" is a subdomain of
// "spotify.com").
function isAllowedHostname(hostname) {

    return ALLOWED_DOMAINS.some(
        domain => hostname === domain || hostname.endsWith(`.${domain}`)
    );

}

function containsLink(text) {

    const candidates = extractLinkCandidates(text);

    for (const raw of candidates) {

        const hostname = extractHostname(raw);

        if (!hostname) continue; // not actually parseable as a URL — skip it

        if (!isAllowedHostname(hostname)) return true; // not on the allowlist

    }

    return false; // no link candidates at all, or every one found was allowed

}

// ---------- Shared permission check ----------

async function isAdminOrOwner(sock, groupJid, sender) {

    if (isOwner(sender)) return true;

    try {

        const metadata = await sock.groupMetadata(groupJid);

        return metadata.participants.some(
            p =>
            p.id === sender &&
            (p.admin === "admin" || p.admin === "superadmin")
        );

    } catch (err) {

        return false;

    }

}

// ---------- .antilink on / .antilink off ----------

async function antilinkCommand(sock, msg, text) {

    const groupJid = msg.key.remoteJid;

    if (!groupJid.endsWith("@g.us")) {

        return await sock.sendMessage(
            groupJid,
            { text: "❌ This command only works in groups." },
            { quoted: msg }
        );

    }

    const sender = msg.key.participant || msg.key.remoteJid;

    if (!(await isAdminOrOwner(sock, groupJid, sender))) {

        return await sock.sendMessage(
            groupJid,
            { text: "❌ You are not an admin." },
            { quoted: msg }
        );

    }

    const arg = text.replace(/^\.antilink/i, "").trim().toLowerCase();

    if (arg !== "on" && arg !== "off") {

        return await sock.sendMessage(
            groupJid,
            { text: "Usage:\n.antilink on\n.antilink off" },
            { quoted: msg }
        );

    }

    setAntilinkState(groupJid, arg === "on");

    return await sock.sendMessage(
        groupJid,
        {
            text: arg === "on"
                ? "🔗 Antilink protection is now ON for this group."
                : "🔗 Antilink protection is now OFF for this group."
        },
        { quoted: msg }
    );

}

// ---------- .setwarnings <number> ----------

async function setWarningsCommand(sock, msg, text) {

    const groupJid = msg.key.remoteJid;

    if (!groupJid.endsWith("@g.us")) {

        return await sock.sendMessage(
            groupJid,
            { text: "❌ This command only works in groups." },
            { quoted: msg }
        );

    }

    const sender = msg.key.participant || msg.key.remoteJid;

    if (!(await isAdminOrOwner(sock, groupJid, sender))) {

        return await sock.sendMessage(
            groupJid,
            { text: "❌ You are not an admin." },
            { quoted: msg }
        );

    }

    const arg = text.replace(/^\.setwarnings/i, "").trim();
    const limit = Number(arg);

    if (!arg || isNaN(limit) || !Number.isInteger(limit) || limit < 1) {

        return await sock.sendMessage(
            groupJid,
            { text: "Usage: .setwarnings <number>\n\nExample: .setwarnings 3" },
            { quoted: msg }
        );

    }

    if (limit > MAX_LIMIT) {

        return await sock.sendMessage(
            groupJid,
            { text: `⚠️ Max warning limit is ${MAX_LIMIT}.` },
            { quoted: msg }
        );

    }

    setWarningLimit(groupJid, limit);

    return await sock.sendMessage(
        groupJid,
        { text: `✅ Warning limit set to ${limit} for this group.` },
        { quoted: msg }
    );

}

// ---------- .resetwarnings [all|@user] / reply ----------

async function resetWarningsCommand(sock, msg, text) {

    const groupJid = msg.key.remoteJid;

    if (!groupJid.endsWith("@g.us")) {

        return await sock.sendMessage(
            groupJid,
            { text: "❌ This command only works in groups." },
            { quoted: msg }
        );

    }

    const sender = msg.key.participant || msg.key.remoteJid;

    if (!(await isAdminOrOwner(sock, groupJid, sender))) {

        return await sock.sendMessage(
            groupJid,
            { text: "❌ You are not an admin." },
            { quoted: msg }
        );

    }

    const args = text.replace(/^\.resetwarnings/i, "").trim();

    // .resetwarnings all — wipe every warning in this group
    if (args.toLowerCase() === "all") {

        resetAllWarnings(groupJid);

        return await sock.sendMessage(
            groupJid,
            { text: "🔄 All link warnings reset for this group." },
            { quoted: msg }
        );

    }

    const context =
        msg.message?.extendedTextMessage?.contextInfo;

    let target = sender; // default: reset your own, if no tag/reply given

    if (context?.participant) {

        target = context.participant;

    } else if (context?.mentionedJid?.length) {

        target = context.mentionedJid[0];

    }

    resetWarning(groupJid, target);

    return await sock.sendMessage(
        groupJid,
        {
            text: `🔄 Link warnings reset for @${target.split("@")[0]}.`,
            mentions: [target]
        },
        { quoted: msg }
    );

}

// ---------- Per-message watcher ----------
//
// Called once per incoming message from index.js, before/alongside the
// prefix-command routing — same integration pattern as triviaAnswer() /
// handleWCGMessage(). Returns true if it deleted a message (so the caller
// can choose to stop further routing on that message, matching how
// handleWCGMessage()'s return value is used), false otherwise.

async function checkAntilink(sock, msg, text) {

    const groupJid = msg.key.remoteJid;

    if (!groupJid.endsWith("@g.us")) return false;
    if (!text) return false;

    const settings = getGroupSettings(groupJid);

    if (!settings.enabled) return false;
    if (!containsLink(text)) return false;

    const sender = msg.key.participant || msg.key.remoteJid;

    let metadata;

    try {

        metadata = await sock.groupMetadata(groupJid);

    } catch (err) {

        return false;

    }

    const senderIsAdmin =
        metadata.participants.some(
            p =>
            p.id === sender &&
            (p.admin === "admin" || p.admin === "superadmin")
        );

    // Admins and bot owners are exempt from the link check entirely.
    if (senderIsAdmin || isOwner(sender)) return false;

    try {

        await sock.sendMessage(groupJid, {
            delete: {
                remoteJid: groupJid,
                fromMe: false,
                id: msg.key.id,
                participant: msg.key.participant
            }
        });

    } catch (err) {

        console.error("[antilink] failed to delete message:", err.message);

    }

    const count = incrementWarning(groupJid, sender);

    if (count >= settings.limit) {

        // Warnings reset back to 0 at the limit, so a kicked-and-rejoined
        // user (or one just cleared) starts fresh rather than carrying an
        // old count forever.
        resetWarning(groupJid, sender);

        try {

            await sock.groupParticipantsUpdate(groupJid, [sender], "remove");

        } catch (err) {

            console.error("[antilink] failed to kick:", err.message);

        }

        await sock.sendMessage(groupJid, {
            text: `🚫 @${sender.split("@")[0]} was kicked for repeatedly sending links (${settings.limit}/${settings.limit}).`,
            mentions: [sender]
        });

    } else {

        await sock.sendMessage(groupJid, {
            text: `⚠️ @${sender.split("@")[0]}, links are not allowed here.\n\n📊 Warning: ${count}/${settings.limit}`,
            mentions: [sender]
        });

    }

    return true;

}

module.exports = {
    antilinkCommand,
    setWarningsCommand,
    resetWarningsCommand,
    checkAntilink
};