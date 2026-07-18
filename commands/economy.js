const fs = require("fs");

const OWNERS_FILE = "./owners.json";

function loadOwners() {

    if (!fs.existsSync(OWNERS_FILE)) {

        fs.writeFileSync(
            OWNERS_FILE,
            JSON.stringify([], null, 4)
        );

    }

    return JSON.parse(
        fs.readFileSync(OWNERS_FILE, "utf8")
    );

}

function isOwner(userId) {

    const owners = loadOwners();

    return owners.includes(userId);

}
const USERS_FILE = "./users.json";

function loadUsers() {

    if (!fs.existsSync(USERS_FILE)) {

        fs.writeFileSync(
            USERS_FILE,
            "{}"
        );

    }

    return JSON.parse(
        fs.readFileSync(USERS_FILE, "utf8")
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

function creditWallet(users, userId, amount) {

    users[userId].wallet += amount;

    saveUsers(users);

}

function debitWallet(users, userId, amount) {

    users[userId].wallet -= amount;

    saveUsers(users);

}

function transferWallet(users, from, to, amount) {

    if (amount <= 0)
        return false;

    if (users[from].wallet < amount)
        return false;

    users[from].wallet -= amount;

    users[to].wallet += amount;

    saveUsers(users);

    return true;

}

function deposit(users, userId, amount) {

    const user = users[userId];

    if (amount <= 0) return false;

    if (user.wallet < amount) return false;

    const freeSpace =
        user.bankLimit - user.bank;

    if (freeSpace <= 0)
        return false;

    if (amount > freeSpace)
        amount = freeSpace;

    user.wallet -= amount;

    user.bank += amount;

    saveUsers(users);

    return amount;

}

function withdraw(users, userId, amount) {

    const user = users[userId];

    if (amount <= 0) return false;

    if (user.bank < amount) return false;

    user.bank -= amount;

    user.wallet += amount;

    saveUsers(users);

    return amount;

}

async function economyCommands(sock, msg, text) {

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const users = loadUsers();

    /*
        BALANCE
    */

    if (text === ".bal") {

        if (!users[sender]) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`❌ You don't have a profile yet.

Use:
.register

to create your Zorex profile 🌙`
                },
                {
                    quoted: msg
                }
            );

        }

        const user = users[sender];
if (user.bankLimit === undefined) {

    user.bankLimit = 100000;

    saveUsers(users);

}

        await sock.sendMessage(
    msg.key.remoteJid,
    {
        text:
`🌙 *ZOREX BANK*

👤 Name:
${user.name}

💰 Wallet:
${user.wallet.toLocaleString()} 🌙

🏦 Bank:
${user.bank.toLocaleString()} / ${user.bankLimit.toLocaleString()} 🌙

Powered by Zorex AI 🤖`
    },
    {
        quoted: msg
    }
);

}

else if (text.startsWith(".donate")) {


    if (!users[sender]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`❌ You don't have a Zorex profile yet.

Use:
.register`
            },
            {
                quoted: msg
            }
        );

    }


    const context =
        msg.message?.extendedTextMessage?.contextInfo;


    let target = null;


    // Reply method
    if (context?.participant) {

        target = context.participant;

    }


    // Mention method
    else if (
        context?.mentionedJid &&
        context.mentionedJid.length > 0
    ) {

        target = context.mentionedJid[0];

    }


    if (!target) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ Reply to a user or mention them.

Example:

.donate @user 5000`
            },
            {
                quoted: msg
            }
        );

    }


    if (!users[target]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ That user does not have a Zorex profile.`
            },
            {
                quoted: msg
            }
        );

    }


    if (target === sender) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`😂 You cannot donate Crescents to yourself.`
            },
            {
                quoted: msg
            }
        );

    }


    let args =
        text
        .replace(".donate", "")
        .trim();


    args =
        args.replace(/@\d+/g, "").trim();


    const amount =
        Number(
            args.replace(/,/g, "")
        );


    if (isNaN(amount) || amount <= 0) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ Enter a valid amount.

Example:

.donate @user 5000`
            },
            {
                quoted: msg
            }
        );

    }


    if (
        !transferWallet(
            users,
            sender,
            target,
            amount
        )
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`❌ You don't have enough Crescents in your wallet.`
            },
            {
                quoted: msg
            }
        );

    }


    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🌙 *Crescent Donation Successful!*

👤 From:
@${sender.split("@")[0]}

🎁 To:
@${target.split("@")[0]}

💰 Amount:
${amount.toLocaleString()} 🌙

💳 Your Wallet:
${users[sender].wallet.toLocaleString()} 🌙

Powered by Zorex AI 🤖`,
            mentions:[
                sender,
                target
            ]
        },
        {
            quoted: msg
        }
    );

} else if (text.startsWith(".addcrescent")) {

    if (!isOwner(sender)) {

    return await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`❌ You don't have permission to use this command.`
        },
        {
            quoted: msg
        }
    );

}

const context =
    msg.message?.extendedTextMessage?.contextInfo;

let target = sender;

    // Reply method
    if (context?.participant) {

        target = context.participant;

    }

    // Mention method
    else if (
        context?.mentionedJid &&
        context.mentionedJid.length > 0
    ) {

        target = context.mentionedJid[0];

    }

    let args =
        text
        .replace(".addcrescent", "")
        .trim();

    // Remove @mention from text if present
    args =
        args.replace(/@\d+/g, "").trim();

    const amount =
        Number(
            args.replace(/,/g, "")
        );

    if (isNaN(amount) || amount <= 0) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ Please enter a valid amount.

