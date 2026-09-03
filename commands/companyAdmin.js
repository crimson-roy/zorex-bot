const fs = require("fs");
const dataPath = require("../lib/dataPath");
const { endEmployment } = require("../lib/portfolioHistory");
const { loadMajorsState } = require("../lib/majorsState");
const { MAJORS, getMajor } = require("../lib/majors");
const { MAIN_OWNER } = require("../config");
function normalizeUserId(userId) {
    if (!userId) return "";

    return String(userId)
        .trim()
        .toLowerCase();
}

// ============================================================
// COMPANY ADMIN COMMANDS
// ============================================================
//
// .fire <employee code>
//     Immediately removes one employee from the owner's company.
//     The portfolio-history record is CLOSED, not deleted.
//
// .fixcompany
//     Repairs the sender's own player company.
//
// .fixcompany @user
//     Bot-owner-only: repairs the mentioned user's company.
//
// .fixcompany  (as a reply to a user)
//     Bot-owner-only: repairs the replied-to user's company.
//
// .fixcompany all
//     Bot-owner-only: repairs ALL player companies that need repair.
//
// .fixcompany -> warning/preview -> .yes / .no
//
// IMPORTANT:
// - This module only manages PLAYER companies.
// - Major/NPC companies are never modified by .fire/.fixcompany.
// - .hire is untouched.
// ============================================================

const USERS_FILE = dataPath("users.json");
const OWNERS_FILE = dataPath("owners.json");

const MAX_COMPANY_LEVEL = 100;
const EMPLOYEE_GATE_LEVEL = 50;
const EMPLOYEE_GATE_MIN_COUNT = 3;

const BASE_FIX_PENALTY_PERCENT = 40;

// NEW RULE:
// 4% for every FULL 50-level block above level 105.
const EXTRA_PENALTY_PER_50_LEVELS = 4;

const FIX_CONFIRMATION_TTL_MS =
    2 * 60 * 1000;

const DIVIDER =
    "━━━━━━━━━━━━━━━━━━━━━━━━━";

const FOOTER =
    "╰━━━━ 🤖 𝙕𝙤𝙧𝙚𝙭 𝘼𝙄 ━━━━╯";

// In-memory confirmation state.
const pendingFixConfirmations = new Map();

// ============================================================
// STORAGE
// ============================================================

function loadUsers() {

    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(
            USERS_FILE,
            "{}",
            "utf8"
        );
    }

    return JSON.parse(
        fs.readFileSync(
            USERS_FILE,
            "utf8"
        )
    );

}

function saveUsers(users) {

    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify(
            users,
            null,
            4
        ),
        "utf8"
    );

}


// ============================================================
// BOT OWNER CHECK
// ============================================================

function loadOwners() {

    if (!fs.existsSync(OWNERS_FILE)) {

        fs.writeFileSync(
            OWNERS_FILE,
            "[]",
            "utf8"
        );

    }

    try {

        return JSON.parse(
            fs.readFileSync(
                OWNERS_FILE,
                "utf8"
            )
        );

    } catch {

        return [];

    }

}

function isBotOwner(userId) {

    if (!userId) {
        return false;
    }

    let normalized;

    try {

        normalized =
            jidNormalizedUser(
                userId
            );

    } catch {

        normalized =
            userId;

    }

    try {

        if (
            MAIN_OWNER &&
            normalized ===
                jidNormalizedUser(
                    MAIN_OWNER
                )
        ) {
            return true;
        }

    } catch {

        if (
            MAIN_OWNER &&
            normalized === MAIN_OWNER
        ) {
            return true;
        }

    }

    return loadOwners().some(
        ownerId => {

            try {

                return (
                    jidNormalizedUser(
                        ownerId
                    ) === normalized
                );

            } catch {

                return (
                    ownerId === normalized
                );

            }

        }
    );

}


// ============================================================
// BASIC HELPERS
// ============================================================

function senderId(msg) {

    return (
        msg.key.participant ||
        msg.key.remoteJid
    );

}

function numberLabel(userId) {

    return String(
        userId || ""
    ).split("@")[0];

}

function sameUser(a, b) {

    return (
        Boolean(a) &&
        Boolean(b) &&
        String(a) === String(b)
    );

}

