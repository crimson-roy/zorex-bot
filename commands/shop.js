const fs = require("fs");

const SHOP_FILE = "./shop.json";
const USERS_FILE = "./users.json";


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
    */

    if (text === ".shop") {

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🌙 *WELCOME TO ZOREX SHOP* 🛒

Feel free to look around and choose anything you want.

As long as you have enough Crescents 🌙 to pay, the item is yours.

━━━━━━━━━━━━━━━

🏦 *BANK UPGRADES*

━━━━━━━━━━━━━━━

🏦 Bank +500K
💰 Price: 100,000 🌙
➕ Capacity: +500,000 🌙

🏦 Bank +3M
💰 Price: 600,000 🌙
➕ Capacity: +3,000,000 🌙

🏦 Bank +10M
💰 Price: 2,000,000 🌙
➕ Capacity: +10,000,000 🌙

🏦 Bank +50M
💰 Price: 10,000,000 🌙
➕ Capacity: +50,000,000 🌙

🏦 Bank +100M
💰 Price: 20,000,000 🌙
➕ Capacity: +100,000,000 🌙

🏦 Bank +500M
💰 Price: 100,000,000 🌙
➕ Capacity: +500,000,000 🌙

🏦 Bank +1B
💰 Price: 200,000,000 🌙
➕ Capacity: +1,000,000,000 🌙

🏦 Bank +5B
💰 Price: 1,000,000,000 🌙
➕ Capacity: +5,000,000,000 🌙

🏦 Bank +10B
💰 Price: 2,000,000,000 🌙
➕ Capacity: +10,000,000,000 🌙

🏦 Bank +100B
💰 Price: 20,000,000,000 🌙
➕ Capacity: +100,000,000,000 🌙

🏦 Bank +500B
💰 Price: 100,000,000,000 🌙
➕ Capacity: +500,000,000,000 🌙

🏦 Bank +1T
💰 Price: 200,000,000,000 🌙
➕ Capacity: +1,000,000,000,000 🌙

━━━━━━━━━━━━━━━

🛠️ *UTILITIES*

━━━━━━━━━━━━━━━

🎫 Lottery Tickets
Coming soon......

🎁 Gifts
Coming soon......

🎨 Cosmetics
Coming soon......

━━━━━━━━━━━━━━━

🎰 *LOTTERY*

━━━━━━━━━━━━━━━

Coming soon......

━━━━━━━━━━━━━━━

🛒 *HOW TO BUY*

━━━━━━━━━━━━━━━

.shop buy <item_ID>

Example:

.shop buy 500k

For multiple purchases:

.shop buy <item_ID> <amount>

Example:

.shop buy ticket 5

Powered by Zorex AI 🤖`
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

    if (item.type === "bank") {

        users[sender].bankLimit += item.capacity * quantity;

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

🏦 New Bank Capacity:
${users[sender].bankLimit.toLocaleString()} 🌙

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