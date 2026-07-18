const fs = require("fs");

const WCG_FILE = "./wcg.json";

function loadWCG() {
    if (!fs.existsSync(WCG_FILE)) {
        fs.writeFileSync(WCG_FILE, "{}");
    }

    return JSON.parse(fs.readFileSync(WCG_FILE, "utf8"));
}

function saveWCG(data) {
    fs.writeFileSync(
        WCG_FILE,
        JSON.stringify(data, null, 4)
    );
}

async function startWCG(sock, msg) {

    if (!msg.key.remoteJid.endsWith("@g.us")) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ World Chain Game can only be started inside a group.`
            },
            {
                quoted: msg
            }
        );

    }

    const userId =
    msg.key.participant || msg.key.remoteJid;

    const wcg = loadWCG();

    if (
        wcg[msg.key.remoteJid] &&
        (
            wcg[msg.key.remoteJid].status === "waiting" ||
            wcg[msg.key.remoteJid].status === "active"
        )
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ A World Chain Game is already running.

Use:

.wcg join`
            },
            {
                quoted: msg
            }
        );

    }

    const group =
    await sock.groupMetadata(
        msg.key.remoteJid
    );

    const everyone =
    group.participants.map(
        member => member.id
    );

    wcg[msg.key.remoteJid] = {

        status: "waiting",

        host: userId,

        players: [
            userId
        ],

        group: msg.key.remoteJid,

        createdAt: Date.now()

    };

    saveWCG(wcg);

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🌍🎮 *ZOREX WORLD CHAIN GAME STARTED!*

👑 Host:
@${userId.split("@")[0]}

Everyone is invited!

Type:

.wcg join

to participate.

⏳ Joining closes in 60 seconds.`,
            mentions: everyone
        },
        {
            quoted: msg
        }
    );

}

module.exports = {
    loadWCG,
    saveWCG,
    startWCG
};