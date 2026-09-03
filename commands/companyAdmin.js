const fs = require("fs");
const dataPath = require("../lib/dataPath");
const { endEmployment } = require("../lib/portfolioHistory");
const { loadMajorsState } = require("../lib/majorsState");
const { MAJORS, getMajor } = require("../lib/majors");

// ============================================================
// COMPANY ADMIN COMMANDS
// ============================================================
//
// .fire <employee number>
//     Immediately removes one employee from the owner's company.
//     The portfolio-history record is CLOSED, not deleted.
//
// .fixcompany
//     Repairs legacy player companies after the company level cap
//     and employee gate were introduced.
//
// .fixcompany -> warning/preview -> .yes / .no
//
// The .yes/.no handler returns false when there is no pending
// company confirmation, allowing index.js to pass it through to
// the existing .reseteconomy confirmation handler.
//
// IMPORTANT:
// - This module only manages PLAYER companies.
// - Major/NPC companies are never modified by .fire/.fixcompany.
// - .hire is untouched.
// ============================================================

const USERS_FILE = dataPath("users.json");

const MAX_COMPANY_LEVEL = 100;
const EMPLOYEE_GATE_LEVEL = 50;
const EMPLOYEE_GATE_MIN_COUNT = 3;
const BASE_FIX_PENALTY_PERCENT = 40;
const EXTRA_PENALTY_PER_50_LEVELS = 4;
const FIX_CONFIRMATION_TTL_MS = 2 * 60 * 1000;

const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━";
const FOOTER = "╰━━━━ 🤖 𝙕𝙤𝙧𝙚𝙭 𝘼𝙄 ━━━━╯";

// In-memory confirmation state, intentionally matching the normal
// command-confirmation style used elsewhere in the bot.
const pendingFixConfirmations = new Map();

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, "{}", "utf8");
    }

    return JSON.parse(
        fs.readFileSync(USERS_FILE, "utf8")
    );
}

function saveUsers(users) {
    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify(users, null, 4),
        "utf8"
    );
}

