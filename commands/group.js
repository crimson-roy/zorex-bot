const fs = require("fs");

const { MAIN_OWNER } = require("../config");

// PERSISTENCE FIX: these used to be bare relative paths ("./owners.json",
// "./muted.json"), which live on the container's ephemeral disk and get
// wiped on every redeploy. Routed through dataPath() so they persist on
// the attached Railway Volume instead. See lib/dataPath.js.
const dataPath = require("../lib/dataPath");

const OWNERS_FILE = dataPath("owners.json");

const MUTED_FILE = dataPath("muted.json");
const MUTE_ALL_FILE = dataPath("muteall.json");

function normalizeJid(jid) {

    if (!jid || typeof jid !== "string") {
        return "";
    }

    const [left, server] =
        jid.toLowerCase().split("@");

    if (!server) {
        return jid.toLowerCase();
    }

    return `${left.split(":")[0]}@${server}`;

}

function messageSenderAliases(msg) {

    const key =
        msg?.key || {};

    return [
        ...new Set(
            [
                key.participant,
                key.participantAlt,
                key.senderPn,
                key.senderLid
            ]
                .filter(Boolean)
                .map(String)
        )
    ];

}

function participantAliases(participant) {

    return [
        ...new Set(
            [
                participant?.id,
                participant?.lid,
                participant?.phoneNumber,
                participant?.jid
            ]
                .filter(Boolean)
                .map(normalizeJid)
        )
    ];

}

function participantMatches(
    participant,
    jid
) {

    const target =
        normalizeJid(jid);

    return participantAliases(
        participant
    ).includes(
        target
    );

}

function findParticipantByJid(
    participants,
    jid
) {

    return (
        participants || []
    ).find(participant =>
        participantMatches(
            participant,
            jid
        )
    );

}



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


function loadMuteAll() {

    if (!fs.existsSync(MUTE_ALL_FILE)) {

        fs.writeFileSync(
            MUTE_ALL_FILE,
            JSON.stringify({}, null, 4)
        );

    }

    try {

        const parsed =
            JSON.parse(
                fs.readFileSync(
                    MUTE_ALL_FILE,
                    "utf8"
                )
            );

        return parsed &&
            typeof parsed === "object"
                ? parsed
                : {};

    } catch (_) {

        return {};

    }

}


function saveMuteAll(data) {

    fs.writeFileSync(
        MUTE_ALL_FILE,
        JSON.stringify(
            data,
            null,
            4
        )
    );

}

