const fs = require("fs");

const { MAIN_OWNER } = require("../config");
const { resetUserCooldown, resetAllCooldowns } = require("./cooldown");
const { resetUserDailyLimit, resetAllDailyLimits } = require("./dailylimit");

// PERSISTENCE FIX: these used to be bare relative paths ("./owners.json",
// "./users.json"), which live on the container's ephemeral disk and get
// wiped on every redeploy. Routed through dataPath() so they persist on
// the attached Railway Volume instead. See lib/dataPath.js.
const dataPath = require("../lib/dataPath");

// OWNER CHECK FIX: isOwner() below previously only checked owners.json,
// unlike auction.js (and index.js/group.js) which also always trusts
// MAIN_OWNER from config.js. It "worked" only by coincidence, because
// owners.json's fallback default happened to match Lord Crimson's
// number — this breaks the moment MAIN_OWNER changes or owners.json
// already exists without that entry. .setrole (and every other command
// below gated by isOwner()) now checks MAIN_OWNER first, same as
// auction.js's isOwner().

const OWNERS_FILE = dataPath("owners.json");
const USERS_FILE = dataPath("users.json");


function loadOwners() {

    if (!fs.existsSync(OWNERS_FILE)) {

        fs.writeFileSync(
            OWNERS_FILE,
            JSON.stringify(
                [
                    "2348036391250@s.whatsapp.net"
                ],
                null,
                4
            )
        );

    }

    return JSON.parse(
        fs.readFileSync(OWNERS_FILE, "utf8")
    );

}


// Now also always trusts MAIN_OWNER from config.js, same as auction.js —
// no longer relies solely on owners.json.
function isOwner(userId) {

    if (!userId) return false;

    if (MAIN_OWNER && userId === MAIN_OWNER) return true;

    const owners = loadOwners();

    return owners.includes(userId);

}

// Save owners
function saveOwners(owners) {

    fs.writeFileSync(
        OWNERS_FILE,
        JSON.stringify(
            owners,
            null,
            4
        )
    );

}


// Load users
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


// Save users
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


// Main owner commands
async function ownerCommands(sock, msg, text) {


    const sender =
    msg.key.participant ||
    msg.key.remoteJid;

console.log("SENDER ID:", sender);
console.log("OWNERS FILE:", loadOwners());


    /*
        ADD OWNER
        Only Lord Crimson can use this
    */

    if (text.startsWith(".addowner")) {


        if (sender !== "164317513175043@lid") {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`❌ Only Lord Crimson can add owners.`
                },
                {
                    quoted: msg
                }
            );

        }


        const mentioned =
        msg.message?.extendedTextMessage
        ?.contextInfo
        ?.mentionedJid;


        if (!mentioned || mentioned.length === 0) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`⚠️ Mention the person you want to make owner.

Example:

.addowner @user`
                },
                {
                    quoted: msg
                }
            );

        }


        const newOwner = mentioned[0];


        const owners = loadOwners();


        if (owners.includes(newOwner)) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`😂 That person is already an owner.`
                },
                {
                    quoted: msg
                }
            );

        }


        owners.push(newOwner);

        saveOwners(owners);



        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`👑 Owner Added Successfully!

@${newOwner.split("@")[0]} is now a Zorex owner.`,
                
                mentions:[
                    newOwner
                ]
            },
            {
                quoted: msg
            }
        );


    }





    /*
        REMOVE OWNER
        Only Lord Crimson can use this
    */


    else if (text.startsWith(".removeowner")) {


        if (sender !== "164317513175043@lid") {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`❌ Only Lord Crimson can remove owners.`
                },
                {
                    quoted: msg
                }
            );

        }



        const mentioned =
        msg.message?.extendedTextMessage
        ?.contextInfo
        ?.mentionedJid;



        if (!mentioned || mentioned.length === 0) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`⚠️ Mention the owner you want to remove.

Example:

.removeowner @user`
                },
                {
                    quoted: msg
                }
            );

        }



        const removeUser = mentioned[0];


        let owners = loadOwners();


        owners =
        owners.filter(
            id => id !== removeUser
        );


        saveOwners(owners);



        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🗑️ Owner Removed.

@${removeUser.split("@")[0]} is no longer a Zorex owner.`,
                
                mentions:[
                    removeUser
                ]
            },
            {
                quoted: msg
            }
        );


    }





   /*
    SET ROLE
    Any owner can use
*/

else if (text.startsWith(".setrole")) {


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

Examples:

Reply:
.setrole GOAT

Mention:
.setrole @user GOAT`
            },
            {
                quoted: msg
            }
        );

    }



    let role =
    text
    .replace(".setrole", "")
    .trim();



    // Remove mentioned username from role
    if (context?.mentionedJid) {

        role =
        role
        .replace(
            /@\d+/g,
            ""
        )
        .trim();

    }



    if (!role) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ You need to specify a role.