function titleCase(value) {
    return String(value || "")
        .split(/\s+/)
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

function senderId(msg) {
    return msg.key.participant || msg.key.remoteJid;
}

function numberLabel(userId) {
    return String(userId || "").split("@")[0];
}

function formatPercent(value) {
    const rounded = Math.round((Number(value) || 0) * 100) / 100;

    return Number.isInteger(rounded)
        ? `${rounded}%`
        : `${rounded.toFixed(2)}%`;
}

function roundMoney(value) {
    return Math.round(Number(value) || 0);
}

function isFiniteLevel(value) {
    const level = Number(value);

    return Number.isFinite(level)
        ? level
        : 0;
}

function errorBox(title, message, examples = []) {
    const exampleLines = examples
        .map(example => `  📥 ${example}`)
        .join("\n");

    return `╭━━━ ⚠️ ${title} ━━━╮

${message}

${examples.length
    ? `  ─── 📝 𝙀𝙓𝘼𝙈𝙋𝙇𝙀 ───\n${exampleLines}\n\n`
    : ""}${FOOTER}`;
}

function noticeBox(emoji, title, message) {
    return `╭━━━ ${emoji} ${title} ━━━╮

${message}

${FOOTER}`;
}

function sameUser(a, b) {
    return Boolean(a) &&
        Boolean(b) &&
        String(a) === String(b);
}

// ============================================================
// EMPLOYMENT SCAN
// ============================================================

function listPlayerCompanyJobs(users, userId) {
    const jobs = [];

    for (const ownerId of Object.keys(users || {})) {
        const company = users[ownerId]?.company;

        if (!company?.employees) {
            continue;
        }

        for (const employeeId of Object.keys(company.employees)) {
            const employee =
                company.employees[employeeId];

            if (
                !employee ||
                !sameUser(
                    employee.userId,
                    userId
                )
            ) {
                continue;
            }

            jobs.push({
                type: "player",
                ownerId,
                companyName: company.name,
                employeeId,
                position: employee.position,
                hiredAt: Number(employee.hiredAt) || 0,
                employee
            });
        }
    }

    return jobs;
}

function findMajorJobs(userId) {
    const jobs = [];
    const state = loadMajorsState();

    for (const majorKey of Object.keys(MAJORS || {})) {
        const bucket = state[majorKey];

        if (!bucket?.employees) {
            continue;
        }

        for (const employeeId of Object.keys(bucket.employees)) {
            const employee =
                bucket.employees[employeeId];

            if (
                !employee ||
                !sameUser(
                    employee.userId,
                    userId
                )
            ) {
                continue;
            }

            const major =
                getMajor(majorKey);

            jobs.push({
                type: "major",
                majorKey,
                companyName:
                    major?.name || majorKey,
                employeeId,
                position: employee.position,
                hiredAt:
                    Number(employee.hiredAt) || 0,
                employee
            });
        }
    }

    return jobs;
}

function listAllJobs(users, userId) {
    return [
        ...listPlayerCompanyJobs(
            users,
            userId
        ),
        ...findMajorJobs(userId)
    ].sort((a, b) => {

        if (a.hiredAt !== b.hiredAt) {
            return a.hiredAt - b.hiredAt;
        }

        // Stable fallback: keep player jobs
        // before majors when timestamps tie.
        return a.type === "player"
            ? -1
            : 1;
    });
}

// ============================================================
// .FIRE HELPERS
// ============================================================

function findEmployeeByNumber(
    company,
    employeeNumber
) {
    return Object.entries(
        company?.employees || {}
    ).find(
        ([, employee]) =>
            employee.num === employeeNumber
    ) || null;
}

function removeEmployeeFromPlayerCompany(
    users,
    ownerId,
    employeeId,
    endedAt = Date.now()
) {
    const company =
        users[ownerId]?.company;

    const employee =
        company?.employees?.[employeeId];

    if (!company || !employee) {
        return null;
    }

    const removed = {
        ...employee,
        employeeId,
        companyOwnerId: ownerId,
        companyName: company.name
    };

    delete company.employees[employeeId];

    // A direct firing finishes any previously
    // submitted resignation too.
    if (
        users[employee.userId]?.jobResignation
    ) {
        const resignation =
            users[employee.userId]
                .jobResignation;

        if (
            resignation.companyType === "player" &&
            resignation.companyOwnerId === ownerId &&
            resignation.employeeId === employeeId
        ) {
            delete users[
                employee.userId
            ].jobResignation;
        }
    }

    // Preserve the historical employment record,
    // but close the active job.
    endEmployment({
        userId: employee.userId,
        companyName: company.name,
        position: employee.position,
        endedAt
    });

    return removed;
}

// ============================================================
// .FIRE
// ============================================================

async function fireCommand(
    sock,
    msg,
    text
) {
    const sender = senderId(msg);
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

    const company =
        users[sender].company;

    if (!company) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "⚠️",
                    "𝙉𝙊 𝘾𝙊𝙈𝙋𝘼𝙉𝙔",
                    "You don't own a company yet."
                )
            },
            { quoted: msg }
        );
    }

    company.employees =
        company.employees || {};

    const arg =
        String(text || "")
            .replace(/^\.fire\s*/i, "")
            .trim();

    const employeeNumber =
        Number(arg);

    if (
        !arg ||
        !Number.isInteger(employeeNumber) ||
        employeeNumber <= 0
    ) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: errorBox(
                    "𝗙𝗜𝗥𝗘",
                    "Enter the employee number from .employees.",
                    [".fire 3"]
                )
            },
            { quoted: msg }
        );
    }

    const found =
        findEmployeeByNumber(
            company,
            employeeNumber
        );

    if (!found) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    `⚠️ *${company.name}* has no employee #${employeeNumber}.\n\n📥 Check .employees for the current roster.`
            },
            { quoted: msg }
        );
    }

    const [
        employeeId,
        employee
    ] = found;

    const employeeName =
        users[employee.userId]?.name ||
        "Unknown employee";

    const endedAt =
        Date.now();

    const removed =
        removeEmployeeFromPlayerCompany(
            users,
            sender,
            employeeId,
            endedAt
        );

    if (!removed) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    `⚠️ *${company.name}* could not remove employee #${employeeNumber}. Please run .employees again and retry.`
            },
            { quoted: msg }
        );
    }

    saveUsers(users);

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: noticeBox(
                "📤",
                "𝙀𝙈𝙋𝙇𝙊𝙔𝙀𝙀 𝙁𝙄𝙍𝙀𝘿",
                `👤 Employee : @${numberLabel(employee.userId)} (${employeeName})
💼 Position : ${titleCase(employee.position)}
🏢 Company  : ${company.name}
🔑 Code     : ${employee.code || "n/a"}

✅ Employment status: Unemployed
💰 Pending payout: Forfeited
📚 Career history: Preserved

${DIVIDER}
The position is now available again.
They may apply for another job through .joboffers.`
            ),
            mentions: [
                employee.userId
            ]
        },
        { quoted: msg }
    );

    // Notify the employee directly as well.
    // This failure must not undo the
    // successful database change above.
    try {

        await sock.sendMessage(
            employee.userId,
            {
                text: noticeBox(
                    "📤",
                    "𝙔𝙊𝙐 𝙃𝘼𝙑𝙀 𝘽𝙀𝙀𝙉 𝙁𝙄𝙍𝙀𝘿",
                    `Your position has ended immediately.

🏢 Company  : ${company.name}
💼 Position : ${titleCase(employee.position)}

✅ Employment status: Unemployed
💰 Pending payout: Forfeited
📚 Career history: Preserved

You may apply for another position through .joboffers.`
                )
            }
        );

    } catch (err) {

        console.error(
            "[company fire] failed to notify employee:",
            err.message
        );

    }

    return true;
}