// Convert mute duration. Returns null for an explicitly-invalid duration
// instead of silently falling back to two hours.
function parseMuteTime(time) {

    if (!time) {
        return 2 * 60 * 60 * 1000; // default 2 hours
    }

    const value =
        String(time)
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "");

    const match =
        value.match(
            /^(\d+)(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/
        );

    if (!match) {
        return null;
    }

    const amount =
        Number(match[1]);

    if (
        !Number.isFinite(amount) ||
        amount <= 0
    ) {
        return null;
    }

    const unit =
        match[2];

    if (
        ["m", "min", "mins", "minute", "minutes"]
            .includes(unit)
    ) {
        return amount * 60 * 1000;
    }

    if (
        ["h", "hr", "hrs", "hour", "hours"]
            .includes(unit)
    ) {
        return amount * 60 * 60 * 1000;
    }

    return amount * 24 * 60 * 60 * 1000;
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

    const senderAliases =
        messageSenderAliases(
            msg
        );

    const senderIsAdmin =
        metadata.participants.some(
            p =>
                senderAliases.some(
                    alias =>
                        participantMatches(
                            p,
                            alias
                        )
                ) &&
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

    if (/^\.unmute\s+all$/i.test(text.trim())) {

        const muteAll =
            loadMuteAll();

        if (!muteAll[groupJid]?.enabled) {

            return await sock.sendMessage(
                groupJid,
                {
                    text:
`🔊 *Mute-all is already off.*

Non-admin messages are no longer being auto-deleted.`
                },
                {
                    quoted: msg
                }
            );

        }

        delete muteAll[groupJid];

        saveMuteAll(
            muteAll
        );

        return await sock.sendMessage(
            groupJid,
            {
                text:
`🔊 *MUTE ALL DISABLED*

Non-admin members can speak normally again.

👑 Admin messages were never affected.`
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
        senderAliases.some(alias =>
            (
                MAIN_OWNER &&
                normalizeJid(alias) ===
                    normalizeJid(MAIN_OWNER)
            ) ||
            owners.some(owner =>
                normalizeJid(owner) ===
                    normalizeJid(alias)
            )
        );

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
        findParticipantByJid(
            metadata.participants,
            target
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
        senderAliases.some(alias =>
            (
                MAIN_OWNER &&
                normalizeJid(alias) ===
                    normalizeJid(MAIN_OWNER)
            ) ||
            owners.some(owner =>
                normalizeJid(owner) ===
                    normalizeJid(alias)
            )
        );

    // =====================================
    // NOT GROUP ADMIN
    // =====================================
    // FIX: demote can never succeed on a self-target here, since the
    // "target not currently an admin" check further down would always
    // reject it (the sender isn't a group admin in this branch, by
    // definition). Self-demote only makes sense once the sender IS a
    // group admin, so that case now lives in the admin branch below
    // instead. A non-admin sender — owner or not — is simply rejected.

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

    // =====================================
    // GROUP ADMIN
    // =====================================

    else {

        if (!target) {

            // Owner running bare .demote (no tag/reply) while they
            // themselves are a group admin demotes themselves.
            if (senderIsOwner) {

                target = sender;

            } else {

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

        }

        else if (
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
        findParticipantByJid(
            metadata.participants,
            target
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


    // Check if sender is group admin using all Baileys identity aliases.
    const kickSenderAliases =
        messageSenderAliases(
            msg
        );

    const senderAdmin =
        participants.find(
            p =>
                kickSenderAliases.some(
                    alias =>
                        participantMatches(
                            p,
                            alias
                        )
                )
        )?.admin;


    if (!senderAdmin) {
        return reply("❌ You are not an admin.");
    }


    // Check if the bot is admin, accepting either LID or phone-JID identity.
    const botAliases = [
        sock.user?.id,
        sock.user?.lid
    ]
        .filter(Boolean)
        .map(value => {
            const raw =
                String(value);

            if (
                raw.includes(":") &&
                raw.includes("@")
            ) {
                const [
                    left,
                    server
                ] =
                    raw.split("@");

                return `${left.split(":")[0]}@${server}`;
            }

            return raw;
        });

    const botParticipant =
        participants.find(
            p =>
                botAliases.some(
                    alias =>
                        participantMatches(
                            p,
                            alias
                        )
                )
        );

    const botAdmin =
        botParticipant?.admin;


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
    if (
        botParticipant &&
        participantMatches(
            botParticipant,
            target
        )
    ) {
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

        if (/^\.mute\s+all$/i.test(text.trim())) {

            const muteAll =
                loadMuteAll();

            if (muteAll[groupJid]?.enabled) {

                return await sock.sendMessage(
                    groupJid,
                    {
                        text:
`🔇 *Mute-all is already active.*

Every new message from non-admin members is being deleted automatically.

👑 Admins are exempt.`
                    },
                    {
                        quoted: msg
                    }
                );

            }

            muteAll[groupJid] = {
                enabled:
                    true,
                enabledAt:
                    Date.now(),
                enabledBy:
                    sender
            };

            saveMuteAll(
                muteAll
            );

            return await sock.sendMessage(
                groupJid,
                {
                    text:
`🔇 *MUTE ALL ACTIVATED*

From now on, every new message sent by a non-admin member will be deleted automatically.

👑 Group admins are exempt.
🔊 Use *.unmute all* to stop it.`
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

        const durationBody =
            String(text || "")
                .replace(/^\.mute\b/i, "")
                .replace(/@\d+/g, "")
                .trim();

        // Accept both compact and spaced forms:
        // .mute @user 365d
        // .mute @user 365 d
        // reply + .mute 2 hr
        const duration =
            durationBody
                ? durationBody
                    .replace(/\s+/g, "")
                : "";

        const muteMs =
            parseMuteTime(
                duration
            );

        if (
            duration &&
            muteMs === null
        ) {
            return await sock.sendMessage(
                groupJid,
                {
                    text:
                        "⚠️ Invalid mute duration.\n\nExamples:\n.mute @user 30mins\n.mute @user 2hr\n.mute @user 365d"
                },
                {
                    quoted: msg
                }
            );
        }

        const expires =
            Date.now() +
            muteMs;



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