const fs = require("fs");
const dataPath = require("../lib/dataPath");

// Public/employee-facing job commands — .joboffers, .jobapply, .job, .duty.
//
// Player-company employment remains intact.
// Major employment (Nova Empire, Elegance, Chez Adélu) is layered on top
// through lib/majorsState.js and does NOT use users[x].company.

const { getIndustry, positionRate, getMaxSlots } = require("../lib/industries");
const { getDutyFlavor } = require("../lib/dutyFlavor");
const { tierForLevel } = require("../lib/tierStar");

const {
    findOfferById,
    listOpenOffers,
    findEmploymentAnywhere
} = require("../lib/jobOffers");

const {
    incomeAtLevel,
    formatDuration,
    PAYOUT_INTERVAL_MS,
    wasOnDutyDuring,
    DUTY_COOLDOWN_MS,
    DUTY_DAILY_CAP,
    DUTY_LOG_RETENTION_MS,
    DUTY_WEEKLY_BONUS_THRESHOLD,
    DUTY_WEEKLY_BONUS_WINDOW_MS
} = require("./company");

// ---------- Major employment state ----------

const {
    listMajorOpenOffers,
    findMajorOfferById,
    findMajorEmploymentForUser,
    findPendingMajorApplication,
    startMajorApplication,
    resolveMajorApplication,
    collectPendingMajorIncome,
    listAllPendingApplications,
    loadMajorsState,
    saveMajorsState,
    scanMajorAttendance,
    markAttendanceWarned,
    removeMajorEmployee
} = require("../lib/majorsState");

const {
    MAJORS,
    getMajor,
    majorPositionRate,
    MAJOR_APPLICATION_DELAY_MS,
    MAJOR_ATTENDANCE_CHECK_INTERVAL_MS
} = require("../lib/majors");

const USERS_FILE = dataPath("users.json");

function loadUsers() {

    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, "{}");
    }

    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));

}

function saveUsers(users) {

    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify(users, null, 4),
        "utf8"
    );

}

// ---------- Shared Zorex visual system ----------

const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━";
const FOOTER = "╰━━━━ 🤖 𝙕𝙤𝙧𝙚𝙭 𝘼𝙄 ━━━━╯";

function errorBox(title, message, examples) {

    const exampleLines = examples
        .map(e => `  📥 ${e}`)
        .join("\n");

    return `╭━━━ ⚠️ ${title} ━━━╮

${message}

  ─── 📝 𝙀𝙓𝘼𝙈𝙋𝙇𝙀 ───
${exampleLines}

${FOOTER}`;

}

function noticeBox(emoji, title, message) {

    return `╭━━━ ${emoji} ${title} ━━━╮

${message}

${FOOTER}`;

}

function titleCase(str) {

    return (str || "")
        .split(" ")
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

}


// ============================================================
// MAJOR APPLICATION RESOLUTION
// ============================================================

// Fires the 30-second application roll.
//
// The application itself is persisted in majors.json by
// startMajorApplication(). This timer only handles the live process.
//
// If the bot restarts before the timer fires, resumeMajorApplications()
// picks the application back up from majors.json.

function scheduleMajorResolution(sock, majorKey, userId, delayMs) {

    setTimeout(() => {
        deliverMajorResolution(sock, majorKey, userId);
    }, delayMs);

}

async function deliverMajorResolution(sock, majorKey, userId) {

    const result = resolveMajorApplication(
        majorKey,
        userId
    );

    if (!result) return;

    const jid = result.jid || userId;

    if (result.accepted) {

        await sock.sendMessage(jid, {
            text: noticeBox(
                "🎉",
                "𝙃𝙄𝙍𝙀𝘿!",
                `Congratulations — *${result.major.name}* has accepted your application!

💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(result.positionKey)}
🔑 𝘾𝙤𝙙𝙚      : ${result.code}

Run .job to see your new position.`
            ),
            mentions: [userId]
        });

        return;
    }

    const reasonText = result.reason === "filled"
        ? `*${result.major.name}* filled that position while your application was pending.`
        : `*${result.major.name}* went with other candidates this time.`;

    await sock.sendMessage(jid, {
        text: noticeBox(
            "😔",
            "𝙉𝙊𝙏 𝙎𝙐𝘾𝘾𝙀𝙎𝙎𝙁𝙐𝙇",
            `${reasonText}

📥 Check .joboffers for other openings.`
        ),
        mentions: [userId]
    });

}


// Resume applications that survived a restart.
//
// Anything whose resolveAt has already passed resolves immediately.
// Anything still waiting gets a new timer for the remaining time.

function resumeMajorApplications(sock) {

    const pending = listAllPendingApplications();
    const now = Date.now();

    for (const p of pending) {

        const remaining = p.resolveAt - now;

        if (remaining <= 0) {

            deliverMajorResolution(
                sock,
                p.majorKey,
                p.userId
            );

        } else {

            setTimeout(
                () => deliverMajorResolution(
                    sock,
                    p.majorKey,
                    p.userId
                ),
                remaining
            );

        }

    }

}