function titleCase(value) {

    return String(value || "")
        .split(/\s+/)
        .filter(Boolean)
        .map(
            word =>
                word.charAt(0).toUpperCase() +
                word.slice(1)
        )
        .join(" ");

}

function formatPercent(value) {

    const rounded =
        Math.round(
            (Number(value) || 0) * 100
        ) / 100;

    return Number.isInteger(
        rounded
    )
        ? `${rounded}%`
        : `${rounded.toFixed(2)}%`;

}

function roundMoney(value) {

    return Math.round(
        Number(value) || 0
    );

}

function isFiniteLevel(value) {

    const level =
        Number(value);

    return Number.isFinite(level)
        ? level
        : 0;

}

function errorBox(
    title,
    message,
    examples = []
) {

    const exampleLines =
        examples
            .map(
                example =>
                    `  📥 ${example}`
            )
            .join("\n");

    return `╭━━━ ⚠️ ${title} ━━━╮

${message}

${
    examples.length
        ? `  ─── 📝 𝙀𝙓𝘼𝙈𝙋𝙇𝙀 ───
${exampleLines}

`
        : ""
}${FOOTER}`;

}

function noticeBox(
    emoji,
    title,
    message
) {

    return `╭━━━ ${emoji} ${title} ━━━╮

${message}

${FOOTER}`;

}


// ============================================================
// WHATSAPP REPLY / MENTION TARGETING
// ============================================================

function getMessageContextInfo(msg) {

    return (
        msg.message?.extendedTextMessage?.contextInfo ||
        msg.message?.conversation?.contextInfo ||
        msg.message?.imageMessage?.contextInfo ||
        msg.message?.videoMessage?.contextInfo ||
        msg.message?.documentMessage?.contextInfo ||
        msg.message?.buttonsResponseMessage?.contextInfo ||
        msg.message?.listResponseMessage?.contextInfo ||
        msg.message?.templateButtonReplyMessage?.contextInfo ||
        null
    );

}

function resolveExistingUserId(
    users,
    candidate
) {

    if (!candidate) {
        return null;
    }

    if (users[candidate]) {
        return candidate;
    }

    let normalizedCandidate;

    try {

        normalizedCandidate =
            jidNormalizedUser(
                candidate
            );

    } catch {

        normalizedCandidate =
            candidate;

    }

    for (
        const userId of Object.keys(users)
    ) {

        try {

            if (
                jidNormalizedUser(
                    userId
                ) ===
                normalizedCandidate
            ) {

                return userId;

            }

        } catch {

            if (
                userId ===
                normalizedCandidate
            ) {

                return userId;

            }

        }

    }

    return null;

}

function getFixCompanyTarget(
    msg,
    text,
    users
) {

    const rest =
        String(text || "")
            .replace(
                /^\.fixcompany\s*/i,
                ""
            )
            .trim();

    // ========================================================
    // .fixcompany all
    // ========================================================

    if (
        rest.toLowerCase() === "all"
    ) {

        return {
            mode: "all"
        };

    }

    const contextInfo =
        getMessageContextInfo(msg);

    // Mentioned user.
    const mentioned =
        contextInfo?.mentionedJid?.[0] ||
        null;

    // Replied-to user.
    //
    // Baileys puts the JID of the message
    // being replied to in contextInfo.participant
    // when the quoted message is present.
    const repliedTo =
        contextInfo?.quotedMessage &&
        contextInfo?.participant
            ? contextInfo.participant
            : null;

    // Prefer an explicit mention if both
    // a mention and a reply exist.
    const candidate =
        mentioned ||
        repliedTo;

    if (candidate) {

        const ownerId =
            resolveExistingUserId(
                users,
                candidate
            );

        if (!ownerId) {

            return {
                error:
                    "That tagged/replied user is not registered in the bot."
            };

        }

        if (
            !users[ownerId]?.company
        ) {

            return {
                error:
                    `@${numberLabel(ownerId)} does not own a company.`,
                mentions: [ownerId]
            };

        }

        return {
            mode: "target",
            ownerId,
            mentions: [ownerId]
        };

    }

    // ========================================================
    // Anything else after .fixcompany is invalid.
    // ========================================================

    if (rest) {

        return {
            error:
                "Unknown argument. Use *.fixcompany*, reply/tag a company owner with *.fixcompany*, or use *.fixcompany all*."
        };

    }

    // ========================================================
    // Bare .fixcompany -> sender's company
    // ========================================================

    const sender =
        senderId(msg);

    return {
        mode: "self",
        ownerId:
            resolveExistingUserId(
                users,
                sender
            ) || sender
    };

}


