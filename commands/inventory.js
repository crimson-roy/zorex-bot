const fs = require("fs");
const { loadInventory } = require("./inventory");

const TYPE_ICONS = {
    collectible: "🧰",
    mystery: "🎁",
    consumable: "🧪",
    tool: "🛠️"
};

function formatDate(ts) {
    if (!ts) return "Unknown";
    return new Date(ts).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric"
    });
}

// ---------- .inv / .inv <number> ----------
async function invCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const inventory = loadInventory();
    const items = inventory[sender] || [];

    if (items.length === 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `📭 Your inventory is empty.`
        }, { quoted: msg });
    }

    const arg = text.replace(".inv", "").trim();

    // ---- .inv <number> — show a single item's detail ----
    if (arg) {

        const index = parseInt(arg, 10) - 1;

        if (isNaN(index) || index < 0 || index >= items.length) {
            return await sock.sendMessage(msg.key.remoteJid, {
                text: `⚠️ Invalid number. Use .inv to see valid item numbers (1-${items.length}).`
            }, { quoted: msg });
        }

        const item = items[index];
        const icon = TYPE_ICONS[item.type] || "📦";

        const detailText =
`${icon} *${item.name}*
🏷️ Type: ${item.type}
📥 From: ${item.obtainedFrom || "Unknown"}
📅 Obtained: ${formatDate(item.obtainedAt)}
🆔 #${item.id}`;

        if (item.image && fs.existsSync(item.image)) {
            return await sock.sendMessage(msg.key.remoteJid, {
                image: fs.readFileSync(item.image),
                caption: detailText
            }, { quoted: msg });
        }

        if (item.video && fs.existsSync(item.video)) {
            return await sock.sendMessage(msg.key.remoteJid, {
                video: fs.readFileSync(item.video),
                caption: detailText,
                gifPlayback: true
            }, { quoted: msg });
        }

        return await sock.sendMessage(msg.key.remoteJid, {
            text: detailText
        }, { quoted: msg });

    }

    // ---- .inv — list all items ----
    const lines = items.map((item, i) => {
        const icon = TYPE_ICONS[item.type] || "📦";
        return `${i + 1}. ${icon} ${item.name}`;
    });

    const text_out =
`🎒 *YOUR INVENTORY* (${items.length})
${lines.join("\n")}
────────────
💡 Use .inv <number> to view an item`;

    return await sock.sendMessage(msg.key.remoteJid, {
        text: text_out
    }, { quoted: msg });

}

module.exports = { invCommand };