// ============================================================
// MAJOR ATTENDANCE MONITOR
// ============================================================

// 2 days idle -> PR warning
// 3 days idle -> automatic firing
//
// Only majors are affected here.
// Player-company employees are untouched.

async function runMajorAttendanceCheck(sock) {

    const actions = scanMajorAttendance();

    if (actions.length === 0) {
        return;
    }

    for (const action of actions) {

        const major = getMajor(action.majorKey);

        if (!major) {
            continue;
        }

        if (action.type === "warn") {

            // Mark first so a repeated sweep doesn't send the same
            // warning over and over during the same idle streak.
            markAttendanceWarned(
                action.majorKey,
                action.employeeId,
                Date.now()
            );

            await sock.sendMessage(
                action.userId,
                {
                    text: noticeBox(
                        "📩",
                        `${major.name.toUpperCase()} — 𝙋𝙍 𝙏𝙀𝘼𝙈`,
                        `Hi — this is the PR team at *${major.name}*. We noticed you haven't checked in for a couple of days.

Is everything okay? Please run *.duty* by tomorrow to confirm you're still with us — if we don't hear from you, your position will be given up.`
                    )
                }
            );

            continue;
        }

        if (action.type === "fire") {

            const removed = removeMajorEmployee(
                action.majorKey,
                action.employeeId
            );

            if (!removed) {
                continue;
            }

            await sock.sendMessage(
                action.userId,
                {
                    text: noticeBox(
                        "📪",
                        `${major.name.toUpperCase()} — 𝙋𝙍 𝙏𝙀𝘼𝙈`,
                        `Hi — this is the PR team at *${major.name}*. Since we didn't hear back from you, your position as *${titleCase(action.position)}* has been given up as of today.

You're welcome to reapply anytime via .joboffers.`
                    )
                }
            );

        }

    }

}


// Starts the periodic major attendance sweep.
//
// The immediate check is important so employees who crossed the
// threshold while the bot was offline don't have to wait for the
// first 30-minute interval.

function startMajorAttendanceMonitor(sock) {

    runMajorAttendanceCheck(sock);

    setInterval(
        () => runMajorAttendanceCheck(sock),
        MAJOR_ATTENDANCE_CHECK_INTERVAL_MS
    );

}


// ============================================================
// .joboffers
// ============================================================

async function jobOffersCommand(sock, msg) {

    const users = loadUsers();

    // Existing player-company offers.
    const offers = listOpenOffers(users);

    // New Major offers.
    const majorOffers = listMajorOpenOffers();

    if (
        offers.length === 0 &&
        majorOffers.length === 0
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `╭━━━ 📢 𝙊𝙋𝙀𝙉 𝙅𝙊𝘽 𝙊𝙁𝙁𝙀𝙍𝙎 ━━━╮

📭 *𝙉𝙊 𝙊𝙋𝙀𝙉 𝙋𝙊𝙎𝙄𝙏𝙄𝙊𝙉𝙎*

There are currently no available jobs.
Check back later for new opportunities!

${FOOTER}`
            },
            { quoted: msg }
        );

    }

    // ---------- Major offers ----------

    const majorLines = majorOffers.map(o => {

        const rate = majorPositionRate(
            o.majorKey,
            o.positionKey
        );

        const amount = Math.round(
            o.major.income * (rate / 100)
        );

        return `🏢 *[ 𝙊𝙁𝙁𝙀𝙍 #${o.offerId} ]* — 𝙈𝘼𝙅𝙊𝙍
💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(o.positionKey)}
🏢 𝘾𝙤𝙢𝙥𝙖𝙣𝙮  : *${o.major.name}*
👥 𝙎𝙡𝙤𝙩𝙨    : ${o.filledCount}/${o.maxSlots}
💰 𝙋𝙖𝙮      : ~${amount.toLocaleString()} 🌙/payout`;

    });

    // ---------- Player-company offers ----------
    //
    // This is the original player-company salary calculation.

    const offerLines = offers.map(o => {

        const rate = positionRate(
            o.industry,
            o.positionKey
        );

        const amount = Math.round(
            incomeAtLevel(o.level) * (rate / 100)
        );

        const maxSlots = getMaxSlots(
            o.industry,
            o.positionKey
        );

        const filledCount = Object.values(
            o.company.employees || {}
        ).filter(
            e => e.position === o.positionKey
        ).length;

        return `📋 *[ 𝙊𝙁𝙁𝙀𝙍 #${o.offer.id} ]*
💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(o.positionKey)}
🏢 𝘾𝙤𝙢𝙥𝙖𝙣𝙮  : *${o.companyName}*
👥 𝙎𝙡𝙤𝙩𝙨    : ${filledCount}/${maxSlots}
💰 𝙋𝙖𝙮      : ~${amount.toLocaleString()} 🌙/payout`;

    });

    const lines = [
        ...majorLines,
        ...offerLines
    ];

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `╭━━━ 📢 𝙊𝙋𝙀𝙉 𝙅𝙊𝘽 𝙊𝙁𝙁𝙀𝙍𝙎 ━━━╮

${lines.join(`\n\n${DIVIDER}\n\n`)}

${DIVIDER}
💡 *𝙃𝙊𝙒 𝙏𝙊 𝘼𝙋𝙋𝙇𝙔*

📥 .jobapply <offer number>
👉 Example: .jobapply 1

${FOOTER}`
        },
        { quoted: msg }
    );

}


