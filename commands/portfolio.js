const fs = require("fs");
const dataPath = require("../lib/dataPath");

const {
    startEmployment,
    getUserHistory,
    getTotalExperienceMonths,
    getJobExperienceMonths,
    formatExperience
} = require("../lib/portfolioHistory");

const { tierForLevel } = require("../lib/tierStar");
const { findEmploymentAnywhere } = require("../lib/jobOffers");
const {
    findMajorEmploymentForUser,
    loadMajorsState
} = require("../lib/majorsState");

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
// LIVE EMPLOYMENT RECONCILIATION
// ============================================================
//
// Portfolio history was introduced after some users were already
// employed. The authoritative employee records already contain hiredAt,
// so recover those older active jobs on demand instead of pretending
// their experience started when .portfolio was added.
//
// This is intentionally idempotent: startEmployment() refuses duplicate
// active records for the same company + position.
//
// If an old employee record has no hiredAt timestamp, we do not invent
// one. The live job still appears as the current status, but historical
// experience cannot be reconstructed accurately without backup data.
//
function syncCurrentEmploymentHistory(userId, users) {

    const playerJob =
        findEmploymentAnywhere(
            users,
            userId
        );

    if (playerJob) {

        const company =
            users[playerJob.ownerId]?.company;

        const employee =
            company?.employees?.[
                playerJob.employeeId
            ];

        const hiredAt =
            Number(employee?.hiredAt) || null;

        if (hiredAt) {

            startEmployment({
                userId,
                companyName:
                    playerJob.companyName,
                position:
                    playerJob.position,
                tier:
                    company?.level !== undefined
                        ? tierForLevel(
                            company.level
                        )
                        : null,
                hiredAt,
                companyType:
                    "player"
            });

        }

        return {
            companyName:
                playerJob.companyName,
            position:
                playerJob.position,
            tier:
                company?.level !== undefined
                    ? tierForLevel(
                        company.level
                    )
                    : null,
            companyType:
                "player",
            hiredAt
        };

    }


    const majorJob =
        findMajorEmploymentForUser(
            userId
        );

    if (majorJob) {

        const state =
            loadMajorsState();

        const employee =
            state[
                majorJob.majorKey
            ]?.employees?.[
                majorJob.employeeId
            ];

        const hiredAt =
            Number(employee?.hiredAt) || null;

        if (hiredAt) {

            startEmployment({
                userId,
                companyName:
                    majorJob.companyName,
                position:
                    majorJob.position,
                tier: null,
                hiredAt,
                companyType:
                    "major"
            });

        }

        return {
            companyName:
                majorJob.companyName,
            position:
                majorJob.position,
            tier: null,
            companyType:
                "major",
            hiredAt
        };

    }


    return null;

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

    // Derive current status from the live employment systems,
    // not from portfolioHistory.json. This prevents stale or missing
    // history from incorrectly showing someone as unemployed/employed.
    const currentJob =
        syncCurrentEmploymentHistory(
            userId,
            users
        );

    // Re-read history after reconciliation because an older live job may
    // have just been backfilled using its original hiredAt timestamp.
    const history =
        getUserHistory(userId);

    const totalExperience =
        getTotalExperienceMonths(userId);


    // ========================================================
    // CURRENT STATUS
    // ========================================================

    let currentStatus;


    // --------------------------------------------------------
    // PLAYER COMPANY OWNER
    // --------------------------------------------------------

    if (user.company) {

        // Owner is not stored as an employee.
        // Their leadership position is derived directly from
        // the company they own.

        const company =
            user.company;

       const companyTier =
    company.level !== undefined
        ? tierForLevel(company.level)
        : "—";
        currentStatus =
`🏢 Company      : ${company.name}
💼 Position     : Managing Director
⭐ Company Tier : ${companyTier}
👑 Status       : Company Owner`;

    }


    // --------------------------------------------------------
    // NORMAL EMPLOYEE
    // --------------------------------------------------------

    else if (currentJob) {

        currentStatus =
`🏢 Company      : ${currentJob.companyName}
💼 Position     : ${titleCase(currentJob.position)}
⭐ Company Tier : ${currentJob.tier ?? "—"}
👤 Status       : Employee`;

    }


    // --------------------------------------------------------
    // UNEMPLOYED
    // --------------------------------------------------------

    else {

        currentStatus =
`🏢 Company      : Unemployed
💼 Position     : —
⭐ Company Tier : —
👤 Status       : Unemployed`;

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