// ============================================================
// EMPLOYMENT SCAN
// ============================================================

function listPlayerCompanyJobs(
    users,
    userId
) {

    const jobs = [];

    for (
        const ownerId of Object.keys(
            users || {}
        )
    ) {

        const company =
            users[ownerId]?.company;

        if (!company?.employees) {
            continue;
        }

        for (
            const employeeId of
            Object.keys(
                company.employees
            )
        ) {

            const employee =
                company.employees[
                    employeeId
                ];

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

                companyName:
                    company.name,

                employeeId,

                position:
                    employee.position,

                hiredAt:
                    Number(
                        employee.hiredAt
                    ) || 0,

                employee

            });

        }

    }

    return jobs;

}

function findMajorJobs(userId) {

    const jobs = [];

    const state =
        loadMajorsState();

    for (
        const majorKey of
        Object.keys(
            MAJORS || {}
        )
    ) {

        const bucket =
            state[majorKey];

        if (!bucket?.employees) {
            continue;
        }

        for (
            const employeeId of
            Object.keys(
                bucket.employees
            )
        ) {

            const employee =
                bucket.employees[
                    employeeId
                ];

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
                getMajor(
                    majorKey
                );

            jobs.push({

                type: "major",

                majorKey,

                companyName:
                    major?.name ||
                    majorKey,

                employeeId,

                position:
                    employee.position,

                hiredAt:
                    Number(
                        employee.hiredAt
                    ) || 0,

                employee

            });

        }

    }

    return jobs;

}

function listAllJobs(
    users,
    userId
) {

    return [

        ...listPlayerCompanyJobs(
            users,
            userId
        ),

        ...findMajorJobs(
            userId
        )

    ].sort(
        (a, b) => {

            if (
                a.hiredAt !==
                b.hiredAt
            ) {

                return (
                    a.hiredAt -
                    b.hiredAt
                );

            }

            return (
                a.type === "player"
                    ? -1
                    : 1
            );

        }
    );

}


// ============================================================
// .FIRE
// ============================================================
//
// IMPORTANT:
// .fire accepts ONLY an employee CODE.
// It does NOT use replies.
// It does NOT use mentions.
// It does NOT accept employee numbers.
// ============================================================

