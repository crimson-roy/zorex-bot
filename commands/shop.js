const fs = require("fs");

const SHOP_FILE = "./shop.json";
const USERS_FILE = "./users.json";
const COLLECTION_FILE = "./collection.json";


function loadShop() {

    return JSON.parse(
        fs.readFileSync(
            SHOP_FILE,
            "utf8"
        )
    );

}


function loadUsers() {

    return JSON.parse(
        fs.readFileSync(
            USERS_FILE,
            "utf8"
        )
    );

}


function saveUsers(users) {

    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify(
            users,
            null,
            4
        )
    );

}


function loadCollection() {

    if (!fs.existsSync(COLLECTION_FILE)) {
        fs.writeFileSync(COLLECTION_FILE, "{}");
    }

    return JSON.parse(
        fs.readFileSync(
            COLLECTION_FILE,
            "utf8"
        )
    );

}


function saveCollection(collection) {

    fs.writeFileSync(
        COLLECTION_FILE,
        JSON.stringify(
            collection,
            null,
            4
        )
    );

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

`🏦 ${item.name}
💰 Price: ${item.price.toLocaleString()} 🌙
➕ Capacity: +${item.capacity.toLocaleString()} 🌙
🆔 ID: ${id}`

            );

        } else {

            utilityItems.push(

`🛠️ ${item.name}
💰 Price: ${item.price.toLocaleString()} 🌙
🆔 ID: ${id}`

            );

        }

    }

    const bankSection =
        bankItems.length > 0
        ? bankItems.join("\n\n")
        : "Coming soon......";

    const utilitySection =
        utilityItems.length > 0
        ? utilityItems.join("\n\n")
        : "Coming soon......";

    return (
`🌙 *WELCOME TO ZOREX SHOP* 🛒

Feel free to look around and choose anything you want.

As long as you have enough Crescents 🌙 to pay, the item is yours.

━━━━━━━━━━━━━━━

🏦 *BANK UPGRADES*

━━━━━━━━━━━━━━━

${bankSection}

━━━━━━━━━━━━━━━

🛠️ *UTILITIES*

━━━━━━━━━━━━━━━

${utilitySection}

━━━━━━━━━━━━━━━

🛒 *HOW TO BUY*

━━━━━━━━━━━━━━━

.shop buy <item_ID>

Example:

.shop buy 500k

For multiple purchases:

.shop buy <item_ID> <amount>

Example:

.shop buy lottery_ticket 5

Powered by Zorex AI 🤖`
    );

}


async function shopCommands(sock, msg, text) {


    const sender =
        msg.key.participant ||
        msg.key.remoteJid;


    const users = loadUsers();


    if (!users[sender]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`❌ You don't have a Zorex profile.

Use:
.register`
            },
            {
                quoted: msg
            }
        );

    }



    /*
        SHOP MENU
        Generated live from shop.json — always in sync.
    */

    if (text === ".shop") {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: buildShopMenu()
            },
            {
                quoted: msg
            }
        );

    }

    else if (text.startsWith(".shop buy")) {

        const args = text.split(" ");

        const itemId = args[2];

        let quantity = Number(args[3]);

        if (!quantity) quantity = 1;

        const shop = loadShop();

        const item = shop[itemId];

        if (!item) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`❌ Item not found.

Use:
.shop

to view available items.`
                },
                {
                    quoted: msg
                }
            );

        }

        if (quantity <= 0 || isNaN(quantity)) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`⚠️ Invalid quantity.`
                },
                {
                    quoted: msg
                }
            );

        }

        if (users[sender].bankLimit === undefined) {

            users[sender].bankLimit = 100000;

        }

        const totalPrice = item.price * quantity;

        if (users[sender].wallet < totalPrice) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`❌ Not enough Crescents.

💰 Required:
${totalPrice.toLocaleString()} 🌙

💳 Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
                },
                {
                    quoted: msg
                }
            );

        }

        users[sender].wallet -= totalPrice;

        let resultLines = "";

        if (item.type === "bank") {

            users[sender].bankLimit += item.capacity * quantity;

            resultLines =
`🏦 New Bank Capacity:
${users[sender].bankLimit.toLocaleString()} 🌙`;

        } else {

            // Non-bank items go straight into the collection instead
            const collection = loadCollection();

            if (!collection[sender]) collection[sender] = [];

            for (let i = 0; i < quantity; i++) {

                collection[sender].push({
                    id: itemId,
                    name: item.name,
                    type: item.type,
                    obtainedFrom: "shop",
                    obtainedAt: Date.now()
                });

            }

            saveCollection(collection);

            resultLines =
`📦 Added to your collection.

Use .col to view it.`;

        }

        saveUsers(users);

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`✅ *Purchase Successful!*

🛒 Item:
${item.name}

📦 Quantity:
${quantity}

💰 Paid:
${totalPrice.toLocaleString()} 🌙

${resultLines}

Powered by Zorex AI 🤖`
            },
            {
                quoted: msg
            }
        );

    }

}

module.exports = {
    shopCommands
};