// ============================================================
// FIX COMPANY CALCULATION
// ============================================================

function findConflictRemovals(
    users,
    ownerId,
    company
) {
    const plannedRemovals = [];

    for (
        const [
            employeeId,
            employee
        ] of Object.entries(
            company.employees || {}
        )
    ) {

        if (!employee?.userId) {
            continue;
        }

        const allJobs =
            listAllJobs(
                users,
                employee.userId
            );

        if (allJobs.length <= 1) {
            continue;
        }

        const otherJobs =
            allJobs.filter(job =>
                !(
                    job.type === "player" &&
                    job.ownerId === ownerId &&
                    job.employeeId === employeeId
                )
            );

        if (otherJobs.length === 0) {
            continue;
        }

        // .fixcompany repairs ONLY the company
        // whose owner ran it.
        //
        // We never delete an employee from
        // another owner's company.
        //
        // Therefore a conflicting employee is
        // removed from this company, leaving
        // the other employment untouched.
        const conflict =
            otherJobs[0];

        plannedRemovals.push({
            employeeId,
            employee,
            reason:
                conflict.type === "major"
                    ? `also employed by Major *${conflict.companyName}*`
                    : `also employed by *${conflict.companyName}*`
        });

    }

    return plannedRemovals;
}

function calculatePenaltyPercent(
    originalLevel,
    finalEmployeeCount
) {
    const level =
        isFiniteLevel(
            originalLevel
        );

    // STEP 2
    //
    // Old level > 50
    // Fewer than 3 employees
    //
    // If they were already level 100+:
    //     70% penalty
    //
    // Otherwise:
    //     40% penalty
    if (
        level > EMPLOYEE_GATE_LEVEL &&
        finalEmployeeCount < EMPLOYEE_GATE_MIN_COUNT
    ) {

        return {
            step: 2,
            targetLevel:
                EMPLOYEE_GATE_LEVEL,

            penaltyPercent:
                level >= MAX_COMPANY_LEVEL
                    ? 70
                    : BASE_FIX_PENALTY_PERCENT,

            reason:
                level >= MAX_COMPANY_LEVEL
                    ? "More than 50 with fewer than 3 employees, and the old company was already at level 100+."
                    : "More than 50 with fewer than 3 employees, and the old company was below level 100."
        };
    }

    // STEP 3
    //
    // 3+ employees
    // Level 100+
    //
    // 100-105:
    //     no penalty
    //
    // 106+:
    //     40%
    //     + 4% for each FULL 50-level block
    //       above 105.
    //
    // Examples:
    //
    // 106-154 -> 40%
    // 155-204 -> 44%
    // 205-254 -> 48%
    // 255-304 -> 52%
    //
    if (
        finalEmployeeCount >= EMPLOYEE_GATE_MIN_COUNT &&
        level >= MAX_COMPANY_LEVEL
    ) {

        if (level <= 105) {
            return {
                step: 3,
                targetLevel:
                    MAX_COMPANY_LEVEL,
                penaltyPercent: 0,
                reason:
                    "3+ employees with a level from 100 to 105."
            };
        }

        const fullBlocksAbove105 =
            Math.floor(
                (level - 105) / 50
            );

        const penaltyPercent =
            Math.min(
                100,
                BASE_FIX_PENALTY_PERCENT +
                (
                    EXTRA_PENALTY_PER_50_LEVELS *
                    fullBlocksAbove105
                )
            );

        return {
            step: 3,
            targetLevel:
                MAX_COMPANY_LEVEL,
            penaltyPercent,
            reason:
                `3+ employees with level ${Math.trunc(level)}+. The company is reset to level 100 and charged 40% + 4% for each full 50-level block above 105.`
        };
    }

    return {
        step: 0,
        targetLevel: level,
        penaltyPercent: 0,
        reason:
            "No legacy company correction is required by the current rules."
    };
}

