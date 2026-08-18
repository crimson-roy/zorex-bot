const fs = require("fs");
const dataPath = require("../lib/dataPath");

const {
    getUserHistory,
    getCurrentEmployment,
    getTotalExperienceMonths,
    getJobExperienceMonths,
    formatExperience
} = require("../lib/portfolioHistory");

const USERS_FILE = dataPath("users.json");

const FOOTER =
    "╰━━━━ 🤖 𝙕𝙤𝙧𝙚𝙭 𝘼𝙄 ━━━━╯";

const DIVIDER =
    "────────────────────";

function loadUsers() {

    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, "{}");
    }

    return JSON.parse(
        fs.readFileSync(
            USERS_FILE,
            "utf8"
        )
    );

}


// ============================================================
// HELPERS
// ============================================================

function titleCase(str) {

    return (str || "")
        .split(" ")
        .map(
            word =>
                word.charAt(0).toUpperCase() +
                word.slice(1)
        )
        .join(" ");

}


// Return the first mentioned user from the message.
//
// WhatsApp puts tagged users inside:
// extendedTextMessage.contextInfo.mentionedJid
//
function getMentionedUser(msg) {

    const mentioned =
        msg.message
            ?.extendedTextMessage
            ?.contextInfo
            ?.mentionedJid;

    if (
        !Array.isArray(mentioned) ||
        mentioned.length === 0
    ) {
        return null;
    }

    return mentioned[0];

}


// A company owner is a registered user who currently owns
// a player company.
//
// Major companies are NOT player-owned and therefore do not
// automatically grant this permission.
//
function isCompanyOwner(users, userId) {

    if (!userId) {
        return false;
    }

    const user =
        users[userId];

    return Boolean(
        user &&
        user.company
    );

}


// ============================================================
// BUILD PORTFOLIO
// ============================================================

function buildPortfolio(userId, users) {

    const user =
        users[userId];

    if (!user) {
        return null;
    }


    // ========================================================
    // PERSONAL INFORMATION
    // ========================================================

    const name =
        user.name || "Not set";

    const age =
        user.age || "Not set";

    const bio =
        user.bio || "No bio set.";


    // ========================================================
    // EMPLOYMENT
    // ========================================================

    const currentJob =
        getCurrentEmployment(userId);

    const history =
        getUserHistory(userId);

    const totalExperience =
        getTotalExperienceMonths(userId);


    // ========================================================
    // CURRENT STATUS
    // ========================================================

    let currentStatus;

    if (currentJob) {

        currentStatus =
`🏢 Company      : ${currentJob.companyName}
💼 Position     : ${titleCase(currentJob.position)}
⭐ Company Tier : ${currentJob.tier ?? "—"}`;

    } else {

        currentStatus =
`🏢 Company      : Unemployed
💼 Position     : —
⭐ Company Tier : —`;

    }


    // ========================================================
    // WORK HISTORY
    // ========================================================

    let historyBlock;

    if (history.length === 0) {

        historyBlock =
`📭 No work experience yet.`;

    } else {

        historyBlock =
            history
                .map(job => {

                    const months =
                        getJobExperienceMonths(job);

                    return `• ${job.companyName}
  💼 ${titleCase(job.position)}
  ⏳ ${formatExperience(months)}
  ⭐ Tier ${job.tier ?? "—"}`;

                })
                .join("\n\n");

    }


    // ========================================================
    // FINAL PORTFOLIO
    // ========================================================

    return `╭━━━ 📂 𝙋𝙊𝙍𝙏𝙁𝙊𝙇𝙄𝙊 ━━━╮

👤 𝙉𝙖𝙢𝙚     : ${name}
🎂 𝘼𝙜𝙚      : ${age}

📝 𝘽𝙞𝙤
${DIVIDER}
${bio}

💼 𝘾𝙐𝙍𝙍𝙀𝙉𝙏 𝙎𝙏𝘼𝙏𝙐𝙎
${currentStatus}

📚 𝙒𝙊𝙍𝙆 𝙀𝙓𝙋𝙀𝙍𝙄𝙀𝙉𝘾𝙀
⏳ Total Experience : ${formatExperience(totalExperience)}

🏢 𝙒𝙊𝙍𝙆 𝙃𝙄𝙎𝙏𝙊𝙍𝙔
${historyBlock}

${FOOTER}`;

}


// ============================================================
// .portfolio
// ============================================================

async function portfolioCommand(sock, msg) {

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const users =
        loadUsers();


    // ========================================================
    // CHECK WHETHER A USER WAS TAGGED
    // ========================================================

    const targetUser =
        getMentionedUser(msg);


    // ========================================================
    // .portfolio @user
    // ========================================================

    if (targetUser) {

        // Can't inspect another person's portfolio unless
        // the requester owns a player company.
        if (!isCompanyOwner(users, sender)) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text: `╭━━━ 🔒 𝙋𝙍𝙄𝙑𝘼𝙏𝙀 𝙋𝙊𝙍𝙏𝙁𝙊𝙇𝙄𝙊 ━━━╮

You can only view your own portfolio.

📌 Company owners can view another user's portfolio when reviewing potential employees.

${FOOTER}`
                },
                { quoted: msg }
            );

        }


        // Make sure the tagged person is registered.
        if (!users[targetUser]) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text: `╭━━━ 👤 𝙐𝙎𝙀𝙍 𝙉𝙊𝙏 𝙁𝙊𝙐𝙉𝘿 ━━━╮

That user is not registered with Zorex.

${FOOTER}`
                },
                { quoted: msg }
            );

        }

        const portfolio =
            buildPortfolio(
                targetUser,
                users
            );

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: portfolio
            },
            { quoted: msg }
        );

    }


    // ========================================================
    // .portfolio
    // ========================================================

    if (!users[sender]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `╭━━━ 👤 𝙋𝙊𝙍𝙏𝙁𝙊𝙇𝙄𝙊 ━━━╮

You are not registered yet.

📥 *Register first:*
.register YOUR_NAME

${FOOTER}`
            },
            { quoted: msg }
        );

    }

    const portfolio =
        buildPortfolio(
            sender,
            users
        );

    return await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: portfolio
        },
        { quoted: msg }
    );

}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    portfolioCommand
};