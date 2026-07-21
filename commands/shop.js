const fs = require("fs");
const { loadInventory, saveInventory } = require("./inventory");

const SHOP_FILE = "./shop.json";
const USERS_FILE = "./users.json";


function loadShop() {
    return JSON.parse(fs.readFileSync(SHOP_FILE, "utf8"));
}

function loadUsers() {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 4));
}


// ---------- Builds the .shop menu text straight from shop.json ----------
// Bank items (type: "bank") go under BANK UPGRADES, everything else goes
// under UTILITIES. Add/edit/remove an item in shop.json and this menu
// updates automatically — no code changes ever needed again.
function buildShopMenu() {

    const shop = loadShop();

    const bankItems = [];
    const utilityItems = [];

    for (const id in shop) {

        const item = shop[id];

        if (item.type === "bank") {

            bankItems.push(
`📦 *[ ${item.name} ]* ── 🆔 ${id}
├─ 💰 Price: ${item.price.toLocaleString()} 🌙
└─ ➕ Capacity: +${item.capacity.toLocaleString()} 🌙`
            );

        } else {

            utilityItems.push(
`🔹 *${item.name}* ── 🆔 ${id}
└─ 💰 Price: ${item.price.toLocaleString()} 🌙`
            );

        }

    }

    const bankSection = bankItems.length > 0 ? bankItems.join("\n") : "Coming soon......";
    const utilitySection = utilityItems.length > 0 ? utilityItems.join("\n") : "Coming soon......";

    return (
`╭ *WELCOME TO ZOREX SHOP* 🛒 ╮
Feel free to look around — as long as you have enough Crescents 🌙, it's yours.
🏦 ━━━━━ *BANK UPGRADES* ━━━━━ 🏦
${bankSection}
🛠️ ━━━━━━ *UTILITIES* ━━━━━━ 🛠️
${utilitySection}
💡 ━━━━━━ *HOW TO BUY* ━━━━━━ 💡
📥 .shop buy <item_ID>
👉 Example: .shop buy 500k
📥 .shop buy <item_ID> <amount>
👉 Example: .shop buy lottery_ticket 5
╰──── 🤖 Powered by Zorex AI ────╯`
    );

}


async function shopCommands(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have a Zorex profile. Use .register`
        }, { quoted: msg });
    }

    if (text === ".shop") {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: buildShopMenu()
        }, { quoted: msg });
    }

    if (text.startsWith(".shop buy")) {

        const args = text.split(" ");
        const itemId = args[2];
        let quantity = Number(args[3]);
        if (!quantity) quantity = 1;

        const shop = loadShop();
        const item = shop[itemId];

        if (!item) {
            return await sock.sendMessage(msg.key.remoteJid, {
                text: `❌ Item not found. Use .shop to view available items.`
            }, { quoted: msg });
        }

        if (quantity <= 0 || isNaN(quantity)) {
            return await sock.sendMessage(msg.key.remoteJid, {
                text: `⚠️ Invalid quantity.`
            }, { quoted: msg });
        }

        if (users[sender].bankLimit === undefined) {
            users[sender].bankLimit = 100000;
        }

        const totalPrice = item.price * quantity;

        if (users[sender].wallet < totalPrice) {
            return await sock.sendMessage(msg.key.remoteJid, {
                text: `❌ Not enough Crescents.\n💰 Required: ${totalPrice.toLocaleString()} 🌙\n💳 Wallet: ${users[sender].wallet.toLocaleString()} 🌙`
            }, { quoted: msg });
        }

        users[sender].wallet -= totalPrice;

        let resultLines = "";

        if (item.type === "bank") {

            users[sender].bankLimit += item.capacity * quantity;

            resultLines = `🏦 New Bank Capacity: ${users[sender].bankLimit.toLocaleString()} 🌙`;

        } else {

            // Non-bank items are tools/collectibles, not cards — these go into inventory.json now
            const inventory = loadInventory();

            if (!inventory[sender]) inventory[sender] = [];

            for (let i = 0; i < quantity; i++) {

                inventory[sender].push({
                    id: itemId,
                    name: item.name,
                    type: item.type,
                    obtainedFrom: "shop",
                    obtainedAt: Date.now()
                });

            }

            saveInventory(inventory);

            resultLines = `📦 Added to your inventory.\nUse .inv to view it.`;

        }

        saveUsers(users);

        await sock.sendMessage(msg.key.remoteJid, {
            text: `✅ *Purchase Successful!*\n🛒 Item: ${item.name}\n📦 Quantity: ${quantity}\n💰 Paid: ${totalPrice.toLocaleString()} 🌙\n${resultLines}\nPowered by Zorex AI 🤖`
        }, { quoted: msg });

    }

}

module.exports = {
    shopCommands
};