function buildFixPreview(
    users,
    ownerId
) {
    const company =
        users[ownerId]?.company;

    if (!company) {
        return null;
    }

    company.employees =
        company.employees || {};

    const originalLevel =
        isFiniteLevel(
            company.level
        );

    const originalEmployeeCount =
        Object.keys(
            company.employees
        ).length;

    const originalWallet =
        roundMoney(
            company.wallet
        );

    const conflictRemovals =
        findConflictRemovals(
            users,
            ownerId,
            company
        );

    const removalIds =
        new Set(
            conflictRemovals.map(
                item =>
                    item.employeeId
            )
        );

    const finalEmployeeCount =
        originalEmployeeCount -
        conflictRemovals.length;

    const repair =
        calculatePenaltyPercent(
            originalLevel,
            finalEmployeeCount
        );

    const penaltyAmount =
        roundMoney(
            originalWallet *
            (
                repair.penaltyPercent /
                100
            )
        );

    const finalWallet =
        Math.max(
            0,
            originalWallet -
            penaltyAmount
        );

    const finalLevel =
        Math.trunc(
            repair.targetLevel
        );

    return {
        ownerId,
        companyName:
            company.name,

        originalLevel,
        originalEmployeeCount,
        originalWallet,

        conflictRemovals,
        removalIds,

        finalEmployeeCount,

        ...repair,

        penaltyAmount,
        finalWallet,
        finalLevel,

        needsRepair:
            conflictRemovals.length > 0 ||
            repair.step !== 0 ||
            finalLevel !== originalLevel
    };
}