Example:

.addcrescent 5000`
            },
            {
                quoted: msg
            }
        );

    }

    if (!users[target]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ That user is not registered.`
            },
            {
                quoted: msg
            }
        );

    }

    creditWallet(
    users,
    target,
    amount
);

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🌙 *Crescents Added Successfully!*

👤 User:
@${target.split("@")[0]}

💰 Amount:
+${amount.toLocaleString()} 🌙

💳 New Wallet:
${users[target].wallet.toLocaleString()} 🌙

Powered by Zorex AI 🤖`,
            mentions: [
                target
            ]
                },
        {
            quoted: msg
        }
    );

}

else if (text.startsWith(".dep")) {

    if (!users[sender]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`❌ You don't have a profile yet.

Use:
.register`
            },
            {
                quoted: msg
            }
        );

    }

    let input =
        text.replace(".dep", "").trim();

    let amount;

    if (input.toLowerCase() === "all") {

        amount = users[sender].wallet;

    } else {

        amount = Number(
            input.replace(/,/g, "")
        );

    }

    if (isNaN(amount) || amount <= 0) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ Enter a valid amount.

Example:

.dep 5000
.dep all`
            },
            {
                quoted: msg
            }
        );

    }

    const deposited =
        deposit(
            users,
            sender,
            amount
        );

    if (!deposited) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`❌ Deposit failed.

Possible reasons:

• Your wallet doesn't have enough Crescents.
• Your bank is already full.`
            },
            {
                quoted: msg
            }
        );

    }

    let extra = "";

    if (
        users[sender].bank ===
        users[sender].bankLimit
    ) {

        extra =
`\n\n🏦 Your bank is now full.`;

    }

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🏦 Deposit Successful!

💰 Deposited:
${deposited.toLocaleString()} 🌙

💳 Wallet:
${users[sender].wallet.toLocaleString()} 🌙

🏦 Bank:
${users[sender].bank.toLocaleString()} / ${users[sender].bankLimit.toLocaleString()} 🌙${extra}

Powered by Zorex AI 🤖`
        },
        {
            quoted: msg
        }
    );

}

else if (text.startsWith(".wd")) {

    if (!users[sender]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`❌ You don't have a profile yet.

Use:
.register`
            },
            {
                quoted: msg
            }
        );

    }

    let input =
        text.replace(".wd", "").trim();

    let amount;

    if (input.toLowerCase() === "all") {

        amount = users[sender].bank;

    } else {

        amount = Number(
            input.replace(/,/g, "")
        );

    }

    if (isNaN(amount) || amount <= 0) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ Enter a valid amount.

Example:

.wd 5000
.wd all`
            },
            {
                quoted: msg
            }
        );

    }

    const withdrawn =
        withdraw(
            users,
            sender,
            amount
        );

    if (!withdrawn) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`❌ You don't have enough Crescents in your bank.`
            },
            {
                quoted: msg
            }
        );

    }

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🏦 Withdrawal Successful!

💰 Withdrawn:
${withdrawn.toLocaleString()} 🌙

💳 Wallet:
${users[sender].wallet.toLocaleString()} 🌙

🏦 Bank:
${users[sender].bank.toLocaleString()} / ${users[sender].bankLimit.toLocaleString()} 🌙

Powered by Zorex AI 🤖`
        },
        {
            quoted: msg
        }
    );

}
  
  else if (text.startsWith(".removecrescent")) {

    if (
        sender !== "2348036391250@s.whatsapp.net" &&
        sender !== "164317513175043@lid"
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`❌ Only Lord Crimson can use this command.`
            },
            {
                quoted: msg
            }
        );

    }

    const context =
        msg.message?.extendedTextMessage?.contextInfo;

    let target = sender;

    if (context?.participant) {

        target = context.participant;

    }

    else if (
        context?.mentionedJid &&
        context.mentionedJid.length > 0
    ) {

        target = context.mentionedJid[0];

    }

    let args =
        text
        .replace(".removecrescent", "")
        .trim();

    args =
        args.replace(/@\d+/g, "").trim();

    const amount =
        Number(
            args.replace(/,/g, "")
        );

    if (isNaN(amount) || amount <= 0) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ Enter a valid amount.

Example:

.removecrescent 5000`
            },
            {
                quoted: msg
            }
        );

    }

    if (!users[target]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ That user is not registered.`
            },
            {
                quoted: msg
            }
        );

    }

    let remaining = amount;

    // Remove from bank first
    if (users[target].bank >= remaining) {

        users[target].bank -= remaining;

        remaining = 0;

    } else {

        remaining -= users[target].bank;

        users[target].bank = 0;

    }

    // Whatever remains comes from wallet
    if (remaining > 0) {

        debitWallet(
            users,
            target,
            remaining
        );

    } else {

        saveUsers(users);

    }

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🌙 *Crescents Removed Successfully!*

👤 User:
@${target.split("@")[0]}

💸 Amount:
-${amount.toLocaleString()} 🌙

💰 Wallet:
${users[target].wallet.toLocaleString()} 🌙

🏦 Bank:
${users[target].bank.toLocaleString()} / ${users[target].bankLimit.toLocaleString()} 🌙

Powered by Zorex AI 🤖`,
            mentions: [
                target
            ]
        },
        {
            quoted: msg
        }
   
    );


}

    }

module.exports = {
    economyCommands
};