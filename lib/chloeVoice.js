// Chloe voice notes - free Azure Speech (F0 tier).
// Voice picked 26 Nov 2026 by matching against Chloe's old ElevenLabs reference:
// en-US-JennyNeural, "whispering" style, pitch +12%, a little slower and softer.
// Env: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION (e.g. germanywestcentral).
// Azure returns OGG/Opus directly, which WhatsApp plays as a voice note (no ffmpeg needed).

const VOICE = process.env.CHLOE_VOICE_NAME || "en-US-JennyNeural";
const STYLE = process.env.CHLOE_VOICE_STYLE || "whispering";
const PITCH = process.env.CHLOE_VOICE_PITCH || "+12%";
const RATE = process.env.CHLOE_VOICE_RATE || "-8%";
const VOLUME = process.env.CHLOE_VOICE_VOLUME || "-15%";
const MAX_CHARS = 600; // keeps voice notes short and inside the free tier

// "Chloe send me voice note", "chloe, send me a voice note", ".chloe send me a voicenote", "Chloe send voice note pls"
const VOICE_REQUEST_REGEX = /^\.?\s*(?:(?:hey|hi|yo|oya|abeg)[\s,!]+)?chloe\b[\s,!.]*(?:can you |could you |pls |please )?send\s+(?:me\s+)?(?:a\s+)?(?:voice\s*-?\s*note|vn|voice\s+message)\b/i;

function isVoiceRequest(text) {
    return VOICE_REQUEST_REGEX.test(String(text || "").trim());
}

function isConfigured() {
    return !!(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
}

function escapeXml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Turn a chat reply into something that sounds natural when spoken.
function toSpeech(text) {
    let s = String(text || "");
    s = s.replace(/\*[^*\n]{1,80}\*/g, " ")            // *action beats*
        .replace(/_[^_\n]{1,80}_/g, " ")              // _action beats_
        .replace(/https?:\/\/\S+/g, " ")              // links
        .replace(/@\d{5,}/g, " ")                     // raw WhatsApp mentions
        .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ")
        .replace(/[~`#>|]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (s.length > MAX_CHARS) {
        const cut = s.slice(0, MAX_CHARS);
        const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
        s = end > 200 ? cut.slice(0, end + 1) : cut;
    }
    return s;
}

async function synthesize(text) {
    const spoken = toSpeech(text);
    if (!spoken) return null;
    const ssml =
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' " +
        "xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='en-US'>" +
        `<voice name='${VOICE}'><mstts:express-as style='${STYLE}'>` +
        `<prosody rate='${RATE}' volume='${VOLUME}' pitch='${PITCH}'>${escapeXml(spoken)}</prosody>` +
        "</mstts:express-as></voice></speak>";
    const url = `https://${process.env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY,
                    "Content-Type": "application/ssml+xml",
                    "X-Microsoft-OutputFormat": "ogg-24khz-16bit-mono-opus",
                    "User-Agent": "zorex-chloe"
                },
                body: ssml,
                signal: AbortSignal.timeout(30000)
            });
            if (!res.ok) {
                const err = new Error(`Azure TTS HTTP ${res.status}`);
                if (res.status === 400 || res.status === 401 || res.status === 403) throw Object.assign(err, { fatal: true });
                throw err;
            }
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < 1000) throw new Error(`Azure TTS returned ${buf.length} bytes`);
            return buf;
        } catch (e) {
            lastErr = e;
            if (e.fatal) break;
            await new Promise(r => setTimeout(r, 1500 * attempt));
        }
    }
    throw lastErr;
}

// Sends `text` as a WhatsApp voice note. Returns { sent: true } or { skipped: reason }.
async function sendChloeVoiceNote(sock, chatId, text, quotedMsg) {
    if (!isConfigured()) return { skipped: "AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not set" };
    const audio = await synthesize(text);
    if (!audio) return { skipped: "nothing speakable in the reply" };
    await sock.sendMessage(
        chatId,
        { audio, mimetype: "audio/ogg; codecs=opus", ptt: true },
        quotedMsg ? { quoted: quotedMsg } : undefined
    );
    return { sent: true };
}

module.exports = { isVoiceRequest, isConfigured, toSpeech, synthesize, sendChloeVoiceNote };