function buildFixPreviewMessage(
    preview
) {
    const lines = [];

    lines.push(
        `🏢 *${preview.companyName}*`
    );

    lines.push("");

    lines.push(
        "⚠️ *LEGACY COMPANY REPAIR PREVIEW*"
    );

    lines.push("");

    lines.push(
        `📊 Level: ${preview.originalLevel} → ${preview.finalLevel}`
    );

    lines.push(
        `👥 Employees: ${preview.originalEmployeeCount} → ${preview.finalEmployeeCount}`
    );

    lines.push(
        `🏦 Company Wallet: ${preview.originalWallet.toLocaleString()} 🌙 → ${preview.finalWallet.toLocaleString()} 🌙`
    );

    if (
        preview.conflictRemovals.length > 0
    ) {

        lines.push("");

        lines.push(
            "🧹 *STEP 1 — JOB CONFLICT CLEANUP*"
        );

        for (
            const item
            of preview.conflictRemovals
        ) {

            const name =
                preview.ownerId &&
                item.employee.userId
                    ? `@${numberLabel(
                        item.employee.userId
                    )}`
                    : "employee";

            lines.push(
                `• ${name} — ${titleCase(item.employee.position)} (${item.reason})`
            );
        }
    }

    if (preview.step === 2) {

        lines.push("");

        lines.push(
            "🛠️ *STEP 2 — EMPLOYEE GATE REPAIR*"
        );

        lines.push(
            `• Level ${preview.originalLevel} → 50`
        );

        lines.push(
            `• Fund penalty: ${formatPercent(
                preview.penaltyPercent
            )}`
        );
    }

    if (preview.step === 3) {

        lines.push("");

        lines.push(
            "🛠️ *STEP 3 — LEVEL CAP REPAIR*"
        );

        lines.push(
            `• Level ${preview.originalLevel} → 100`
        );

        lines.push(
            `• Fund penalty: ${formatPercent(
                preview.penaltyPercent
            )}`
        );
    }

    if (preview.step !== 0) {

        lines.push("");

        lines.push(
            `📝 ${preview.reason}`
        );

        lines.push(
            `💸 Funds removed: ${preview.penaltyAmount.toLocaleString()} 🌙`
        );
    }

    lines.push("");

    lines.push(DIVIDER);

    lines.push(
        "⚠️ This action will modify the company immediately."
    );

    lines.push(
        "Reply with *.yes* to apply the repair or *.no* to cancel."
    );

    return lines.join("\n");
}

// ============================================================
// .FIXCOMPANY
// ============================================================

async function fixCompanyCommand(
    sock,
    msg
) {
    const sender =
        senderId(msg);

    const users =
        loadUsers();

    if (!users[sender]) {

        await sock.sendMessage(
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

        return true;
    }

    if (!users[sender].company) {

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "⚠️",
                    "𝙉𝙊 𝘾𝙊𝙈𝙋𝘼𝙉𝙔",
                    "You don't own a company yet."
                )
            },
            { quoted: msg }
        );

        return true;
    }

    const preview =
        buildFixPreview(
            users,
            sender
        );

    if (!preview?.needsRepair) {

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "✅",
                    "𝘾𝙊𝙈𝙋𝘼𝙉𝙔 𝙄𝙎 𝙁𝙄𝙉𝙀",
                    `*${preview.companyName}* does not need a legacy repair.

📊 Level: ${preview.originalLevel}
👥 Employees: ${preview.originalEmployeeCount}
🏦 Company Wallet: ${preview.originalWallet.toLocaleString()} 🌙

No changes were made.`
                )
            },
            { quoted: msg }
        );

        return true;
    }

    pendingFixConfirmations.set(
        sender,
        {
            createdAt: Date.now()
        }
    );

    // Automatically expire the confirmation so a later
    // unrelated .yes cannot accidentally apply an old repair.
    const expiryTimer =
        setTimeout(
            () => {

                const pending =
                    pendingFixConfirmations.get(
                        sender
                    );

                if (
                    pending &&
                    Date.now() -
                    pending.createdAt >=
                    FIX_CONFIRMATION_TTL_MS
                ) {

                    pendingFixConfirmations.delete(
                        sender
                    );
                }

            },
            FIX_CONFIRMATION_TTL_MS + 1000
        );

    // Do not let the confirmation cleanup timer
    // keep the Node process alive.
    if (
        typeof expiryTimer.unref ===
        "function"
    ) {
        expiryTimer.unref();
    }

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
                buildFixPreviewMessage(
                    preview
                ),

            mentions:
                preview.conflictRemovals.map(
                    item =>
                        item.employee.userId
                )
        },
        { quoted: msg }
    );

    return true;
}