// ============================================================
// .jobapply
// ============================================================

async function jobApplyCommand(sock, msg, text) {

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const users = loadUsers();

    if (!users[sender]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "👤",
                    "𝙉𝙊𝙏 𝙍𝙀𝙂𝙄𝙎𝙏𝙀𝙍𝙀𝘿",
                    "Please register first.\n\n📥 .register YOUR_NAME"
                )
            },
            { quoted: msg }
        );

    }

    const idArg = text
        .replace(".jobapply", "")
        .trim();

    const offerId = Number(idArg);

    if (!idArg || isNaN(offerId)) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: errorBox(
                    "𝙅𝙊𝘽 𝘼𝙋𝙋𝙇𝙔",
                    "Enter the offer number from .joboffers.",
                    [".jobapply 12"]
                )
            },
            { quoted: msg }
        );

    }


    // ========================================================
    // MAJOR OFFER BRANCH
    // ========================================================

    const majorOffer = findMajorOfferById(offerId);

    if (majorOffer) {

        // A person cannot simultaneously work for a player company
        // and a Major.
        const existingJob =
            findEmploymentAnywhere(users, sender) ||
            findMajorEmploymentForUser(sender);

        if (existingJob) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text: noticeBox(
                        "⚠️",
                        "𝘼𝙇𝙍𝙀𝘼𝘿𝙔 𝙀𝙈𝙋𝙇𝙊𝙔𝙀𝘿",
                        `💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(existingJob.position)}
🏢 𝘾𝙤𝙢𝙥𝙖𝙣𝙮  : ${existingJob.companyName}

You're already working there.`
                    )
                },
                { quoted: msg }
            );

        }

        // One pending Major application per person.
        const pendingMajor =
            findPendingMajorApplication(sender);

        if (pendingMajor) {

            const pendingMajorData =
                getMajor(pendingMajor.majorKey);

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text: noticeBox(
                        "⏳",
                        "𝘼𝙋𝙋𝙇𝙄𝘾𝘼𝙏𝙄𝙊𝙉 𝙋𝙀𝙉𝘿𝙄𝙉𝙂",
                        `You already have an application in with *${pendingMajorData.name}* — you'll hear back shortly.`
                    )
                },
                { quoted: msg }
            );

        }

        // Re-check the slot before starting the timer.
        if (
            majorOffer.filledCount >=
            majorOffer.maxSlots
        ) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text: noticeBox(
                        "⚠️",
                        "𝙋𝙊𝙎𝙄𝙏𝙄𝙊𝙉 𝙁𝙐𝙇𝙇",
                        `💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(majorOffer.positionKey)}
🏢 𝘾𝙤𝙢𝙥𝙖𝙣𝙮  : ${majorOffer.major.name}

Already fully staffed — check .joboffers for other openings.`
                    )
                },
                { quoted: msg }
            );

        }

        // Persist the pending application FIRST.
        startMajorApplication(
            majorOffer.majorKey,
            sender,
            majorOffer.positionKey,
            msg.key.remoteJid
        );

        // Then schedule the actual resolution.
        scheduleMajorResolution(
            sock,
            majorOffer.majorKey,
            sender,
            MAJOR_APPLICATION_DELAY_MS
        );

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "📨",
                    "𝘼𝙋𝙋𝙇𝙄𝘾𝘼𝙏𝙄𝙊𝙉 𝙎𝙐𝘽𝙈𝙄𝙏𝙏𝙀𝘿",
                    `💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(majorOffer.positionKey)}
🏢 𝘾𝙤𝙢𝙥𝙖𝙣𝙮  : ${majorOffer.major.name}

${majorOffer.major.name} is reviewing your application — you'll hear back in about 30 seconds.`
                )
            },
            { quoted: msg }
        );

    }


    // ========================================================
    // ORIGINAL PLAYER-COMPANY LOGIC
    // ========================================================

    const found = findOfferById(
        users,
        offerId
    );

    if (!found) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "📭",
                    "𝙊𝙁𝙁𝙀𝙍 𝘾𝙇𝙊𝙎𝙀𝘿",
                    `Offer #${offerId} isn't open anymore.

📥 Check .joboffers for current listings.`
                )
            },
            { quoted: msg }
        );

    }

    if (found.ownerId === sender) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "⚠️",
                    "𝙊𝙒𝙉 𝘾𝙊𝙈𝙋𝘼𝙉𝙔",
                    "You can't apply to your own company."
                )
            },
            { quoted: msg }
        );

    }

    const existingJob =
        findEmploymentAnywhere(
            users,
            sender
        );

    if (existingJob) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "⚠️",
                    "𝘼𝙇𝙍𝙀𝘼𝘿𝙔 𝙀𝙈𝙋𝙇𝙊𝙔𝙀𝘿",
                    `💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(existingJob.position)}
🏢 𝘾𝙤𝙢𝙥𝙖𝙣𝙮  : ${existingJob.companyName}

You're already working there.`
                )
            },
            { quoted: msg }
        );

    }

    const alreadyApplied =
        found.offer.pending.some(
            p => p.userId === sender
        );

    if (alreadyApplied) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "⏳",
                    "𝘼𝙇𝙍𝙀𝘼𝘿𝙔 𝘼𝙋𝙋𝙇𝙄𝙀𝘿",
                    "You've already applied for that position — waiting on the owner's review."
                )
            },
            { quoted: msg }
        );

    }

    const maxSlots = getMaxSlots(
        found.company.industry,
        found.positionKey
    );

    const filledCount =
        Object.values(
            found.company.employees || {}
        ).filter(
            e => e.position === found.positionKey
        ).length;

    if (filledCount >= maxSlots) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "⚠️",
                    "𝙋𝙊𝙎𝙄𝙏𝙄𝙊𝙉 𝙁𝙐𝙇𝙇",
                    `💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(found.positionKey)}
🏢 𝘾𝙤𝙢𝙥𝙖𝙣𝙮  : ${found.company.name}
👥 𝙎𝙡𝙤𝙩𝙨    : ${filledCount}/${maxSlots}

Already fully staffed — check .joboffers for other openings.`
                )
            },
            { quoted: msg }
        );

    }

    found.offer.pending.push({
        userId: sender,
        appliedAt: Date.now()
    });

    saveUsers(users);

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: noticeBox(
                "✅",
                "𝘼𝙋𝙋𝙇𝙄𝘾𝘼𝙏𝙄𝙊𝙉 𝙎𝙀𝙉𝙏",
                `💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(found.positionKey)}
🏢 𝘾𝙤𝙢𝙥𝙖𝙣𝙮  : ${found.company.name}

The owner will review it via .companyoffers.`
            )
        },
        { quoted: msg }
    );

}


