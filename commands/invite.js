const fs = require("fs");
const { MAIN_OWNER } = require("../config");

const INVITE_FILE = "./invite.json";

function loadInvite() {

    if (!fs.existsSync(INVITE_FILE)) {

        fs.writeFileSync(
            INVITE_FILE,
            JSON.stringify({
                passcode: "4827",
                pending: {}
            }, null, 4)
        );

    }

    return JSON.parse(
        fs.readFileSync(
            INVITE_FILE,
            "utf8"
        )
    );

}

function saveInvite(invite) {

    fs.writeFileSync(
        INVITE_FILE,
        JSON.stringify(
            invite,
            null,
            4
        )
    );

}

async function inviteCommands(sock, msg, text) {

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const invite =
        loadInvite();

    // STEP 1
    if (text === ".inviteowner") {

        invite.pending[sender] = {

            group: msg.key.remoteJid

        };

        saveInvite(invite);

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`💙 You want to invite Lord Crimson?

Fine...

Tell me the 4-digit invitation code. 🌙

(Reply with only the code.)`
            },
            {
                quoted: msg
            }
        );

    }

    // STEP 2
    if (invite.pending[sender]) {

        if (text !== invite.passcode) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`❌ Incorrect invitation code.

Try again.`
                },
                {
                    quoted: msg
                }
            );

        }

        delete invite.pending[sender];

        saveInvite(invite);

                const groupJid = msg.key.remoteJid;

        try {

            await sock.sendMessage(
                groupJid,
                {
                    text:
`💙 Invitation verified.

Inviting Lord Crimson...`
                },
                {
                    quoted: msg
                }
            );


            const inviteCode = await sock.groupInviteCode(groupJid);

const inviteLink =
`https://chat.whatsapp.com/${inviteCode}`;


await sock.sendMessage(
    MAIN_OWNER,
    {
        text:
`💙 Lord Crimson invitation link created.

Join the group using:

${inviteLink}

Powered by Zorex AI 🤖`,
        linkPreview: false
    }
);

          return await sock.sendMessage(
    groupJid,
    {
        text:
`💙 Lord Crimson's invitation has been prepared.

I tried bringing him here myself... 😤

But he is too anonymous.

I have sent him a private invitation link instead. 😌✨`
    },
    {
        quoted: msg
    }
);


        } catch (err) {

            console.log(err);


            return await sock.sendMessage(
    groupJid,
    {
        text:
`❌ Invite failed.

Error:
${err.message}`
    },
    {
        quoted: msg
    }
);

        }

    }

}


module.exports = {
    inviteCommands
};