// ============================================================
// .YES / .NO FOR .FIXCOMPANY
// ============================================================

async function companyAdminConfirmationCommand(
    sock,
    msg,
    text
) {
    const sender =
        senderId(msg);

    const choice =
        String(text || "")
            .trim()
            .toLowerCase();

    if (
        choice !== ".yes" &&
        choice !== ".no"
    ) {
        return false;
    }

    const pending =
        pendingFixConfirmations.get(
            sender
        );

    if (!pending) {

        // Important:
        // let the existing .reseteconomy
        // handler process it.
        return false;
    }

    if (
        Date.now() -
        pending.createdAt >
        FIX_CONFIRMATION_TTL_MS
    ) {

        pendingFixConfirmations.delete(
            sender
        );

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "⌛",
                    "𝙁𝙄𝙓 𝙀𝙓𝙋𝙄𝙍𝙀𝘿",
                    "The .fixcompany confirmation expired. Run *.fixcompany* again to review the repair."
                )
            },
            { quoted: msg }
        );

        return true;
    }

    pendingFixConfirmations.delete(
        sender
    );

    if (choice === ".no") {

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "❎",
                    "𝙁𝙄𝙓 𝘾𝘼𝙉𝘾𝙀𝙇𝙇𝙀𝘿",
                    "No company changes were made."
                )
            },
            { quoted: msg }
        );

        return true;
    }

    // Re-read users.json and recalculate everything
    // from CURRENT state.
    //
    // This prevents a stale preview from changing
    // the wrong amount if the company was modified
    // between .fixcompany and .yes.
    const users =
        loadUsers();

    const preview =
        buildFixPreview(
            users,
            sender
        );

    if (!preview) {

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "⚠️",
                    "𝙁𝙄𝙓 𝙁𝘼𝙄𝙇𝙀𝘿",
                    "Your company could not be found. No changes were made."
                )
            },
            { quoted: msg }
        );

        return true;
    }

    if (!preview.needsRepair) {

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: noticeBox(
                    "✅",
                    "𝙉𝙊 𝙍𝙀𝙋𝘼𝙄𝙍 𝙉𝙀𝙀𝘿𝙀𝘿",
                    `*${preview.companyName}* is already compliant.

No changes were made.`
                )
            },
            { quoted: msg }
        );

        return true;
    }

    const company =
        users[sender].company;

    company.employees =
        company.employees || {};

    const now =
        Date.now();

    const removedEmployees = [];

    // Step 1 — remove only the employees
    // identified in the preview.
    for (
        const item
        of preview.conflictRemovals
    ) {

        const removed =
            removeEmployeeFromPlayerCompany(
                users,
                sender,
                item.employeeId,
                now
            );

        if (removed) {
            removedEmployees.push(
                removed
            );
        }
    }

    // IMPORTANT:
    // use the CURRENT company state after Step 1.
    const levelBeforeRepair =
        isFiniteLevel(
            company.level
        );

    const employeeCountAfterCleanup =
        Object.keys(
            company.employees
        ).length;

    const repair =
        calculatePenaltyPercent(
            levelBeforeRepair,
            employeeCountAfterCleanup
        );

    const walletBeforeRepair =
        roundMoney(
            company.wallet
        );

    const penaltyAmount =
        roundMoney(
            walletBeforeRepair *
            (
                repair.penaltyPercent /
                100
            )
        );

    company.wallet =
        Math.max(
            0,
            walletBeforeRepair -
            penaltyAmount
        );

    company.level =
        Math.min(
            MAX_COMPANY_LEVEL,
            Math.max(
                0,
                Math.trunc(
                    repair.targetLevel
                )
            )
        );

    saveUsers(users);

    const changeLines = [

        `🏢 Company: *${company.name}*`,

        `👥 Employees: ${preview.originalEmployeeCount} → ${employeeCountAfterCleanup}`,

        `📊 Level: ${levelBeforeRepair} → ${company.level}`,

        `🏦 Wallet: ${walletBeforeRepair.toLocaleString()} 🌙 → ${company.wallet.toLocaleString()} 🌙`

    ];

    if (
        removedEmployees.length > 0
    ) {

        changeLines.push(
            "",
            `🧹 Conflicting employees removed: ${removedEmployees.length}`,
            ...removedEmployees.map(
                employee =>
                    `• @${numberLabel(employee.userId)} — ${titleCase(employee.position)}`
            )
        );
    }

    if (
        repair.penaltyPercent > 0
    ) {

        changeLines.push(
            "",
            `💸 Fund penalty: ${formatPercent(repair.penaltyPercent)} (-${penaltyAmount.toLocaleString()} 🌙)`
        );

    } else if (
        levelBeforeRepair !==
        company.level
    ) {

        changeLines.push(
            "",
            "💸 Fund penalty: none"
        );
    }

    changeLines.push(
        "",
        DIVIDER,
        "✅ Company repair completed successfully.",
        "📚 Employee career history was preserved for everyone removed."
    );

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
                noticeBox(
                    "🛠️",
                    "𝘾𝙊𝙈𝙋𝘼𝙉𝙔 𝙁𝙄𝙓𝙀𝘿",
                    changeLines.join("\n")
                ),

            mentions:
                removedEmployees.map(
                    employee =>
                        employee.userId
                )
        },
        { quoted: msg }
    );

    for (
        const employee
        of removedEmployees
    ) {

        try {

            await sock.sendMessage(
                employee.userId,
                {
                    text: noticeBox(
                        "📤",
                        "𝙀𝙈𝙋𝙇𝙊𝙔𝙈𝙀𝙉𝙏 𝙍𝙀𝙈𝙊𝙑𝙀𝘿",
                        `Your employment at *${company.name}* was removed during a company repair because your account had another active employment record.

💼 Position : ${titleCase(employee.position)}

✅ Employment status: Unemployed
📚 Career history: Preserved

You may apply for another position through .joboffers.`
                    )
                }
            );

        } catch (err) {

            console.error(
                "[fixcompany] failed to notify employee:",
                err.message
            );

        }
    }

    return true;
}