// ============================================================
// .job
// ============================================================

async function jobCommand(sock, msg) {

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const users = loadUsers();

    if (!users[sender]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "👤",
                    "𝙉𝙊𝙏 𝙍𝙀𝙂𝙄𝙎𝙏𝙀𝙍𝙀𝘿",
                    "Please register first.\n\n📥 .register YOUR_NAME"
                )
            },
            { quoted: msg }
        );

    }

    // Check both employment systems.
    const job =
        findEmploymentAnywhere(users, sender) ||
        findMajorEmploymentForUser(sender);

    if (!job) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "📭",
                    "𝙉𝙊 𝙅𝙊𝘽",
                    "You don't currently have a job.\n\n📥 Browse open positions with .joboffers."
                )
            },
            { quoted: msg }
        );

    }


    // ========================================================
    // MAJOR EMPLOYEE
    // ========================================================

    if (job.isMajor) {

        // Settle any completed Major payout periods first.
        collectPendingMajorIncome(
            users,
            job.majorKey,
            PAYOUT_INTERVAL_MS,
            wasOnDutyDuring
        );

        // collectPendingMajorIncome() saves majors.json itself.
        saveUsers(users);

        const state = loadMajorsState();
        const bucket = state[job.majorKey];

        if (
            !bucket ||
            !bucket.employees ||
            !bucket.employees[job.employeeId]
        ) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text: noticeBox(
                        "⚠️",
                        "𝙅𝙊𝘽 𝙉𝙊 𝙇𝙊𝙉𝙂𝙀𝙍 𝘼𝙑𝘼𝙄𝙇𝘼𝘽𝙇𝙀",
                        "Your Major employment record could not be found. Please check .joboffers."
                    )
                },
                { quoted: msg }
            );

        }

        const employee =
            bucket.employees[job.employeeId];

        const major =
            getMajor(job.majorKey);

        const rate =
            majorPositionRate(
                job.majorKey,
                job.position
            );

        const amount =
            Math.round(
                major.income * (rate / 100)
            );

        const timeLeft =
            formatDuration(
                bucket.lastPayout +
                PAYOUT_INTERVAL_MS -
                Date.now()
            );

        const onDutyThisPeriod =
            wasOnDutyDuring(
                employee,
                bucket.lastPayout,
                bucket.lastPayout +
                PAYOUT_INTERVAL_MS
            );

        const dutyLog =
            employee.dutyLog || [];

        const now = Date.now();

        const weeklyCount =
            dutyLog.filter(
                ts =>
                    ts >=
                    now -
                    DUTY_WEEKLY_BONUS_WINDOW_MS
            ).length;

        const statusLine =
            onDutyThisPeriod
                ? "✅ checked in this period — you'll get paid"
                : "❌ no .duty yet this period — you'll forfeit this payout";

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `╭━━━ 💼 𝙔𝙊𝙐𝙍 𝙅𝙊𝘽 ━━━╮

🏢 𝘾𝙤𝙢𝙥𝙖𝙣𝙮  : ${job.companyName} (Major)
💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(job.position)}
💰 𝙎𝙖𝙡𝙖𝙧𝙮   : ~${amount.toLocaleString()} 🌙/payout
⏱️ 𝙋𝙖𝙮𝙤𝙪𝙩   : in ${timeLeft}
✅ 𝙎𝙩𝙖𝙩𝙪𝙨   : ${statusLine}
📊 𝙒𝙚𝙚𝙠𝙡𝙮   : ${weeklyCount}/${DUTY_WEEKLY_BONUS_THRESHOLD} check-ins toward the weekly bonus

${DIVIDER}
📥 Run .duty to check in and get paid this cycle.

${FOOTER}`
            },
            { quoted: msg }
        );

    }


    // ========================================================
    // ORIGINAL PLAYER-COMPANY JOB VIEW
    // ========================================================

    const company =
        users[job.ownerId].company;

    const employee =
        company.employees[job.employeeId];

    const rate =
        positionRate(
            company.industry,
            job.position
        );

    const amount =
        Math.round(
            incomeAtLevel(company.level) *
            (rate / 100)
        );

    const timeLeft =
        formatDuration(
            company.lastPayout +
            PAYOUT_INTERVAL_MS -
            Date.now()
        );

    const onDutyThisPeriod =
        wasOnDutyDuring(
            employee,
            company.lastPayout,
            company.lastPayout +
            PAYOUT_INTERVAL_MS
        );

    const dutyLog =
        employee.dutyLog || [];

    const now = Date.now();

    const weeklyCount =
        dutyLog.filter(
            ts =>
                ts >=
                now -
                DUTY_WEEKLY_BONUS_WINDOW_MS
        ).length;

    const statusLine =
        onDutyThisPeriod
            ? "✅ checked in this period — you'll get paid"
            : "❌ no .duty yet this period — you'll forfeit this payout";

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `╭━━━ 💼 𝙔𝙊𝙐𝙍 𝙅𝙊𝘽 ━━━╮

🏢 𝘾𝙤𝙢𝙥𝙖𝙣𝙮  : ${job.companyName}
💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(job.position)}
💰 𝙎𝙖𝙡𝙖𝙧𝙮   : ~${amount.toLocaleString()} 🌙/payout
⏱️ 𝙋𝙖𝙮𝙤𝙪𝙩   : in ${timeLeft}
✅ 𝙎𝙩𝙖𝙩𝙪𝙨   : ${statusLine}
📊 𝙒𝙚𝙚𝙠𝙡𝙮   : ${weeklyCount}/${DUTY_WEEKLY_BONUS_THRESHOLD} check-ins toward the weekly bonus

${DIVIDER}
📥 Run .duty to check in and get paid this cycle.

${FOOTER}`
        },
        { quoted: msg }
    );

}