function findEmployeeByCode(
    company,
    employeeCode
) {

    const normalizedCode =
        String(
            employeeCode || ""
        )
            .trim()
            .toUpperCase();

    return Object.entries(
        company?.employees || {}
    ).find(
        ([, employee]) =>
            String(
                employee?.code || ""
            )
                .trim()
                .toUpperCase() ===
            normalizedCode
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
        company?.employees?.[
            employeeId
        ];

    if (
        !company ||
        !employee
    ) {

        return null;

    }

    const removed = {

        ...employee,

        employeeId,

        companyOwnerId:
            ownerId,

        companyName:
            company.name

    };

    delete company.employees[
        employeeId
    ];

    // If a resignation was already pending,
    // firing immediately cancels that pending
    // resignation record.
    if (
        users[employee.userId]
            ?.jobResignation
    ) {

        const resignation =
            users[
                employee.userId
            ].jobResignation;

        if (
            resignation.companyType ===
                "player" &&
            resignation.companyOwnerId ===
                ownerId &&
            resignation.employeeId ===
                employeeId
        ) {

            delete users[
                employee.userId
            ].jobResignation;

        }

    }

    // Close active portfolio history.
    endEmployment({

        userId:
            employee.userId,

        companyName:
            company.name,

        position:
            employee.position,

        endedAt

    });

    return removed;

}

async function fireCommand(
    sock,
    msg,
    text
) {

    const sender =
        senderId(msg);

    const users =
        loadUsers();

    if (!users[sender]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    noticeBox(
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
                text:
                    noticeBox(
                        "⚠️",
                        "𝙉𝙊 𝘾𝙊𝙈𝙋𝘼𝙉𝙔",
                        "You don't own a company yet."
                    )
            },
            { quoted: msg }
        );

    }

    company.employees =
        company.employees ||
        {};

    const arg =
        String(text || "")
            .replace(
                /^\.fire\s*/i,
                ""
            )
            .trim()
            .toUpperCase();

    if (!arg) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    errorBox(
                        "𝗙𝗜𝗥𝗘",
                        "Enter the employee code shown in .employees.",
                        [".fire EMP-4821"]
                    )
            },
            { quoted: msg }
        );

    }

    // Reject extra arguments naturally.
    // .fire EMP-4821 works.
    // .fire EMP-4821 extra does not.
    if (
        arg.includes(/\s/)
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    errorBox(
                        "𝗙𝗜𝗥𝗘",
                        "Use the employee code only.",
                        [".fire EMP-4821"]
                    )
            },
            { quoted: msg }
        );

    }

    const found =
        findEmployeeByCode(
            company,
            arg
        );

    if (!found) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    `⚠️ *${company.name}* has no employee with code *${arg}*.\n\n📥 Check .employees for the current employee code.`
            },
            { quoted: msg }
        );

    }

    const [
        employeeId,
        employee
    ] = found;

    const employeeName =
        users[
            employee.userId
        ]?.name ||
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
                    `⚠️ *${company.name}* could not remove employee with code *${arg}*. Please run .employees again and retry.`
            },
            { quoted: msg }
        );

    }

    saveUsers(users);

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
                noticeBox(
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

    // Direct notification to the fired employee.
    try {

        await sock.sendMessage(
            employee.userId,
            {
                text:
                    noticeBox(
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
// FIX COMPANY — CONFLICT SCAN
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

        if (
            allJobs.length <= 1
        ) {
            continue;
        }

        const otherJobs =
            allJobs.filter(
                job =>
                    !(
                        job.type ===
                            "player" &&
                        job.ownerId ===
                            ownerId &&
                        job.employeeId ===
                            employeeId
                    )
            );

        if (
            otherJobs.length === 0
        ) {
            continue;
        }

        // IMPORTANT:
        // Only remove the employee from the
        // company currently being repaired.
        //
        // Never delete employment from another
        // player's company.
        const conflict =
            otherJobs[0];

        plannedRemovals.push({

            employeeId,

            employee,

            reason:
                conflict.type ===
                    "major"

                    ? `also employed by Major *${conflict.companyName}*`

                    : `also employed by *${conflict.companyName}*`

        });

    }

    return plannedRemovals;

}


// ============================================================
// FIX COMPANY — PENALTY CALCULATION
// ============================================================

function calculatePenaltyPercent(
    originalLevel,
    finalEmployeeCount
) {

    const level =
        isFiniteLevel(
            originalLevel
        );

    // ========================================================
    // STEP 2
    // ========================================================
    //
    // Level > 50
    // Fewer than 3 employees
    //
    // Old level < 100:
    //     40%
    //
    // Old level >= 100:
    //     70%
    //

    if (
        level >
            EMPLOYEE_GATE_LEVEL &&
        finalEmployeeCount <
            EMPLOYEE_GATE_MIN_COUNT
    ) {

        return {

            step: 2,

            targetLevel:
                EMPLOYEE_GATE_LEVEL,

            penaltyPercent:
                level >=
                    MAX_COMPANY_LEVEL
                    ? 70
                    : BASE_FIX_PENALTY_PERCENT,

            reason:
                level >=
                    MAX_COMPANY_LEVEL

                    ? "More than 50 with fewer than 3 employees, and the old company was already at level 100+."

                    : "More than 50 with fewer than 3 employees, and the old company was below level 100."

        };

    }


    // ========================================================
    // STEP 3
    // ========================================================
    //
    // 3+ employees
    // Level >= 100
    //
    // 100-105:
    //     no penalty
    //
    // 106-154:
    //     40%
    //
    // 155-204:
    //     44%
    //
    // 205-254:
    //     48%
    //
    // etc.
    //
    // Formula:
    //
    // 40% + 4% per FULL 50-level block above 105.
    //

    if (
        finalEmployeeCount >=
            EMPLOYEE_GATE_MIN_COUNT &&
        level >=
            MAX_COMPANY_LEVEL
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


    // ========================================================
    // NO REPAIR NEEDED
    // ========================================================

    return {

        step: 0,

        targetLevel:
            level,

        penaltyPercent: 0,

        reason:
            "No legacy company correction is required by the current rules."

    };

}


// ============================================================
// BUILD PREVIEW
// ============================================================

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
        company.employees ||
        {};

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

        finalEmployeeCount,

        ...repair,

        penaltyAmount,

        finalWallet,

        finalLevel,

        needsRepair:

            conflictRemovals.length >
                0 ||

            repair.step !==
                0 ||

            finalLevel !==
                originalLevel

    };

}


// ============================================================
// PREVIEW MESSAGE
// ============================================================

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


    // ========================================================
    // STEP 1
    // ========================================================

    if (
        preview.conflictRemovals.length >
            0
    ) {

        lines.push("");

        lines.push(
            "🧹 *STEP 1 — JOB CONFLICT CLEANUP*"
        );

        for (
            const item of
            preview.conflictRemovals
        ) {

            lines.push(

                `• @${numberLabel(item.employee.userId)} — ${titleCase(item.employee.position)} (${item.reason})`

            );

        }

    }


    // ========================================================
    // STEP 2
    // ========================================================

    if (
        preview.step === 2
    ) {

        lines.push("");

        lines.push(
            "🛠️ *STEP 2 — EMPLOYEE GATE REPAIR*"
        );

        lines.push(
            `• Level ${preview.originalLevel} → 50`
        );

        lines.push(
            `• Fund penalty: ${formatPercent(preview.penaltyPercent)}`
        );

    }


    // ========================================================
    // STEP 3
    // ========================================================

    if (
        preview.step === 3
    ) {

        lines.push("");

        lines.push(
            "🛠️ *STEP 3 — LEVEL CAP REPAIR*"
        );

        lines.push(
            `• Level ${preview.originalLevel} → 100`
        );

        lines.push(
            `• Fund penalty: ${formatPercent(preview.penaltyPercent)}`
        );

    }


    if (
        preview.step !== 0
    ) {

        lines.push("");

        lines.push(
            `📝 ${preview.reason}`
        );

        lines.push(
            `💸 Funds removed: ${preview.penaltyAmount.toLocaleString()} 🌙`
        );

    }


    lines.push("");

    lines.push(
        DIVIDER
    );

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
    msg,
    text
) {

    const sender =
        senderId(msg);

    const users =
        loadUsers();

    // Always determine target from the
    // actual command/reply/mention first.
    const target =
        getFixCompanyTarget(
            msg,
            text,
            users
        );


    // ========================================================
    // SENDER MUST EXIST
    // ========================================================

    if (!users[sender]) {

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    noticeBox(
                        "👤",
                        "𝙉𝙊𝙏 𝙍𝙀𝙂𝙄𝙎𝙏𝙀𝙍𝙀𝘿",
                        "Please register first.\n\n📥 .register YOUR_NAME"
                    )
            },
            { quoted: msg }
        );

        return true;

    }


    // ========================================================
    // TARGET ERROR
    // ========================================================

    if (target.error) {

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    noticeBox(
                        "⚠️",
                        "𝙁𝙄𝙓 𝘾𝙊𝙈𝙋𝘼𝙉𝙔",
                        target.error
                    ),

                mentions:
                    target.mentions || []

            },
            { quoted: msg }
        );

        return true;

    }


    // ========================================================
    // PERMISSION
    // ========================================================
    //
    // Regular user:
    //     .fixcompany
    //
    // Bot owner:
    //     .fixcompany
    //     .fixcompany @user
    //     .fixcompany [reply]
    //     .fixcompany all
    //

    const isExternalTarget =
        target.mode ===
            "target" &&
        target.ownerId !==
            sender;

    const requiresOwner =
        target.mode ===
            "all" ||
        isExternalTarget;

    if (
        requiresOwner &&
        !isBotOwner(sender)
    ) {

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    noticeBox(
                        "🔒",
                        "𝘼𝘿𝙈𝙄𝙉 𝙊𝙉𝙇𝙔",
                        target.mode ===
                            "all"

                            ? "Only a bot owner can run *.fixcompany all*."

                            : "Only a bot owner can repair another user's company by reply/tag."
                    )
            },
            { quoted: msg }
        );

        return true;

    }


    // ========================================================
    // NORMAL TARGET MUST HAVE A COMPANY
    // ========================================================

    if (
        target.mode !==
            "all" &&
        !users[
            target.ownerId
        ]?.company
    ) {

        await sock.sendMessage(
            msg.key.remoteJid,
            {

                text:
                    noticeBox(

                        "⚠️",

                        "𝙉𝙊 𝘾𝙊𝙈𝙋𝘼𝙉𝙔",

                        target.ownerId ===
                            sender

                            ? "You don't own a company yet."

                            : `@${numberLabel(target.ownerId)} does not own a company.`

                    ),

                mentions:
                    [target.ownerId]

            },
            { quoted: msg }
        );

        return true;

    }


    // ========================================================
    // BUILD PREVIEWS
    // ========================================================

    let previews;

    if (
        target.mode ===
            "all"
    ) {

        previews =
            Object.keys(users)

                .filter(
                    ownerId =>
                        users[
                            ownerId
                        ]?.company
                )

                .map(
                    ownerId =>
                        buildFixPreview(
                            users,
                            ownerId
                        )
                )

                .filter(
                    preview =>
                        preview &&
                        preview.needsRepair
                );

    } else {

        const preview =
            buildFixPreview(
                users,
                target.ownerId
            );

        previews =
            preview
                ? [preview]
                : [];

    }


    // ========================================================
    // NOTHING TO FIX
    // ========================================================

    if (
        previews.length ===
            0
    ) {

        await sock.sendMessage(
            msg.key.remoteJid,
            {

                text:
                    noticeBox(

                        "✅",

                        target.mode ===
                            "all"
                            ? "𝘼𝙇𝙇 𝘾𝙊𝙈𝙋𝘼𝙉𝙄𝙀𝙎 𝙁𝙄𝙉𝙀"
                            : "𝘾𝙊𝙈𝙋𝘼𝙉𝙔 𝙄𝙎 𝙁𝙄𝙉𝙀",

                        target.mode ===
                            "all"

                            ? "No player companies currently need a legacy repair.\n\nNo changes were made."

                            : `*${users[target.ownerId].company.name}* does not need a legacy repair.\n\nNo changes were made.`

                    )

            },
            { quoted: msg }
        );

        return true;

    }


    // ========================================================
    // SAVE CONFIRMATION
    // ========================================================

    pendingFixConfirmations.set(
        sender,
        {

            createdAt:
                Date.now(),

            mode:
                target.mode,

            ownerId:
                target.ownerId ||
                null

        }
    );


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


    if (
        typeof expiryTimer.unref ===
            "function"
    ) {

        expiryTimer.unref();

    }


    // ========================================================
    // ALL PREVIEW
    // ========================================================

    if (
        target.mode ===
            "all"
    ) {

        const lines = [

            "⚠️ *ALL LEGACY COMPANY REPAIRS*",

            "",

            `🏢 Companies needing repair: ${previews.length}`,

            ""

        ];

        for (
            const [
                index,
                preview
            ] of previews.entries()
        ) {

            lines.push(

                `${index + 1}. *${preview.companyName}*`,

                `   📊 Level: ${preview.originalLevel} → ${preview.finalLevel}`,

                `   👥 Employees: ${preview.originalEmployeeCount} → ${preview.finalEmployeeCount}`,

                `   💸 Penalty: ${formatPercent(preview.penaltyPercent)} (-${preview.penaltyAmount.toLocaleString()} 🌙)`,

                ""

            );

        }

        lines.push(

            DIVIDER,

            "⚠️ This will repair every player company listed above.",

            "Reply with *.yes* to apply ALL repairs or *.no* to cancel."

        );

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    lines.join("\n")
            },
            { quoted: msg }
        );

        return true;

    }


    // ========================================================
    // SINGLE COMPANY PREVIEW
    // ========================================================

    const preview =
        previews[0];

    await sock.sendMessage(
        msg.key.remoteJid,
        {

            text:
                buildFixPreviewMessage(
                    preview
                ),

            mentions:
                preview
                    .conflictRemovals
                    .map(
                        item =>
                            item.employee.userId
                    )

        },
        { quoted: msg }
    );

    return true;

}