// ============================================================
// SINGLE ROUTER
// ============================================================

async function companyAdminCommand(
    sock,
    msg,
    text
) {
    const command =
        String(text || "")
            .trim()
            .toLowerCase();

    if (
        command === ".fixcompany"
    ) {
        return await fixCompanyCommand(
            sock,
            msg
        );
    }

    if (
        command.startsWith(
            ".fixcompany "
        )
    ) {

        // No arguments are currently accepted.
        // Keep this explicit so a typo does
        // not silently perform a repair.
        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: errorBox(
                    "𝗙𝗜𝗫 𝗖𝗢𝗠𝗣𝗔𝗡𝗬",
                    "The command takes no arguments.",
                    [
                        ".fixcompany",
                        ".yes",
                        ".no"
                    ]
                )
            },
            { quoted: msg }
        );
    }

    if (
        command === ".fire" ||
        command.startsWith(".fire ")
    ) {
        return await fireCommand(
            sock,
            msg,
            text
        );
    }

    if (
        command === ".yes" ||
        command === ".no"
    ) {
        return await companyAdminConfirmationCommand(
            sock,
            msg,
            command
        );
    }

    return false;
}

module.exports = {
    companyAdminCommand,
    fireCommand,
    fixCompanyCommand,
    companyAdminConfirmationCommand,

    calculatePenaltyPercent,
    buildFixPreview,

    listPlayerCompanyJobs,
    listAllJobs,

    MAX_COMPANY_LEVEL,
    EMPLOYEE_GATE_LEVEL,
    EMPLOYEE_GATE_MIN_COUNT,

    BASE_FIX_PENALTY_PERCENT,
    EXTRA_PENALTY_PER_50_LEVELS
};