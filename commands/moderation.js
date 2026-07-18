const fs = require("fs");

const MUTED_FILE = "./muted.json";

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

async function moderationWatcher(sock, msg) {

    const groupJid = msg.key.remoteJid;

    if (!groupJid?.endsWith("@g.us")) return;

    const sender =
        msg.key.participant;

    if (!sender) return;

    const muted =
        loadMuted();

    const user =
        muted[groupJid]?.[sender];

    if (!user) return;


    // User's mute has expired
    if (Date.now() >= user.expires) {

        delete muted[groupJid][sender];

        if (
            Object.keys(
                muted[groupJid]
            ).length === 0
        ) {

            delete muted[groupJid];

        }

        saveMuted(muted);

        const tag =
            "@" + sender.split("@")[0];

        const text =
            user.custom
            ?
`${tag}

⏰ Time's up.

You are free to type now. 😌`
            :
`${tag}

😂 The admins forgot you.

You should be grateful Lord Crimson remembered you.

You are free to type now. 😌💙`;

        await sock.sendMessage(
            groupJid,
            {
                text,
                mentions: [sender]
            }
        );

        return;

    }


    // Delete muted user's message
    try {

        await sock.sendMessage(
            groupJid,
            {
                delete: msg.key
            }
        );

    } catch (err) {

        console.log(
            "Delete failed:",
            err.message
        );

    }

}

module.exports = {
    moderationWatcher
};