Example:

.setrole GOAT`
            },
            {
                quoted: msg
            }
        );

    }



    const users = loadUsers();



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



    users[target].role = role;


    saveUsers(users);



        await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`👑 Role Updated Successfully!

👤 User:
@${target.split("@")[0]}

⭐ New Role:
${role}`,

            mentions:[
                target
            ]
        },
        {
            quoted: msg
        }
    );


} // closes .setrole




    /*
        RESET COOLDOWN
        Only Lord Crimson can use this
    */

else if (text.startsWith(".resetcd")) {


    if (sender !== "164317513175043@lid") {

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


    const args =
        text
        .replace(".resetcd", "")
        .trim();


    // .resetcd all — wipe every cooldown for every user
    if (args.toLowerCase() === "all") {

        const cleared = resetAllCooldowns();

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🔄 All cooldowns reset.

🧹 Cleared entries: ${cleared}`
            },
            {
                quoted: msg
            }
        );

    }


    const context =
        msg.message?.extendedTextMessage?.contextInfo;


    let target = sender; // default: reset your own


    if (context?.participant) {

        target = context.participant;

    }

    else if (
        context?.mentionedJid &&
        context.mentionedJid.length > 0
    ) {

        target = context.mentionedJid[0];

    }


    const cleared = resetUserCooldown(target);


    return await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🔄 Cooldown Reset

👤 User:
@${target.split("@")[0]}

🧹 Cleared entries: ${cleared}`,
            mentions:[
                target
            ]
        },
        {
            quoted: msg
        }
    );


} // closes .resetcd




    /*
        RESET DAILY LIMIT
        Only Lord Crimson can use this
    */

else if (text.startsWith(".resetdl")) {


    if (sender !== "164317513175043@lid") {

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


    const args =
        text
        .replace(".resetdl", "")
        .trim();


    // .resetdl all — wipe every daily limit for every user
    if (args.toLowerCase() === "all") {

        const cleared = resetAllDailyLimits();

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🔄 All daily limits reset.

🧹 Cleared entries: ${cleared}`
            },
            {
                quoted: msg
            }
        );

    }


    const context =
        msg.message?.extendedTextMessage?.contextInfo;


    let target = sender; // default: reset your own


    if (context?.participant) {

        target = context.participant;

    }

    else if (
        context?.mentionedJid &&
        context.mentionedJid.length > 0
    ) {

        target = context.mentionedJid[0];

    }


    const cleared = resetUserDailyLimit(target);


    return await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🔄 Daily Limit Reset

👤 User:
@${target.split("@")[0]}

🧹 Cleared entries: ${cleared}`,
            mentions:[
                target
            ]
        },
        {
            quoted: msg
        }
    );


} // closes .resetdl




    /*
        RESET BALANCE
        Removes 80% of a user's total money (wallet + bank)
        Only Lord Crimson can use this
    */

else if (text.startsWith(".resetbal")) {


    if (sender !== "164317513175043@lid") {

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


    const args =
        text
        .replace(".resetbal", "")
        .trim();


    const users = loadUsers();


    // Shrinks wallet + bank by 80% each (keeps ratio, removes 80% of total)
    function slashBalance(user) {

        user.wallet = Math.floor(user.wallet * 0.2);
        user.bank = Math.floor(user.bank * 0.2);

    }


    // .resetbal all — hit every registered user
    if (args.toLowerCase() === "all") {

        let affected = 0;

        for (const id of Object.keys(users)) {

            slashBalance(users[id]);
            affected++;

        }

        saveUsers(users);

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`💥 Balance Reset

🌍 Scope: All users

🧹 Users affected: ${affected}

Each user lost 80% of their total Crescents.`
            },
            {
                quoted: msg
            }
        );

    }


    const context =
        msg.message?.extendedTextMessage?.contextInfo;


    let target = sender; // default: reset your own


    if (context?.participant) {

        target = context.participant;

    }

    else if (
        context?.mentionedJid &&
        context.mentionedJid.length > 0
    ) {

        target = context.mentionedJid[0];

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


    slashBalance(users[target]);

    saveUsers(users);


    return await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`💥 Balance Reset

👤 User:
@${target.split("@")[0]}

💳 New Wallet:
${users[target].wallet.toLocaleString()} 🌙

🏦 New Bank:
${users[target].bank.toLocaleString()} 🌙

They lost 80% of their total Crescents.`,
            mentions:[
                target
            ]
        },
        {
            quoted: msg
        }
    );


} // closes .resetbal


} // closes ownerCommands


module.exports = {
    startOwner: ownerCommands
};