// ============================================================
// .duty
// ============================================================

async function dutyCommand(sock, msg) {

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const users = loadUsers();

    if (!users[sender]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "👤",
                    "𝙉𝙊𝙏 𝙍𝙀𝙂𝙄𝙎𝙏𝙀𝙍𝙀𝘿",
                    "Please register first.\n\n📥 .register YOUR_NAME"
                )
            },
            { quoted: msg }
        );

    }

    // Check both systems.
    const job =
        findEmploymentAnywhere(users, sender) ||
        findMajorEmploymentForUser(sender);

    if (!job) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "📭",
                    "𝙉𝙊 𝙅𝙊𝘽",
                    "You don't have a job to report duty for.\n\n📥 Browse open positions with .joboffers."
                )
            },
            { quoted: msg }
        );

    }

    // Major employees use their own employee record.
    if (job.isMajor) {

        return await majorDutyCheckIn(
            sock,
            msg,
            sender,
            users,
            job
        );

    }


    // ========================================================
    // ORIGINAL PLAYER-COMPANY DUTY LOGIC
    // ========================================================

    const company =
        users[job.ownerId].company;

    const employee =
        company.employees[job.employeeId];

    const now = Date.now();

    let dutyLog =
        (employee.dutyLog || [])
            .filter(
                ts =>
                    ts >=
                    now -
                    DUTY_LOG_RETENTION_MS
            );

    const lastCheckIn =
        dutyLog.length
            ? dutyLog[dutyLog.length - 1]
            : null;

    if (
        lastCheckIn &&
        now - lastCheckIn <
        DUTY_COOLDOWN_MS
    ) {

        const wait =
            formatDuration(
                lastCheckIn +
                DUTY_COOLDOWN_MS -
                now
            );

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "⏳",
                    "𝙊𝙉 𝘾𝙊𝙊𝙇𝘿𝙊𝙒𝙉",
                    `You're still on cooldown — try again in ${wait}.`
                )
            },
            { quoted: msg }
        );

    }

    const last24h =
        dutyLog.filter(
            ts =>
                ts >=
                now -
                (24 * 60 * 60 * 1000)
        );

    if (
        last24h.length >=
        DUTY_DAILY_CAP
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "⚠️",
                    "𝘿𝘼𝙄𝙇𝙔 𝙇𝙄𝙈𝙄𝙏 𝙍𝙀𝘼𝘾𝙃𝙀𝘿",
                    `You've already checked in ${DUTY_DAILY_CAP} times in the last 24h — that's the daily limit. Come back later.`
                )
            },
            { quoted: msg }
        );

    }

    dutyLog.push(now);

    employee.dutyLog =
        dutyLog;

    const weeklyCount =
        dutyLog.filter(
            ts =>
                ts >=
                now -
                DUTY_WEEKLY_BONUS_WINDOW_MS
        ).length;

    const rate =
        positionRate(
            company.industry,
            employee.position
        );

    const periodAmount =
        Math.round(
            incomeAtLevel(company.level) *
            (rate / 100)
        );

    let bonusLine = "";

    const bonusEligible =
        weeklyCount >=
        DUTY_WEEKLY_BONUS_THRESHOLD &&
        (
            !employee.lastBonusAt ||
            now -
            employee.lastBonusAt >=
            DUTY_WEEKLY_BONUS_WINDOW_MS
        );

    if (bonusEligible) {

        users[sender].wallet =
            (users[sender].wallet || 0) +
            periodAmount;

        employee.lastBonusAt =
            now;

        bonusLine =
            `\n\n🎉 *𝙒𝙀𝙀𝙆𝙇𝙔 𝘽𝙊𝙉𝙐𝙎!* ${DUTY_WEEKLY_BONUS_THRESHOLD}+ check-ins this week — ${periodAmount.toLocaleString()} 🌙 bonus credited to your wallet!`;

    }

    saveUsers(users);

    const flavor =
        getDutyFlavor(
            employee.position
        );

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `╭━━━ ✅ 𝘿𝙐𝙏𝙔 𝘾𝙃𝙀𝘾𝙆𝙀𝘿 𝙄𝙉 ━━━╮

💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(employee.position)}
📋 ${flavor}

📊 𝙏𝙤𝙙𝙖𝙮    : ${last24h.length + 1}/${DUTY_DAILY_CAP} check-ins
📈 𝙏𝙝𝙞𝙨 𝙬𝙚𝙚𝙠: ${weeklyCount}/${DUTY_WEEKLY_BONUS_THRESHOLD} toward the bonus${bonusLine}

${FOOTER}`
        },
        { quoted: msg }
    );

}


