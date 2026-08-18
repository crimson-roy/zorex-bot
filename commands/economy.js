const fs = require("fs");
const { getPartner } = require("./marry");

// PERSISTENCE FIX: these used to be bare relative paths ("./owners.json",
// "./users.json"), which live on the container's ephemeral disk and get
// wiped on every redeploy. Routed through dataPath() so they persist on
// the attached Railway Volume instead. See lib/dataPath.js.
const dataPath = require("../lib/dataPath");

// FIX: isOwner() below reads MAIN_OWNER, but this file never imported it —
// that made isOwner() throw a ReferenceError the instant .addcrescent ran,
// which the global uncaughtException handler in index.js swallows silently
// (logs to console, sends no reply). That's why .addcrescent looked like it
// was doing nothing.
const { MAIN_OWNER } = require("../config");

const OWNERS_FILE = dataPath("owners.json");

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

    if (MAIN_OWNER && userId === MAIN_OWNER) return true;

    const owners = loadOwners();

    return owners.includes(userId);

}
const USERS_FILE = dataPath("users.json");

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

// Donations to your spouse skip the 10% tax entirely — everyone else pays it.
// Returns { received, taxed } or null if the transfer couldn't happen.
function donateTransfer(users, from, to, amount) {

    if (amount <= 0) return null;
    if (users[from].wallet < amount) return null;

    users[from].wallet -= amount;

    const partner = getPartner(from, users);
    const taxed = partner !== to;

    const received = taxed ? Math.floor(amount * 0.9) : amount;

    users[to].wallet += received;

    saveUsers(users);

    return { received, taxed };

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

    // Married couples share a bank — keep the partner's numbers matching
    const partner = getPartner(userId, users);

    if (partner && users[partner]) {
        users[partner].bank = user.bank;
        users[partner].bankLimit = user.bankLimit;
    }

    saveUsers(users);

    return amount;

}

function withdraw(users, userId, amount) {

    const user = users[userId];

    if (amount <= 0) return false;

    if (user.bank < amount) return false;

    user.bank -= amount;

    user.wallet += amount;

    // Married couples share a bank — keep the partner's numbers matching
    const partner = getPartner(userId, users);

    if (partner && users[partner]) {
        users[partner].bank = user.bank;
        users[partner].bankLimit = user.bankLimit;
    }

    saveUsers(users);

    return amount;

}

// ---------- Shared styled message builders ----------

function notRegisteredMessage() {
    return `╭━━━━ ⚠️ 𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗔𝗧𝗜𝗢𝗡 ━━━━╮
👤 Please register your account. ✨
────── 📝 𝗙𝗢𝗥𝗠𝗔𝗧 ──────
⌨️ .register YOUR_NAME
────── 💡 𝗘𝗫𝗔𝗠𝗣𝗟𝗘 ──────
🔥 .register Crimson Roy
╰━━━━━━━━━━━━━━━━━━━━━━━╯`;
}

function errorBox(title, message, examples) {
    const exampleLines = examples.map(e => `  📥 ${e}`).join("\n");
    return `╭━━━━ ⚠️ ${title} ━━━━╮
   ${message}
  ─── 📝 𝖤𝖷𝖠𝖬𝖯𝖫𝖤 ───
${exampleLines}
╰━━━━━━━━━━━━━━━━━━━━━━━╯`;
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
                { text: notRegisteredMessage() },
                { quoted: msg }
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
`🏧 *ACCOUNT BALANCE*
▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️
${user.name}:
💰Wallet: 《${user.wallet.toLocaleString()}》🌙
🏦Bank:    《${user.bank.toLocaleString()}》🌙
🏛️Max Capacity 《${user.bankLimit.toLocaleString()}》🌙
▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️`
            },
            { quoted: msg }
        );

    }

    else if (text.startsWith(".donate")) {


        if (!users[sender]) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                { text: notRegisteredMessage() },
                { quoted: msg }
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
                { text: errorBox("𝗗𝗢𝗡𝗔𝗧𝗘", "Reply to a user or mention them.", [".donate @user 5000"]) },
                { quoted: msg }
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
                { text: errorBox("𝗗𝗢𝗡𝗔𝗧𝗘", "Enter a valid amount.", [".donate @user 5000"]) },
                { quoted: msg }
            );

        }


        const result = donateTransfer(users, sender, target, amount);

        if (!result) {

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


        const taxNote = result.taxed
            ? `\n\n🧾 10% tax applied — recipient received ${result.received.toLocaleString()} 🌙`
            : `\n\n💍 No tax — donations to your spouse are tax-free.`;


        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🌙 *Crescent Donation Successful!*

👤 From:
@${sender.split("@")[0]}

🎁 To:
@${target.split("@")[0]}

💰 Amount Sent:
${amount.toLocaleString()} 🌙${taxNote}

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
                { text: errorBox("𝗔𝗗𝗗 𝗖𝗥𝗘𝗦𝗖𝗘𝗡𝗧", "Please enter a valid amount.", [".addcrescent 5000"]) },
                { quoted: msg }
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
                { text: notRegisteredMessage() },
                { quoted: msg }
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
                { text: errorBox("𝗦𝗬𝗦𝗧𝗘𝗠 𝗘𝗥𝗥𝗢𝗥", "Enter a valid amount to proceed.", [".dep 5000", ".dep all"]) },
                { quoted: msg }
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
`\n🏦 Your bank is now full.`;

        }

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`💳Deposit Successful
¤¤¤¤¤¤¤¤¤¤¤¤¤¤¤¤¤¤
💱 Deposited: 《${deposited.toLocaleString()}》🌙
💰Wallet: 《${users[sender].wallet.toLocaleString()}》🌙
🏦Bank: 《${users[sender].bank.toLocaleString()}/${users[sender].bankLimit.toLocaleString()}》🌙${extra}`
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
                { text: notRegisteredMessage() },
                { quoted: msg }
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
                { text: errorBox("𝗦𝗬𝗦𝗧𝗘𝗠 𝗘𝗥𝗥𝗢𝗥", "Enter a valid amount to proceed.", [".wd 5000", ".wd all"]) },
                { quoted: msg }
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
`🏧Withdrawal Successful
¤¤¤¤¤¤¤¤¤¤¤¤¤¤¤¤¤¤
💱 Withdrawn: 《${withdrawn.toLocaleString()}》🌙
💰Wallet: 《${users[sender].wallet.toLocaleString()}》🌙
🏦Bank: 《${users[sender].bank.toLocaleString()}/${users[sender].bankLimit.toLocaleString()}》🌙`
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
                { text: errorBox("𝗥𝗘𝗠𝗢𝗩𝗘 𝗖𝗥𝗘𝗦𝗖𝗘𝗡𝗧", "Enter a valid amount.", [".removecrescent 5000"]) },
                { quoted: msg }
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