// ============================================================
// APPLY ONE COMPANY REPAIR
// ============================================================

async function applyOneCompanyRepair(
    users,
    ownerId
) {

    const preview =
        buildFixPreview(
            users,
            ownerId
        );

    if (
        !preview?.needsRepair
    ) {

        return {

            preview,

            removedEmployees:
                [],

            repair:
                null,

            penaltyAmount:
                0,

            changed:
                false

        };

    }

    const company =
        users[ownerId].company;

    company.employees =
        company.employees ||
        {};

    const now =
        Date.now();

    const removedEmployees =
        [];


    // ========================================================
    // STEP 1
    // ========================================================

    for (
        const item of
        preview.conflictRemovals
    ) {

        const removed =
            removeEmployeeFromPlayerCompany(

                users,

                ownerId,

                item.employeeId,

                now

            );

        if (removed) {

            removedEmployees.push(
                removed
            );

        }

    }


    // ========================================================
    // RECALCULATE AFTER STEP 1
    // ========================================================

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


    return {

        preview,

        removedEmployees,

        repair,

        penaltyAmount,

        changed:
            true,

        levelBeforeRepair,

        employeeCountAfterCleanup,

        walletBeforeRepair,

        finalWallet:
            company.wallet,

        finalLevel:
            company.level,

        companyName:
            company.name

    };

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

    // No .fixcompany confirmation waiting.
    // Return false so .reseteconomy
    // can process its own .yes/.no.
    if (!pending) {

        return false;

    }


    // ========================================================
    // EXPIRED
    // ========================================================

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

                text:
                    noticeBox(

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


    // ========================================================
    // CANCEL
    // ========================================================

    if (
        choice === ".no"
    ) {

        await sock.sendMessage(
            msg.key.remoteJid,
            {

                text:
                    noticeBox(

                        "❎",

                        "𝙁𝙄𝙓 𝘾𝘼𝙉𝘾𝙀𝙇𝙇𝙀𝘿",

                        "No company changes were made."

                    )

            },
            { quoted: msg }
        );

        return true;

    }


    // ========================================================
    // RELOAD CURRENT DATA
    // ========================================================

    const users =
        loadUsers();

    let ownerIds;


    if (
        pending.mode ===
            "all"
    ) {

        ownerIds =
            Object.keys(users)
                .filter(
                    ownerId =>
                        users[
                            ownerId
                        ]?.company
                );

    } else {

        ownerIds =
            pending.ownerId
                ? [pending.ownerId]
                : [];

    }


    if (
        ownerIds.length ===
            0
    ) {

        await sock.sendMessage(
            msg.key.remoteJid,
            {

                text:
                    noticeBox(

                        "⚠️",

                        "𝙁𝙄𝙓 𝙁𝘼𝙄𝙇𝙀𝘿",

                        "The target company could not be found. No changes were made."

                    )

            },
            { quoted: msg }
        );

        return true;

    }


    const results =
        [];

    const removedEmployees =
        [];


    // ========================================================
    // APPLY
    // ========================================================

    for (
        const ownerId of
        ownerIds
    ) {

        if (
            !users[
                ownerId
            ]?.company
        ) {

            continue;

        }

        const result =
            await applyOneCompanyRepair(

                users,

                ownerId

            );

        if (
            !result.changed
        ) {

            continue;

        }

        results.push(
            result
        );

        removedEmployees.push(
            ...result.removedEmployees
        );

    }


    saveUsers(
        users
    );


    // ========================================================
    // NOTHING LEFT TO CHANGE
    // ========================================================

    if (
        results.length ===
            0
    ) {

        await sock.sendMessage(
            msg.key.remoteJid,
            {

                text:
                    noticeBox(

                        "✅",

                        pending.mode ===
                            "all"
                            ? "𝘼𝙇𝙇 𝙁𝙄𝙉𝙀"
                            : "𝙉𝙊 𝙍𝙀𝙋𝘼𝙄𝙍 𝙉𝙀𝙀𝘿𝙀𝘿",

                        pending.mode ===
                            "all"

                            ? "All companies are already compliant.\n\nNo changes were made."

                            : "The company is already compliant.\n\nNo changes were made."

                    )

            },
            { quoted: msg }
        );

        return true;

    }


    // ========================================================
    // RESULT MESSAGE
    // ========================================================

    const changeLines =
        [];


    if (
        pending.mode ===
            "all"
    ) {

        changeLines.push(

            `🏢 Companies repaired: ${results.length}`,

            `🧹 Conflicting employees removed: ${removedEmployees.length}`,

            ""

        );


        for (
            const result of
            results
        ) {

            changeLines.push(

                `• *${result.companyName}*`,

                `  📊 Level: ${result.levelBeforeRepair} → ${result.finalLevel}`,

                `  👥 Employees: ${result.preview.originalEmployeeCount} → ${result.employeeCountAfterCleanup}`,

                `  💸 Penalty: ${formatPercent(result.repair.penaltyPercent)} (-${result.penaltyAmount.toLocaleString()} 🌙)`,

                ""

            );

        }

    } else {

        const result =
            results[0];

        changeLines.push(

            `🏢 Company: *${result.companyName}*`,

            `👥 Employees: ${result.preview.originalEmployeeCount} → ${result.employeeCountAfterCleanup}`,

            `📊 Level: ${result.levelBeforeRepair} → ${result.finalLevel}`,

            `🏦 Wallet: ${result.walletBeforeRepair.toLocaleString()} 🌙 → ${result.finalWallet.toLocaleString()} 🌙`

        );


        if (
            result.removedEmployees.length >
                0
        ) {

            changeLines.push(

                "",

                `🧹 Conflicting employees removed: ${result.removedEmployees.length}`,

                ...result.removedEmployees.map(

                    employee =>
                        `• @${numberLabel(employee.userId)} — ${titleCase(employee.position)}`

                )

            );

        }


        if (
            result.repair.penaltyPercent >
                0
        ) {

            changeLines.push(

                "",

                `💸 Fund penalty: ${formatPercent(result.repair.penaltyPercent)} (-${result.penaltyAmount.toLocaleString()} 🌙)`

            );

        } else if (
            result.levelBeforeRepair !==
            result.finalLevel
        ) {

            changeLines.push(

                "",

                "💸 Fund penalty: none"

            );

        }

    }


    changeLines.push(

        "",

        DIVIDER,

        pending.mode ===
            "all"

            ? "✅ All requested company repairs completed successfully."

            : "✅ Company repair completed successfully.",

        "📚 Employee career history was preserved for everyone removed."

    );


    await sock.sendMessage(
        msg.key.remoteJid,
        {

            text:
                noticeBox(

                    "🛠️",

                    pending.mode ===
                        "all"

                        ? "𝘾𝙊𝙈𝙋𝘼𝙉𝙄𝙀𝙎 𝙁𝙄𝙓𝙀𝘿"

                        : "𝘾𝙊𝙈𝙋𝘼𝙉𝙔 𝙁𝙄𝙓𝙀𝘿",

                    changeLines.join(
                        "\n"
                    )

                ),

            mentions:
                removedEmployees.map(
                    employee =>
                        employee.userId
                )

        },
        { quoted: msg }
    );


    // ========================================================
    // NOTIFY REMOVED EMPLOYEES
    // ========================================================

    for (
        const employee of
        removedEmployees
    ) {

        try {

            await sock.sendMessage(
                employee.userId,
                {

                    text:
                        noticeBox(

                            "📤",

                            "𝙀𝙈𝙋𝙇𝙊𝙔𝙈𝙀𝙉𝙏 𝙍𝙀𝙈𝙊𝙑𝙀𝘿",

                            `Your employment at *${employee.companyName}* was removed during a company repair because your account had another active employment record.

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
// ROUTER
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
        command ===
            ".fixcompany" ||

        command.startsWith(
            ".fixcompany "
        )
    ) {

        return await fixCompanyCommand(
            sock,
            msg,
            text
        );

    }


    if (
        command ===
            ".fire" ||

        command.startsWith(
            ".fire "
        )
    ) {

        return await fireCommand(
            sock,
            msg,
            text
        );

    }


    if (
        command ===
            ".yes" ||

        command ===
            ".no"
    ) {

        return await companyAdminConfirmationCommand(

            sock,

            msg,

            command

        );

    }


    return false;

}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

    companyAdminCommand,

    fireCommand,

    fixCompanyCommand,

    companyAdminConfirmationCommand,

    calculatePenaltyPercent,

    buildFixPreview,

    listPlayerCompanyJobs,

    listAllJobs,

    findEmployeeByCode,

    MAX_COMPANY_LEVEL,

    EMPLOYEE_GATE_LEVEL,

    EMPLOYEE_GATE_MIN_COUNT,

    BASE_FIX_PENALTY_PERCENT,

    EXTRA_PENALTY_PER_50_LEVELS

};