// ============================================================
// MAJOR .duty
// ============================================================

async function majorDutyCheckIn(
    sock,
    msg,
    sender,
    users,
    job
) {

    const state =
        loadMajorsState();

    const bucket =
        state[job.majorKey];

    if (
        !bucket ||
        !bucket.employees ||
        !bucket.employees[job.employeeId]
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "⚠️",
                    "𝙅𝙊𝘽 𝙉𝙊𝙏 𝙁𝙊𝙐𝙉𝘿",
                    "Your Major employment record could not be found."
                )
            },
            { quoted: msg }
        );

    }

    const employee =
        bucket.employees[job.employeeId];

    const now =
        Date.now();

    let dutyLog =
        (employee.dutyLog || [])
            .filter(
                ts =>
                    ts >=
                    now -
                    DUTY_LOG_RETENTION_MS
            );

    const lastCheckIn =
        dutyLog.length
            ? dutyLog[dutyLog.length - 1]
            : null;

    if (
        lastCheckIn &&
        now - lastCheckIn <
        DUTY_COOLDOWN_MS
    ) {

        const wait =
            formatDuration(
                lastCheckIn +
                DUTY_COOLDOWN_MS -
                now
            );

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "⏳",
                    "𝙊𝙉 𝘾𝙊𝙊𝙇𝘿𝙊𝙒𝙉",
                    `You're still on cooldown — try again in ${wait}.`
                )
            },
            { quoted: msg }
        );

    }

    const last24h =
        dutyLog.filter(
            ts =>
                ts >=
                now -
                (24 * 60 * 60 * 1000)
        );

    if (
        last24h.length >=
        DUTY_DAILY_CAP
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "⚠️",
                    "𝘿𝘼𝙄𝙇𝙔 𝙇𝙄𝙈𝙄𝙏 𝙍𝙀𝘼𝘾𝙃𝙀𝘿",
                    `You've already checked in ${DUTY_DAILY_CAP} times in the last 24h — that's the daily limit. Come back later.`
                )
            },
            { quoted: msg }
        );

    }

    dutyLog.push(now);

    employee.dutyLog =
        dutyLog;

    const weeklyCount =
        dutyLog.filter(
            ts =>
                ts >=
                now -
                DUTY_WEEKLY_BONUS_WINDOW_MS
        ).length;

    const major =
        getMajor(job.majorKey);

    const rate =
        majorPositionRate(
            job.majorKey,
            employee.position
        );

    const periodAmount =
        Math.round(
            major.income *
            (rate / 100)
        );

    let bonusLine = "";

    const bonusEligible =
        weeklyCount >=
        DUTY_WEEKLY_BONUS_THRESHOLD &&
        (
            !employee.lastBonusAt ||
            now -
            employee.lastBonusAt >=
            DUTY_WEEKLY_BONUS_WINDOW_MS
        );

    if (bonusEligible) {

        users[sender].wallet =
            (users[sender].wallet || 0) +
            periodAmount;

        employee.lastBonusAt =
            now;

        bonusLine =
            `\n\n🎉 *𝙒𝙀𝙀𝙆𝙇𝙔 𝘽𝙊𝙉𝙐𝙎!* ${DUTY_WEEKLY_BONUS_THRESHOLD}+ check-ins this week — ${periodAmount.toLocaleString()} 🌙 bonus credited to your wallet!`;

    }

    saveMajorsState(state);
    saveUsers(users);

    const flavor =
        getDutyFlavor(
            employee.position
        );

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `╭━━━ ✅ 𝘿𝙐𝙏𝙔 𝘾𝙃𝙀𝘾𝙆𝙀𝘿 𝙄𝙉 ━━━╮

💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(employee.position)}
📋 ${flavor}

📊 𝙏𝙤𝙙𝙖𝙮    : ${last24h.length + 1}/${DUTY_DAILY_CAP} check-ins
📈 𝙏𝙝𝙞𝙨 𝙬𝙚𝙚𝙠: ${weeklyCount}/${DUTY_WEEKLY_BONUS_THRESHOLD} toward the bonus${bonusLine}

${FOOTER}`
        },
        { quoted: msg }
    );

}


