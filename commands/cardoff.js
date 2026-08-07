const { isOwner } =
    require("../lib/ownerCheck");

const {
    isAutoSpawnEnabled,
    setAutoSpawnEnabled
} = require("../lib/spawnManager");

async function execute(
    sock,
    msg,
    args
) {

    const senderId =
        msg.key.participant ||
        msg.key.remoteJid;

    const chatJid =
        msg.key.remoteJid;

    // Owner only
    if (!isOwner(senderId)) {

        return await sock.sendMessage(
            chatJid,
            {
                text:
                    `❌ Only my owners can use this command.`
            },
            { quoted: msg }
        );
    }

    // Group only
    if (!chatJid.endsWith("@g.us")) {

        return await sock.sendMessage(
            chatJid,
            {
                text:
                    `⚠️ This command can only be used inside a group.`
            },
            { quoted: msg }
        );
    }

    const current =
        isAutoSpawnEnabled(chatJid);

    const action =
        (args[0] || "").toLowerCase();

    // .cardoff
    if (
        action === "" ||
        action === "off"
    ) {

        if (!current) {

            return await sock.sendMessage(
                chatJid,
                {
                    text:
`🎴 Automatic card spawning is already OFF.

Manual .spawn commands are still available to owners.`
                },
                { quoted: msg }
            );
        }

        setAutoSpawnEnabled(
            chatJid,
            false
        );

        return await sock.sendMessage(
            chatJid,
            {
                text:
`🛑 Automatic card spawning has been turned OFF for this group.

Cards will no longer auto-spawn from group activity.

👑 Owners can still use .spawn manually.`
            },
            { quoted: msg }
        );
    }

    // .cardon
    if (action === "on") {

        if (current) {

            return await sock.sendMessage(
                chatJid,
                {
                    text:
`✅ Automatic card spawning is already ON.`
                },
                { quoted: msg }
            );
        }

        setAutoSpawnEnabled(
            chatJid,
            true
        );

        return await sock.sendMessage(
            chatJid,
            {
                text:
`🎴 Automatic card spawning has been turned ON.

This group can now receive cards from activity again.`
            },
            { quoted: msg }
        );
    }

    return await sock.sendMessage(
        chatJid,
        {
            text:
`⚠️ Usage:

.cardoff
.cardon`
        },
        { quoted: msg }
    );
}

module.exports = {
    execute
};