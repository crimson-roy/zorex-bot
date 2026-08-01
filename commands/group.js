const fs = require("fs");

const { MAIN_OWNER } = require("../config");

// PERSISTENCE FIX: these used to be bare relative paths ("./owners.json",
// "./muted.json"), which live on the container's ephemeral disk and get
// wiped on every redeploy. Routed through dataPath() so they persist on
// the attached Railway Volume instead. See lib/dataPath.js.
const dataPath = require("../lib/dataPath");

const OWNERS_FILE = dataPath("owners.json");

const MUTED_FILE = dataPath("muted.json");


// Load muted users
function loadMuted() {

    if (!fs.existsSync(MUTED_FILE)) {

        fs.writeFileSync(
            MUTED_FILE,
            JSON.stringify({}, null, 4)
        );

    }

    return JSON.parse(
        fs.readFileSync(
            MUTED_FILE,
            "utf8"
        )
    );

}


// Save muted users
function saveMuted(data) {

    fs.writeFileSync(
        MUTED_FILE,
        JSON.stringify(
            data,
            null,
            4
        )
    );

}


// Convert time
function parseMuteTime(time) {

    if (!time) return 2 * 60 * 60 * 1000; // default 2 hours


    time = time.toLowerCase();


    if (time.endsWith("mins")) {

        return parseInt(time) * 60 * 1000;

    }


    if (time.endsWith("hr")) {

        return parseInt(time) * 60 * 60 * 1000;

    }


    if (time.endsWith("d")) {

        return parseInt(time) * 24 * 60 * 60 * 1000;

    }


    return 2 * 60 * 60 * 1000;

}