// ==============================================inde==============
// .jobinfo
// ============================================================

async function jobInfoCommand(
    sock,
    msg,
    text
) {

    const query =
        text.replace(".jobinfo", "").trim();

    if (!query) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: errorBox(
                    "𝙅𝙊𝘽 𝙄𝙉𝙁𝙊",
                    "Enter a company name.",
                    [".jobinfo Roy Trading Group"]
                )
            },
            { quoted: msg }
        );

    }

    const users =
        loadUsers();

    const q =
        query.toLowerCase();


    // ========================================================
    // MAJOR LOOKUP
    // ========================================================

    // Major keys are used for persistent state.
    // We first check exact key/name matches.

    let majorMatch = null;
    let majorKey = null;

    for (const key of Object.keys(MAJORS)) {

        const major =
            getMajor(key);

        if (!major) continue;

        if (
            key.toLowerCase() === q ||
            major.name.toLowerCase() === q
        ) {

            majorMatch = major;
            majorKey = key;
            break;

        }

    }

    // Also allow a unique substring match for majors.
    if (!majorMatch) {

        const majorMatches =
            Object.keys(MAJORS)
                .map(key => ({
                    key,
                    major: getMajor(key)
                }))
                .filter(({ key, major }) =>
                    key.toLowerCase().includes(q) ||
                    major.name.toLowerCase().includes(q)
                );

        if (majorMatches.length === 1) {

            majorKey =
                majorMatches[0].key;

            majorMatch =
                majorMatches[0].major;

        }

        if (majorMatches.length > 1) {

            const names =
                majorMatches
                    .map(
                        ({ major }) =>
                            `👉 ${major.name}`
                    )
                    .join("\n");

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text: noticeBox(
                        "⚠️",
                        "𝙈𝙐𝙇𝙏𝙄𝙋𝙇𝙀 𝙈𝘼𝙏𝘾𝙃𝙀𝙎",
                        `"${query}" matches more than one Major — be more specific:

${names}`
                    )
                },
                { quoted: msg }
            );

        }

    }


    // ========================================================
    // MAJOR INFO CARD
    // ========================================================

    if (majorMatch) {

        const industry =
            majorMatch.industry
                ? getIndustry(majorMatch.industry)
                : null;

        const majorOpen =
            listMajorOpenOffers()
                .filter(
                    o => o.majorKey === majorKey
                );

        const openLines =
            majorOpen.map(o => {

                const rate =
                    majorPositionRate(
                        o.majorKey,
                        o.positionKey
                    );

                const amount =
                    Math.round(
                        o.major.income *
                        (rate / 100)
                    );

                return `📋 *[ 𝙊𝙁𝙁𝙀𝙍 #${o.offerId} ]*
💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(o.positionKey)}
👥 𝙎𝙡𝙤𝙩𝙨    : ${o.filledCount}/${o.maxSlots}
💰 𝙋𝙖𝙮      : ~${amount.toLocaleString()} 🌙/payout`;

            });

        const openBlock =
            openLines.length
                ? openLines.join(
                    `\n\n${DIVIDER}\n\n`
                )
                : "  📭 none right now";

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `╭━━━ 🏢 ${majorMatch.name.toUpperCase()} ━━━╮

🏭 𝙄𝙣𝙙𝙪𝙨𝙩𝙧𝙮 : ${industry ? industry.label : "—"}
⭐ 𝙍𝙖𝙩𝙞𝙣𝙜   : 🌟 Major
📝 𝘽𝙞𝙤      : not set

${DIVIDER}
💰 𝘽𝙖𝙨𝙚 𝙄𝙣𝙘𝙤𝙢𝙚 : ${majorMatch.income.toLocaleString()} 🌙/payout

${DIVIDER}
📢 *𝙊𝙋𝙀𝙉 𝙋𝙊𝙎𝙄𝙏𝙄𝙊𝙉𝙎*

${openBlock}

${DIVIDER}
📥 Apply with: .jobapply <offer number>

${FOOTER}`
            },
            { quoted: msg }
        );

    }


    // ========================================================
    // ORIGINAL PLAYER-COMPANY LOOKUP
    // ========================================================

    const exactMatches =
        Object.entries(users)
            .filter(
                ([, u]) =>
                    u.company &&
                    u.company.name.toLowerCase() === q
            );

    let match =
        exactMatches[0];

    if (!match) {

        const substrMatches =
            Object.entries(users)
                .filter(
                    ([, u]) =>
                        u.company &&
                        u.company.name
                            .toLowerCase()
                            .includes(q)
                );

        if (substrMatches.length > 1) {

            const names =
                substrMatches
                    .map(
                        ([, u]) =>
                            `👉 ${u.company.name}`
                    )
                    .join("\n");

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text: noticeBox(
                        "⚠️",
                        "𝙈𝙐𝙇𝙏𝙄𝙋𝙇𝙀 𝙈𝘼𝙏𝘾𝙃𝙀𝙎",
                        `"${query}" matches more than one company — be more specific:

${names}`
                    )
                },
                { quoted: msg }
            );

        }

        match =
            substrMatches[0];

    }

    if (!match) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "📭",
                    "𝘾𝙊𝙈𝙋𝘼𝙉𝙔 𝙉𝙊𝙏 𝙁𝙊𝙐𝙉𝘿",
                    `No company found matching "${query}".`
                )
            },
            { quoted: msg }
        );

    }

    const [, ownerData] =
        match;

    const company =
        ownerData.company;

    const industry =
        getIndustry(
            company.industry
        );

    const stars =
        tierForLevel(
            company.level
        );

    const income =
        incomeAtLevel(
            company.level
        );

    const openLines =
        Object.values(
            company.offers || {}
        ).map(offer => {

            const rate =
                positionRate(
                    company.industry,
                    offer.position
                );

            const amount =
                Math.round(
                    income *
                    (rate / 100)
                );

            const maxSlots =
                getMaxSlots(
                    company.industry,
                    offer.position
                );

            const filledCount =
                Object.values(
                    company.employees || {}
                ).filter(
                    e =>
                        e.position ===
                        offer.position
                ).length;

            return `📋 *[ 𝙊𝙁𝙁𝙀𝙍 #${offer.id} ]*
💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(offer.position)}
👥 𝙎𝙡𝙤𝙩𝙨    : ${filledCount}/${maxSlots}
💰 𝙋𝙖𝙮      : ~${amount.toLocaleString()} 🌙/payout`;

        });

    const openBlock =
        openLines.length
            ? openLines.join(
                `\n\n${DIVIDER}\n\n`
            )
            : "  📭 none right now";

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `╭━━━ 🏢 ${company.name.toUpperCase()} ━━━╮

🏭 𝙄𝙣𝙙𝙪𝙨𝙩𝙧𝙮 : ${industry ? industry.label : "unknown"}
⭐ 𝙍𝙖𝙩𝙞𝙣𝙜   : ${"⭐".repeat(stars)} (${stars}-Star)
📝 𝘽𝙞𝙤      : not set

${DIVIDER}
📢 *𝙊𝙋𝙀𝙉 𝙋𝙊𝙎𝙄𝙏𝙄𝙊𝙉𝙎*

${openBlock}

${DIVIDER}
📥 Apply with: .jobapply <offer number>

${FOOTER}`
        },
        { quoted: msg }
    );

}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

    jobOffersCommand,
    jobApplyCommand,
    jobCommand,
    dutyCommand,
    jobInfoCommand,

    // Major background systems.
    resumeMajorApplications,
    startMajorAttendanceMonitor

};