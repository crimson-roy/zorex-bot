// Z_HD delivery: when someone messages the bot "Z_HD XXXX-XXXX-XXXX-XXXX" (the code
// from the Ari website's Compress page), send them their compressed video.
// Videos sent by the bot keep their quality; forwarding them keeps it too.
"use strict";

const fs = require("fs");
const path = require("path");

const DELIVERY_DIR = process.env.ZHD_DELIVERY_DIR || "/var/lib/ari-playground/ariCompress/deliveries";
const MESSAGE_RE = /^\s*Z_?HD\s*[:\-]?\s*([0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4})\s*$/i;

const CAPTION =
`🎬 *Your Z_HD video is ready*

⚠️ *Forward this video* to share it or post it. Don't save it and send it again, and don't crop or edit it, or WhatsApp will compress it and the quality will be lost.`;

function readDelivery(code) {
    try {
        return JSON.parse(fs.readFileSync(path.join(DELIVERY_DIR, code + ".json"), "utf8"));
    } catch {
        return null;
    }
}

async function handleZhdDelivery(sock, msg) {
    if (msg.key?.fromMe) return false;
    const raw = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
    if (!raw || raw.length > 120) return false;
    const match = raw.match(MESSAGE_RE);
    if (!match) return false;

    const code = match[1].toUpperCase();
    const jid = msg.key.remoteJid;
    const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg });

    const delivery = readDelivery(code);
    const file = delivery && path.join(DELIVERY_DIR, path.basename(delivery.file || ""));
    if (!delivery || Date.now() > Number(delivery.expiresAt) || !fs.existsSync(file)) {
        await reply("❌ That Z_HD code is wrong or has expired. Codes last 24 hours, so compress the video again on the website.");
        return true;
    }
    if (Number(delivery.deliveries) >= Number(delivery.maxDeliveries || 3)) {
        await reply("⚠️ This video has already been sent the maximum number of times. Forward one of the copies you already have, or compress it again on the website.");
        return true;
    }

    try {
        await sock.sendMessage(jid, {
            video: { url: file },
            mimetype: "video/mp4",
            fileName: delivery.name || "video_Z_HD.mp4",
            caption: CAPTION,
        }, { quoted: msg });
        delivery.deliveries = Number(delivery.deliveries || 0) + 1;
        delivery.lastDeliveredAt = Date.now();
        fs.writeFileSync(path.join(DELIVERY_DIR, code + ".json"), JSON.stringify(delivery));
        console.log(`🎬 Z_HD delivered ${code} (${delivery.deliveries}/${delivery.maxDeliveries || 3})`);
    } catch (err) {
        console.error("⚠️ Z_HD delivery failed:", code, err.message);
        await reply("❌ Something went wrong sending your video. Try sending the code again in a minute.");
    }
    return true;
}

module.exports = { handleZhdDelivery };