async function groupCommands(sock, msg, text) {


    const groupJid = msg.key.remoteJid;


    if (!groupJid.endsWith("@g.us")) {

        return;

    }



    // Get group metadata

    const metadata =
        await sock.groupMetadata(groupJid);



    const sender =
        msg.key.participant;

        const reply = (text, options = {}) => {
    return sock.sendMessage(
        msg.key.remoteJid,
        {
            text,
            ...options
        },
        {
            quoted: msg
        }
    );
};

    const senderIsAdmin =
        metadata.participants.some(
            p =>
            p.id === sender &&
            (
                p.admin === "admin" ||
                p.admin === "superadmin"
            )
        );

        if (text.startsWith(".unmute")) {

    if (!senderIsAdmin) {

        return await sock.sendMessage(
            groupJid,
            {
                text:
"❌ You are not an admin."
            },
            {
                quoted: msg
            }
        );

    }


    const context =
        msg.message?.extendedTextMessage
        ?.contextInfo;


    let target = null;


    // Tagged user
    if (context?.mentionedJid?.length) {

        target =
            context.mentionedJid[0];

    }

    // Replied user
    else if (context?.participant) {

        target =
            context.participant;

    }


    if (!target) {

        return await sock.sendMessage(
            groupJid,
            {
                text:
"⚠️ Tag someone or reply to their message."
            },
            {
                quoted: msg
            }
        );

    }


    const muted =
        loadMuted();


    if (
        !muted[groupJid] ||
        !muted[groupJid][target]
    ) {

        return await sock.sendMessage(
            groupJid,
            {
                text:
`❌ @${target.split("@")[0]} is not muted.`,
                mentions: [target]
            },
            {
                quoted: msg
            }
        );

    }


    delete muted[groupJid][target];


    if (
        Object.keys(
            muted[groupJid]
        ).length === 0
    ) {

        delete muted[groupJid];

    }


    saveMuted(muted);


    return await sock.sendMessage(
        groupJid,
        {
            text:
`🔊 @${target.split("@")[0]} has been forgiven.

You may speak again. 😌💙`,
            mentions: [target]
        },
        {
            quoted: msg
        }
    );

}

if (text.startsWith(".promote")) {

    const context =
        msg.message?.extendedTextMessage
        ?.contextInfo;

    let target = null;

    // Tagged user
    if (context?.mentionedJid?.length) {

        target = context.mentionedJid[0];

    }

    // Replied user
    else if (context?.participant) {

        target = context.participant;

    }

    // Bot owners
    const owners = JSON.parse(
        fs.readFileSync(
            OWNERS_FILE,
            "utf8"
        )
    );

    const senderIsOwner =
        sender === MAIN_OWNER ||
        owners.includes(sender);

    // =====================================
    // NOT GROUP ADMIN
    // =====================================

    if (!senderIsAdmin) {

        // Not owner
        if (!senderIsOwner) {

            return await sock.sendMessage(
                groupJid,
                {
                    text:
"❌ You are not an admin."
                },
                {
                    quoted: msg
                }
            );

        }

        // Owner but trying to promote someone else
        if (target) {

            return await sock.sendMessage(
                groupJid,
                {
                    text:
"❌ You are not an admin."
                },
                {
                    quoted: msg
                }
            );

        }

        // Owner promotes himself
        target = sender;

    }

    // =====================================
    // GROUP ADMIN
    // =====================================

    else {

        if (!target) {

            return await sock.sendMessage(
                groupJid,
                {
                    text:
"⚠️ Reply to or tag a user to promote."
                },
                {
                    quoted: msg
                }
            );

        }

        if (
            !senderIsOwner &&
            target === sender
        ) {

            return await sock.sendMessage(
                groupJid,
                {
                    text:
"❌ You cannot promote yourself."
                },
                {
                    quoted: msg
                }
            );

        }

    }

    // =====================================
    // TARGET ALREADY ADMIN?
    // =====================================

    const targetData =
        metadata.participants.find(
            p => p.id === target
        );

    if (
        targetData &&
        (
            targetData.admin === "admin" ||
            targetData.admin === "superadmin"
        )
    ) {

        return await sock.sendMessage(
            groupJid,
            {
                text:
`😂 @${target.split("@")[0]} is already an admin.`,
                mentions: [target]
            },
            {
                quoted: msg
            }
        );

    }

    // =====================================
    // PROMOTE
    // =====================================

    await sock.groupParticipantsUpdate(
        groupJid,
        [target],
        "promote"
    );

    // Main owner promoted himself
    if (
        sender === MAIN_OWNER &&
        target === sender
    ) {

        return await sock.sendMessage(
            groupJid,
            {
                text:
`👑 Lord Crimson has promoted himself.

Power has been restored. 😌💙`
            },
            {
                quoted: msg
            }
        );

    }

    // Default message
    return await sock.sendMessage(
        groupJid,
        {
            text:
`👑 @${target.split("@")[0]}

Lord Crimson has promoted you.

Use the power wisely. 😌💙`,
            mentions: [target]
        },
        {
            quoted: msg
        }
    );

}

if (text.startsWith(".demote")) {

    const context =
        msg.message?.extendedTextMessage
        ?.contextInfo;

    let target = null;

    // Tagged user
    if (context?.mentionedJid?.length) {

        target = context.mentionedJid[0];

    }

    // Replied user
    else if (context?.participant) {

        target = context.participant;

    }

    // Bot owners
    const owners = JSON.parse(
        fs.readFileSync(
            OWNERS_FILE,
            "utf8"
        )
    );

    const senderIsOwner =
        sender === MAIN_OWNER ||
        owners.includes(sender);

    // =====================================
    // NOT GROUP ADMIN
    // =====================================

    if (!senderIsAdmin) {

        // Not owner
        if (!senderIsOwner) {

            return await sock.sendMessage(
                groupJid,
                {
                    text:
"❌ You are not an admin."
                },
                {
                    quoted: msg
                }
            );

        }

        // Owner but trying to demote someone else
        if (target) {

            return await sock.sendMessage(
                groupJid,
                {
                    text:
"❌ You are not an admin."
                },
                {
                    quoted: msg
                }
            );

        }

        // Owner demotes himself
        target = sender;

    }

    // =====================================
    // GROUP ADMIN
    // =====================================

    else {

        if (!target) {

            return await sock.sendMessage(
                groupJid,
                {
                    text:
"⚠️ Reply to or tag a user to demote."
                },
                {
                    quoted: msg
                }
            );

        }

        if (
            !senderIsOwner &&
            target === sender
        ) {

            return await sock.sendMessage(
                groupJid,
                {
                    text:
"❌ You cannot demote yourself."
                },
                {
                    quoted: msg
                }
            );

        }

    }

    // =====================================
    // TARGET NOT ADMIN?
    // =====================================

    const targetData =
        metadata.participants.find(
            p => p.id === target
        );

    if (
        !targetData ||
        (
            targetData.admin !== "admin" &&
            targetData.admin !== "superadmin"
        )
    ) {

        return await sock.sendMessage(
            groupJid,
            {
                text:
`😂 @${target.split("@")[0]} is not an admin.`,
                mentions: [target]
            },
            {
                quoted: msg
            }
        );

    }

    // =====================================
    // DEMOTE
    // =====================================

    await sock.groupParticipantsUpdate(
        groupJid,
        [target],
        "demote"
    );

    // Main owner demoted himself
    if (
        sender === MAIN_OWNER &&
        target === sender
    ) {

        return await sock.sendMessage(
            groupJid,
            {
                text:
`👑 Lord Crimson has demoted himself.

Power has been relinquished. 😌💙`
            },
            {
                quoted: msg
            }
        );

    }

    // Default message
    return await sock.sendMessage(
        groupJid,
        {
            text:
`👑 @${target.split("@")[0]}

Lord Crimson has removed your admin powers.

Behave yourself. 😌💙`,
            mentions: [target]
        },
        {
            quoted: msg
        }
    );

}

if (text.startsWith(".kick")) {

    const groupMetadata = await sock.groupMetadata(msg.key.remoteJid);

    const participants = groupMetadata.participants;

    const sender = msg.key.participant || msg.key.remoteJid;


    // Check if sender is group admin
    const senderAdmin = participants.find(
        p => p.id === sender
    )?.admin;


    if (!senderAdmin) {
        return reply("❌ You are not an admin.");
    }


    // Check if bot is admin
    const botLid = sock.user.lid.split(":")[0] + "@lid";

console.log("BOT LID:", botLid);

console.log(
    "GROUP PARTICIPANTS:",
    participants.map(p => ({
        id: p.id,
        admin: p.admin
    }))
);

const botAdmin = participants.find(
    p => p.id === botLid
)?.admin;


if (!botAdmin) {
    return reply("❌ I need to be an admin before I can kick members.");
}

    const context =
        msg.message?.extendedTextMessage
        ?.contextInfo;


    let target = null;


    // Tagged user
    if (context?.mentionedJid?.length) {

        target = context.mentionedJid[0];

    }

    // Replied user
    else if (context?.participant) {

        target = context.participant;

    }


    if (!target) {
        return reply(
            "⚠️ Tag someone or reply to their message.\n\nExample:\n.kick @user"
        );
    }


    // Prevent kicking yourself
    if (target === sender) {
        return reply("🤨 You can't kick yourself.");
    }


    // Prevent kicking bot
    if (target === botLid) {
        return reply("😐 I can't kick myself.");
    }


    try {

        await sock.groupParticipantsUpdate(
            msg.key.remoteJid,
            [target],
            "remove"
        );


        await reply(
            `✅ Removed @${target.split("@")[0]}`,
            {
                mentions: [target]
            }
        );


    } catch (err) {

        console.log(err);

        reply("❌ Failed to remove user.");

    }

}

    if (text.startsWith(".mute")) {


        if (!senderIsAdmin) {

            return await sock.sendMessage(
                groupJid,
                {
                    text:
                    "❌ You are not an admin."
                },
                {
                    quoted: msg
                }
            );

        }



        const context =
    msg.message?.extendedTextMessage
    ?.contextInfo;


let target = null;


// If user tagged someone
if (context?.mentionedJid?.length) {

    target = context.mentionedJid[0];

}


// If user replied to someone
else if (context?.participant) {

    target = context.participant;

}



if (!target) {

    return await sock.sendMessage(
        groupJid,
        {
            text:
            "⚠️ Tag someone or reply to their message."
        },
        {
            quoted: msg
        }
    );

}

        const args =
            text.split(" ");


        const duration =
            args[2];


        const expires =
            Date.now() +
            parseMuteTime(duration);



        const muted =
            loadMuted();



        if (!muted[groupJid]) {

            muted[groupJid] = {};

        }



        if (
    muted[groupJid] &&
    muted[groupJid][target]
) {

    const remaining =
        muted[groupJid][target].expires -
        Date.now();


    const minutes =
        Math.ceil(
            remaining / 60000
        );


    let muteReply;


if (duration) {

    muteReply =
`🔇 User has been muted.

⏳ Duration:
${duration}

They will automatically be unmuted later.`;

} else {

    muteReply =
`🔇 User has been muted.`;

}


return await sock.sendMessage(
    groupJid,
    {
        text: muteReply
    },
    {
        quoted: msg
    }
);

}



if (!muted[groupJid]) {

    muted[groupJid] = {};

}


// Create group storage if it doesn't exist
if (!muted[groupJid]) {

    muted[groupJid] = {};

}


// Check if user is already muted
if (muted[groupJid][target]) {

    const existingMute =
        muted[groupJid][target];


    // If it was a timed mute
    if (existingMute.custom === true) {

        const remaining =
            existingMute.expires - Date.now();


        const minutes =
            Math.ceil(
                remaining / 60000
            );


        return await sock.sendMessage(
            groupJid,
            {
                text:
`🔇 This user is already muted.

⏳ Remaining time:
${minutes} minutes`
            },
            {
                quoted: msg
            }
        );

    }


    // If it was default 2 hour mute
    else {

        return await sock.sendMessage(
            groupJid,
            {
                text:
`🔇 This user is already muted.`
            },
            {
                quoted: msg
            }
        );

    }

}


// Save new mute
muted[groupJid][target] = {

    expires,

    // true = admin gave timer
    // false = automatic 2 hours
    custom: !!duration

};


saveMuted(muted);



        let muteReply;


if (duration) {

    muteReply =
`🔇 User has been muted.

⏳ Duration:
${duration}

They will automatically be unmuted later.`;

} else {

    muteReply =
`🔇 User has been muted.`;

}


                return await sock.sendMessage(
            groupJid,
            {
                text: muteReply
            },
            {
                quoted: msg
            }
        );

    }

}

module.exports = {
    groupCommands
};