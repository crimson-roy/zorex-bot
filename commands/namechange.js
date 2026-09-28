"use strict";

const fs = require("fs");
const dataPath = require("../lib/dataPath");
const {
    findRegisteredUser,
    updateDisplayName
} = require("../lib/aiUserStore");

const USERS_FILE =
    dataPath("users.json");

function saveUsers(users) {
    const temp =
        `${USERS_FILE}.tmp-${process.pid}-${Date.now()}`;

    fs.writeFileSync(
        temp,
        JSON.stringify(
            users,
            null,
            2
        )
    );

    fs.renameSync(
        temp,
        USERS_FILE
    );
}

function cleanName(value) {
    return String(value || "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

async function nameChangeCommand(
    sock,
    msg,
    text
) {
    const chatId =
        msg.key.remoteJid;

    const registration =
        findRegisteredUser(msg);

    if (
        !registration.userId ||
        !registration.user
    ) {
        return await sock.sendMessage(
            chatId,
            {
                text:
`⚠️ You are not registered.

> \`.register YOUR_NAME\``
            },
            {
                quoted: msg
            }
        );
    }

    const newName =
        cleanName(
            String(text || "")
                .replace(
                    /^\.(?:namechange|changename)\b/i,
                    ""
                )
        );

    if (!newName) {
        return await sock.sendMessage(
            chatId,
            {
                text:
`⚠️ *Name change format*

> \`.namechange NEW_NAME\`

or

> \`.changename NEW_NAME\``
            },
            {
                quoted: msg
            }
        );
    }

    if (
        newName.length < 2 ||
        newName.length > 40
    ) {
        return await sock.sendMessage(
            chatId,
            {
                text:
                    "⚠️ Your Zorex name must be between 2 and 40 characters."
            },
            {
                quoted: msg
            }
        );
    }

    const oldName =
        registration.user.name ||
        "Unknown";

    registration.users[
        registration.userId
    ].name =
        newName;

    saveUsers(
        registration.users
    );

    updateDisplayName(
        registration.userId,
        newName
    );

    return await sock.sendMessage(
        chatId,
        {
            text:
`✅ *Name changed*

> Old: ${oldName}
> New: ${newName}

Your account data stays attached to the same Zorex profile.`
        },
        {
            quoted: msg
        }
    );
}

module.exports = {
    nameChangeCommand
};
