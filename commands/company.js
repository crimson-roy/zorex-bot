const fs = require("fs");
const dataPath = require("../lib/dataPath");
const { isValidIndustry, getIndustry, listIndustryKeys, isValidPosition, positionRate, getMaxSlots, titleCase } = require("../lib/industries");
const { getNextOfferId } = require("../lib/jobOffers");
const { tierForLevel } = require("../lib/tierStar");
const { loadInventory, saveInventory } = require("./inventory");
const { ASSETS } = require("./invest");

// Company-wide employee cap (spec §7) — applies across ALL positions
// combined, not per-position.
const MAX_EMPLOYEES = 50;

// Level ceiling — a company cannot upgrade past this.
const MAX_COMPANY_LEVEL = 100;

// From this level onward, upgrading further requires a minimum
// headcount — a company can't just buy its way to the top solo.
const EMPLOYEE_GATE_LEVEL = 50;
const EMPLOYEE_GATE_MIN_COUNT = 3;

// PERSISTENCE FIX: real per-user state, written every payout/upgrade —
// routed through dataPath() so it survives a redeploy. See lib/dataPath.js.
const USERS_FILE = dataPath("users.json");

// ---------- Tunable economy constants ----------
const CREATE_COST = 2000000000;
const BASE_INCOME = 500000;
const INCOME_MULTIPLIER = 1.17;
const BASE_UPGRADE_COST = 100000;
const UPGRADE_COST_MULTIPLIER = 1.09;

const PAYOUT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function loadUsers() {

    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");

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

function notRegisteredMessage() {
    return `╭━━━━ ⚠️ 𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗔𝗧𝗜𝗢𝗡 ━━━━╮
👤 Please register your account. ✨
────── 📝 𝗙𝗢𝗥𝗠𝗔𝗧 ──────
⌨️ .register YOUR_NAME
────── 💡 𝗘𝗫𝗔𝗠𝗣𝗟𝗘 ──────
🔥 .register Crimson Roy
╰━━━━━━━━━━━━━━━━━━━━━━━╯`;
}

function noCompanyMessage() {
    return errorBox("𝗡𝗢 𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗬𝗘𝗧", `You don't have a company yet.\nStart one for ${CREATE_COST.toLocaleString()} 🌙.`, [".companycreate Roy Trading Group animation"]);
}

function errorBox(title, message, examples) {
    const exampleLines = examples.map(e => `  📥 ${e}`).join("\n");
    return `╭━━━━ ⚠️ ${title} ━━━━╮
   ${message}
  ─── 📝 𝖤𝖷𝖠𝖬𝖯𝖫𝖤 ───
${exampleLines}
╰━━━━━━━━━━━━━━━━━━━━━━━╯`;
}

async function replyNotRegistered(sock, msg) {
    return await sock.sendMessage(msg.key.remoteJid, { text: notRegisteredMessage() }, { quoted: msg });
}

async function replyNoCompany(sock, msg) {
    return await sock.sendMessage(msg.key.remoteJid, { text: noCompanyMessage() }, { quoted: msg });
}

function incomeAtLevel(level) {
    return Math.round(BASE_INCOME * Math.pow(INCOME_MULTIPLIER, level));
}

// Duty/attendance tuning (see lib/dutyFlavor.js for the .duty command
// itself, in commands/jobs.js — kept there since it's employee-facing).
const DUTY_COOLDOWN_MS = 2 * 60 * 60 * 1000;      // 2 hours between check-ins
const DUTY_DAILY_CAP = 3;                          // max check-ins per rolling 24h
const DUTY_LOG_RETENTION_MS = 60 * 24 * 60 * 60 * 1000; // prune entries older than 60 days
const DUTY_WEEKLY_BONUS_THRESHOLD = 15;            // check-ins needed in a rolling 7 days
const DUTY_WEEKLY_BONUS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function upgradeCostAtLevel(level) {
    return Math.round(BASE_UPGRADE_COST * Math.pow(UPGRADE_COST_MULTIPLIER, level));
}

function formatDuration(ms) {

    const totalMinutes = Math.max(0, Math.floor(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    return `${hours}h ${minutes}m`;

}

const {
    startEmployment,
    updatePosition
} = require("../lib/portfolioHistory");

function generateEmployeeCode(company) {

    const existing = new Set(Object.values(company.employees || {}).map(e => e.code));
    let code;

    do {
        code = "EMP-" + Math.floor(1000 + Math.random() * 9000);
    } while (existing.has(code));

    return code;

}

function wasOnDutyDuring(employee, start, end) {
    const log = employee.dutyLog || [];
    return log.some(ts => ts >= start && ts < end);
}

function collectPendingIncome(users, userId) {

    const company = users[userId].company;

    if (!company) return null;

    company.wallet = company.wallet || 0;
    company.employees = company.employees || {};

    const now = Date.now();
    const elapsed = now - company.lastPayout;
    const periods = Math.floor(elapsed / PAYOUT_INTERVAL_MS);

    if (periods <= 0) return null;

    const incomePerPeriod = incomeAtLevel(company.level);
    const periodStartBase = company.lastPayout;

    let totalIncome = 0;
    let totalPaidToEmployees = 0;
    const employeePayouts = {};

    for (let i = 0; i < periods; i++) {

        totalIncome += incomePerPeriod;

        const periodStart = periodStartBase + i * PAYOUT_INTERVAL_MS;
        const periodEnd = periodStart + PAYOUT_INTERVAL_MS;

        for (const employeeId of Object.keys(company.employees)) {

            const employee = company.employees[employeeId];
            const rate = employee.salaryRate || 0;

            if (rate <= 0) continue;

            if (users[employee.userId]?.jobResignation) continue;

            if (!wasOnDutyDuring(employee, periodStart, periodEnd)) continue;

            const amount = Math.round(incomePerPeriod * (rate / 100));

            totalPaidToEmployees += amount;
            employeePayouts[employee.userId] = (employeePayouts[employee.userId] || 0) + amount;

        }

    }

    const netToCompanyWallet = totalIncome - totalPaidToEmployees;

    company.wallet += netToCompanyWallet;
    company.lastPayout += periods * PAYOUT_INTERVAL_MS;

    for (const empUserId of Object.keys(employeePayouts)) {
        if (users[empUserId]) {
            users[empUserId].wallet = (users[empUserId].wallet || 0) + employeePayouts[empUserId];
        }
    }

    saveUsers(users);

    return { totalIncome, totalSalaries: totalPaidToEmployees, netToCompanyWallet, employeePayouts };

}


async function companyStatusView(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    const company = users[sender].company;

    if (!company) return await replyNoCompany(sock, msg);

    const settlement = collectPendingIncome(users, sender);
    const income = incomeAtLevel(company.level);
    const nextUpgradeCost = upgradeCostAtLevel(company.level);
    const timeLeft = formatDuration(company.lastPayout + PAYOUT_INTERVAL_MS - Date.now());
    const industry = getIndustry(company.industry);
    const industryLine = industry ? `» Industry: ${industry.label}\n` : "";
    const tier = tierForLevel(company.level);

    let collectedLine = "";

    if (settlement && settlement.totalIncome > 0) {

        collectedLine = settlement.totalSalaries > 0
            ? `💸 *${settlement.totalIncome.toLocaleString()} 🌙 earned* — ${settlement.totalSalaries.toLocaleString()} 🌙 paid in salaries, ${settlement.netToCompanyWallet.toLocaleString()} 🌙 added to the company wallet!\n\n`
            : `💸 *${settlement.totalIncome.toLocaleString()} 🌙 added to the company wallet!*\n\n`;

    }

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `${collectedLine}╭━━━━━━━━━━━━━━━━━━━━━━━╮
       𖤓 𝗬𝗢𝗨𝗥 𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𖤓
╰━━━━━━━━━━━━━━━━━━━━━━━╮
» Name    : ${company.name}
${industryLine}» Level   : ${company.level}
» Tier    : ${tier}
» Income  : ${income.toLocaleString()} 🌙 every 24h
» Next Up : ${nextUpgradeCost.toLocaleString()} 🌙 (.companyupgrade)
» Payout  : in ${timeLeft}
━━━━━━━━━━━━━━━━━━━━━━━━━
» 🏢 Company Wallet : ${(company.wallet || 0).toLocaleString()} 🌙
» 💳 Personal Wallet: ${users[sender].wallet.toLocaleString()} 🌙
━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ Powered by Zorex AI`
        },
        { quoted: msg }
    );

}


async function companyDeposit(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await replyNotRegistered(sock, msg);
    }

    const company = users[sender].company;

    if (!company) {
        return await replyNoCompany(sock, msg);
    }

    company.wallet = Number(company.wallet) || 0;
    company.assets = company.assets || [];

    const parts = text.trim().split(/\s+/);

    const kind = (parts[2] || "").toLowerCase();
    const amountText = parts[3] || "";

    if (!kind) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: errorBox(
                    "𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗗𝗘𝗣𝗢𝗦𝗜𝗧",
                    "Specify what you want to deposit.",
                    [
                        ".company deposit crescent 50000",
                        ".company deposit gold 2"
                    ]
                )
            },
            { quoted: msg }
        );

    }

    if (kind === "crescent") {

        const amount = Number(
            amountText.replace(/,/g, "")
        );

        if (
            !amountText ||
            !Number.isFinite(amount) ||
            amount <= 0
        ) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text: errorBox(
                        "𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗗𝗘𝗣𝗢𝗦𝗜𝗧",
                        "Enter a valid Crescent amount.",
                        [
                            ".company deposit crescent 50000"
                        ]
                    )
                },
                { quoted: msg }
            );

        }

        const personalWallet =
            Number(users[sender].wallet) || 0;

        if (personalWallet < amount) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`❌ You don't have enough Crescents in your personal wallet.

💳 Personal Wallet: ${personalWallet.toLocaleString()} 🌙
💸 Requested: ${amount.toLocaleString()} 🌙`
                },
                { quoted: msg }
            );

        }

        users[sender].wallet =
            personalWallet - amount;

        company.wallet += amount;

        try {

            saveUsers(users);

        } catch (err) {

            console.error(
                "❌ Failed to save company Crescent deposit:",
                err.message
            );

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
                        `❌ The deposit could not be saved. Your balances were not committed.`
                },
                { quoted: msg }
            );

        }

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`✅ *COMPANY DEPOSIT SUCCESSFUL!*

🏢 Company:
${company.name}

💸 Deposited:
${amount.toLocaleString()} 🌙

💳 Personal Wallet:
${users[sender].wallet.toLocaleString()} 🌙

🏢 Company Wallet:
${company.wallet.toLocaleString()} 🌙`
            },
            { quoted: msg }
        );

    }

    const def = ASSETS[kind];

    if (!def) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: errorBox(
                    "𝗨𝗡𝗞𝗡𝗢𝗪𝗡 𝗗𝗘𝗣𝗢𝗦𝗜𝗧 𝗧𝗬𝗣𝗘",
                    `"${kind}" isn't "crescent" or a valid asset ID.`,
                    [
                        ".company deposit crescent 50000",
                        ".company deposit gold 2"
                    ]
                )
            },
            { quoted: msg }
        );

    }

    const amount = Number(amountText);

    if (
        !amountText ||
        !Number.isInteger(amount) ||
        amount <= 0
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: errorBox(
                    "𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗗𝗘𝗣𝗢𝗦𝗜𝗧",
                    "Enter a valid whole-number asset quantity.",
                    [
                        `.company deposit ${kind} 2`
                    ]
                )
            },
            { quoted: msg }
        );

    }

    const inventory = loadInventory();
    const items = inventory[sender] || [];

    const holding = items.find(
        item =>
            item.id === kind &&
            item.type === "asset"
    );

    const owned = holding
        ? Number(holding.quantity) || 0
        : 0;

    if (owned < amount) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`❌ You only hold ${owned} ${def.name}.

💼 Requested: ${amount}
📦 Available: ${owned}`
            },
            { quoted: msg }
        );

    }

    holding.quantity -= amount;

    if (holding.quantity <= 0) {

        inventory[sender] = items.filter(
            item =>
                !(item.id === kind && item.type === "asset")
        );

    }

    try {

        saveInventory(inventory);

    } catch (err) {

        console.error(
            "❌ Failed to save personal inventory:",
            err.message
        );

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    `❌ The asset deposit could not be saved.`
            },
            { quoted: msg }
        );

    }

    const companyHolding =
        company.assets.find(
            asset => asset.id === kind
        );

    if (companyHolding) {

        companyHolding.quantity += amount;

    } else {

        company.assets.push({
            id: kind,
            quantity: amount,
            obtainedAt: Date.now()
        });

    }

    try {

        saveUsers(users);

    } catch (err) {

        console.error(
            "❌ Failed to save company asset deposit:",
            err.message
        );

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
                    `⚠️ The asset was removed from your inventory, but the company update could not be saved. Check the data before retrying.`
            },
            { quoted: msg }
        );

    }

    const companyNowHolds =
        companyHolding
            ? companyHolding.quantity
            : amount;

    const personalNowHolds =
        Math.max(0, holding.quantity || 0);

    return await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`${def.emoji} *COMPANY ASSET DEPOSITED!*

🏢 Company:
${company.name}

📦 Asset:
${def.name} x${amount}

🏢 Company Holdings:
${companyNowHolds} ${def.name}

💼 Your Remaining Holdings:
${personalNowHolds} ${def.name}`
        },
        { quoted: msg }
    );

}


async function companyDistribute(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    const company = users[sender].company;
    if (!company) return await replyNoCompany(sock, msg);

    company.wallet = company.wallet || 0;
    company.employees = company.employees || {};

    const context = msg.message?.extendedTextMessage?.contextInfo;

    let target = null;
    if (context?.participant) target = context.participant;
    else if (context?.mentionedJid?.length) target = context.mentionedJid[0];

    if (!target) {

        if (company.wallet <= 0) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text: `⚠️ The company wallet is empty — nothing to withdraw.`
                },
                { quoted: msg }
            );

        }

        const amountText = text
            .replace(".company", "")
            .replace("distribute", "")
            .trim();

        let amount;

        if (!amountText) {

            amount = company.wallet;

        } else {

            amount = Number(
                amountText.replace(/,/g, "")
            );

            if (
                !Number.isFinite(amount) ||
                amount <= 0
            ) {

                return await sock.sendMessage(
                    msg.key.remoteJid,
                    {
                        text: errorBox(
                            "𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗗𝗜𝗦𝗧𝗥𝗜𝗕𝗨𝗧𝗘",
                            "Enter a valid amount to withdraw.",
                            [
                                ".company distribute",
                                ".company distribute 50000"
                            ]
                        )
                    },
                    { quoted: msg }
                );

            }

            if (amount > company.wallet) {

                return await sock.sendMessage(
                    msg.key.remoteJid,
                    {
                        text:
`❌ Not enough in the company wallet.

🏢 Company Wallet: ${company.wallet.toLocaleString()} 🌙
💸 Requested: ${amount.toLocaleString()} 🌙`
                    },
                    { quoted: msg }
                );

            }

        }

        company.wallet -= amount;
        users[sender].wallet += amount;

        saveUsers(users);

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`✅ *Company Withdrawal Successful!*

🏢 Company: ${company.name}

💸 Withdrawn:
${amount.toLocaleString()} 🌙

🏢 Company Wallet:
${company.wallet.toLocaleString()} 🌙

💳 Personal Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
            },
            { quoted: msg }
        );

    }

    const employeeEntry = Object.values(company.employees).find(e => e.userId === target);

    if (!employeeEntry) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ That person isn't on *${company.name}*'s employee roster.`
        }, { quoted: msg });
    }

    const amountText = text.replace(".company", "").replace("distribute", "").replace(/@\d+/g, "").trim();
    const amount = Number(amountText);

    if (!amountText || isNaN(amount) || amount <= 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: errorBox("𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗗𝗜𝗦𝗧𝗥𝗜𝗕𝗨𝗧𝗘", "Enter a valid amount to pay this employee.", [".company distribute @user 5000"])
        }, { quoted: msg });
    }

    if (company.wallet < amount) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ Not enough in the company wallet.\n\n🏢 Company Wallet: ${company.wallet.toLocaleString()} 🌙`
        }, { quoted: msg });
    }

    if (!users[target]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ That employee's profile could not be found.`
        }, { quoted: msg });
    }

    company.wallet -= amount;
    users[target].wallet += amount;

    saveUsers(users);

    return await sock.sendMessage(msg.key.remoteJid, {
        text: `✅ Paid @${target.split("@")[0]} ${amount.toLocaleString()} 🌙 from *${company.name}*'s company wallet.\n\n🏢 Company Wallet: ${company.wallet.toLocaleString()} 🌙`,
        mentions: [target]
    }, { quoted: msg });

}


async function companyAssign(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    const company = users[sender].company;
    if (!company) return await replyNoCompany(sock, msg);

    company.employees = company.employees || {};

    const context = msg.message?.extendedTextMessage?.contextInfo;

    let target = null;
    if (context?.participant) target = context.participant;
    else if (context?.mentionedJid?.length) target = context.mentionedJid[0];

    const role = text
        .replace(".company", "")
        .replace("assign", "")
        .replace(/@\d+/g, "")
        .trim()
        .toLowerCase();

    if (!target || !role) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: errorBox("𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗔𝗦𝗦𝗜𝗚𝗡", "Mention the employee and specify a role.", [".company assign investor @user"])
        }, { quoted: msg });
    }

    const employeeId = Object.keys(company.employees).find(id => company.employees[id].userId === target);

    if (!employeeId) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ That person isn't on *${company.name}*'s employee roster.`
        }, { quoted: msg });
    }

    company.employees[employeeId].role = role;

    saveUsers(users);

    return await sock.sendMessage(msg.key.remoteJid, {
        text: `✅ @${target.split("@")[0]} has been assigned the *${role}* role at *${company.name}*.`,
        mentions: [target]
    }, { quoted: msg });

}


async function companyCommand(sock, msg, text) {

    const trimmed =
        (text || ".company").trim();

    const parts =
        trimmed.split(/\s+/);

    const sub =
        (parts[1] || "").toLowerCase();

    if (sub === "deposit") {
        return await companyDeposit(
            sock,
            msg,
            trimmed
        );
    }

    if (sub === "distribute") {
        return await companyDistribute(
            sock,
            msg,
            trimmed
        );
    }

    if (sub === "assign") {
        return await companyAssign(
            sock,
            msg,
            trimmed
        );
    }

    if (sub === "promote") {
        return await companyPromoteCommand(
            sock,
            msg,
            trimmed
        );
    }

    if (sub === "disapprove") {
        return await companyDisapproveCommand(
            sock,
            msg,
            trimmed
        );
    }

    return await companyStatusView(
        sock,
        msg
    );

}

async function companyCreateCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    if (users[sender].company) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: `⚠️ You already own a company — *${users[sender].company.name}*.\n\nUse .companyupgrade to grow it instead.` },
            { quoted: msg }
        );
    }

    const rest = text.replace(".companycreate", "").trim();
    const tokens = rest.split(/\s+/).filter(Boolean);

    if (tokens.length < 2) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: errorBox(
                    "𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗖𝗥𝗘𝗔𝗧𝗘",
                    `Enter a name AND an industry.\n\n📚 Industries: ${listIndustryKeys().join(", ")}`,
                    [".companycreate Roy Trading Group animation"]
                )
            },
            { quoted: msg }
        );
    }

    const industryArg = tokens[tokens.length - 1].toLowerCase();
    const name = tokens.slice(0, -1).join(" ");

    if (!isValidIndustry(industryArg)) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: errorBox(
                    "𝗨𝗡𝗞𝗡𝗢𝗪𝗡 𝗜𝗡𝗗𝗨𝗦𝗧𝗥𝗬",
                    `"${industryArg}" isn't an available industry yet.\n\n📚 Available: ${listIndustryKeys().join(", ")}`,
                    [".companycreate Roy Trading Group animation"]
                )
            },
            { quoted: msg }
        );
    }

    if (!name) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: errorBox("𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗖𝗥𝗘𝗔𝗧𝗘", "Enter a name for your company.", [".companycreate Roy Trading Group animation"]) },
            { quoted: msg }
        );
    }

    if (users[sender].wallet < CREATE_COST) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: `❌ You need ${CREATE_COST.toLocaleString()} 🌙 in your wallet to start a company.\n\n💰 Wallet: ${users[sender].wallet.toLocaleString()} 🌙` },
            { quoted: msg }
        );
    }

    users[sender].wallet -= CREATE_COST;

    users[sender].company = {
        name: name,
        industry: industryArg,
        level: 0,
        createdAt: Date.now(),
        lastPayout: Date.now(),
        wallet: 0,
        employees: {}
    };

    saveUsers(users);

    const industry = getIndustry(industryArg);

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
   🏢 𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗖𝗥𝗘𝗔𝗧𝗘𝗗 🏢
╰━━━━━━━━━━━━━━━━━━━━━━━╮
» Name     : ${name}
» Industry : ${industry.label}
» Income   : ${incomeAtLevel(0).toLocaleString()} 🌙 every 24h
» Wallet   : ${users[sender].wallet.toLocaleString()} 🌙
━━━━━━━━━━━━━━━━━━━━━━━━━
Use .companyupgrade to grow your empire.`
        },
        { quoted: msg }
    );

}

// ---------- .companyupgrade — level up, cost +9%, income +17% each time ----------
//
// FIX: two rules the owner intended but that were never actually wired
// into this function — added here, nowhere else changed:
//   1. Hard ceiling at MAX_COMPANY_LEVEL (100) — refuses once already there.
//   2. From EMPLOYEE_GATE_LEVEL (50) onward, requires at least
//      EMPLOYEE_GATE_MIN_COUNT (3) employees to upgrade further.
// Both checks run BEFORE collectPendingIncome()/the cost check, so a
// blocked upgrade never wastes a write settling income first.
async function companyUpgradeCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    const company = users[sender].company;

    if (!company) return await replyNoCompany(sock, msg);

    if (company.level >= MAX_COMPANY_LEVEL) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: `🏆 *${company.name}* is already at the maximum level (${MAX_COMPANY_LEVEL}) — there's nowhere higher to grow.` },
            { quoted: msg }
        );
    }

    if (company.level >= EMPLOYEE_GATE_LEVEL) {

        const employeeCount = Object.keys(company.employees || {}).length;

        if (employeeCount < EMPLOYEE_GATE_MIN_COUNT) {
            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text: `⚠️ Companies at level ${EMPLOYEE_GATE_LEVEL}+ need at least ${EMPLOYEE_GATE_MIN_COUNT} employees to keep growing.\n\n👥 Current employees: ${employeeCount}/${EMPLOYEE_GATE_MIN_COUNT}\n\nHire more via .companyoffer before upgrading further.`
                },
                { quoted: msg }
            );
        }

    }

    // Settle any income owed before spending, so nothing is lost to the upgrade
    collectPendingIncome(users, sender);

    const cost = upgradeCostAtLevel(company.level);

    if (users[sender].wallet < cost) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: `❌ You need ${cost.toLocaleString()} 🌙 to upgrade *${company.name}*.\n\n💰 Wallet: ${users[sender].wallet.toLocaleString()} 🌙` },
            { quoted: msg }
        );
    }

    users[sender].wallet -= cost;
    company.level += 1;

    saveUsers(users);

    const newIncome = incomeAtLevel(company.level);
    const nextCost = upgradeCostAtLevel(company.level);

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
  🏢 𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗨𝗣𝗚𝗥𝗔𝗗𝗘𝗗 🏢
╰━━━━━━━━━━━━━━━━━━━━━━━╮
» Name       : ${company.name}
» New Level  : ${company.level}
» New Income : ${newIncome.toLocaleString()} 🌙 every 24h
» Wallet     : ${users[sender].wallet.toLocaleString()} 🌙
━━━━━━━━━━━━━━━━━━━━━━━━━
Next upgrade costs ${nextCost.toLocaleString()} 🌙`
        },
        { quoted: msg }
    );

}

async function companyOfferCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    const company = users[sender].company;
    if (!company) return await replyNoCompany(sock, msg);

    company.offers = company.offers || {};
    company.employees = company.employees || {};

    const industry = getIndustry(company.industry);

    if (!industry) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ *${company.name}* has no industry set — this shouldn't happen for a company created after the industry update. Contact the owner.`
        }, { quoted: msg });
    }

    const catalogList = Object.entries(industry.positions).map(([p, def]) => `  📥 ${titleCase(p)} (max ${def.maxSlots})`).join("\n");

    const positionArg = text.replace(".companyoffer", "").trim();

    if (!positionArg) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `╭━━━━ ⚠️ 𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗢𝗙𝗙𝗘𝗥 ━━━━╮
   Specify a position to open.
  ─── 📚 ${industry.label} 𝗣𝗢𝗦𝗜𝗧𝗜𝗢𝗡𝗦 ───
${catalogList}
╰━━━━━━━━━━━━━━━━━━━━━━━╯`
        }, { quoted: msg });
    }

    const positionKey = positionArg.toLowerCase();

    if (!isValidPosition(company.industry, positionKey)) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `╭━━━━ ⚠️ 𝗨𝗡𝗞𝗡𝗢𝗪𝗡 𝗣𝗢𝗦𝗜𝗧𝗜𝗢𝗡 ━━━━╮
   "${positionArg}" isn't a position ${industry.label} companies can offer.
  ─── 📚 𝗔𝗩𝗔𝗜𝗟𝗔𝗕𝗟𝗘 ───
${catalogList}
╰━━━━━━━━━━━━━━━━━━━━━━━╯`
        }, { quoted: msg });
    }

    const maxSlots = getMaxSlots(company.industry, positionKey);
    const filledCount = Object.values(company.employees).filter(e => e.position === positionKey).length;

    if (filledCount >= maxSlots) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ *${titleCase(positionKey)}* is already fully staffed at *${company.name}* (${filledCount}/${maxSlots}).`
        }, { quoted: msg });
    }

    if (company.offers[positionKey]) {
        const offer = company.offers[positionKey];
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You already have an open offer for *${titleCase(positionKey)}* (#${offer.id}) — ${filledCount}/${maxSlots} filled, ${offer.pending.length} pending. Check .companyoffers.`
        }, { quoted: msg });
    }

    const employeeCount = Object.keys(company.employees).length;

    if (employeeCount >= MAX_EMPLOYEES) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ *${company.name}* is at the ${MAX_EMPLOYEES}-employee cap — no new offers until a position frees up.`
        }, { quoted: msg });
    }

    const offerId = getNextOfferId();

    company.offers[positionKey] = {
        id: offerId,
        position: positionKey,
        openedAt: Date.now(),
        pending: []
    };

    saveUsers(users);

    const rate = positionRate(company.industry, positionKey);
    const liveAmount = Math.round(incomeAtLevel(company.level) * (rate / 100));

    await sock.sendMessage(msg.key.remoteJid, {
        text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
   📢 𝗣𝗢𝗦𝗜𝗧𝗜𝗢𝗡 𝗢𝗣𝗘𝗡𝗘𝗗 📢
╰━━━━━━━━━━━━━━━━━━━━━━━╮
» Company : ${company.name}
» Position: ${titleCase(positionKey)}
» Salary  : ~${liveAmount.toLocaleString()} 🌙 per payout, each hire
» Slots   : ${filledCount}/${maxSlots}
» Offer # : ${offerId}
━━━━━━━━━━━━━━━━━━━━━━━━━
It's now live on .joboffers.`
    }, { quoted: msg });

}


async function companyOffersCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    const company = users[sender].company;
    if (!company) return await replyNoCompany(sock, msg);

    company.offers = company.offers || {};
    company.employees = company.employees || {};

    const income = incomeAtLevel(company.level);

    const offerCards = Object.keys(company.offers).map(positionKey => {

        const offer = company.offers[positionKey];
        const rate = positionRate(company.industry, positionKey);
        const amount = Math.round(income * (rate / 100));
        const maxSlots = getMaxSlots(company.industry, positionKey);
        const filledCount = Object.values(company.employees).filter(e => e.position === positionKey).length;
        const pendingCount = offer.pending.length;
        const pendingNames = offer.pending.map(p => `@${p.userId.split("@")[0]}`).join(", ");

        return `📋 *[ 𝙊𝙁𝙁𝙀𝙍 #${offer.id} ]*
💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(positionKey)}
👥 𝙎𝙡𝙤𝙩𝙨    : ${filledCount}/${maxSlots}
💰 𝙋𝙖𝙮      : ~${amount.toLocaleString()} 🌙/payout
📥 𝙋𝙚𝙣𝙙𝙞𝙣𝙜  : ${pendingCount} applicant${pendingCount === 1 ? "" : "s"}${pendingCount ? `\n   ${pendingNames}` : ""}`;

    });

    const filledLines = Object.values(company.employees).map(e => {

        const rate = positionRate(company.industry, e.position);
        const amount = Math.round(income * (rate / 100));

        return `[${e.num}] ${titleCase(e.position)} — @${e.userId.split("@")[0]} (~${amount.toLocaleString()} 🌙/payout)`;

    });

    const openBlock = offerCards.length
        ? offerCards.join(`\n\n${DIVIDER}\n\n`)
        : "  📭 none right now";

    const filledBlock = filledLines.length
        ? filledLines.join("\n")
        : "  none";

    const mentions = [
        ...Object.keys(company.offers).flatMap(k => company.offers[k].pending.map(p => p.userId)),
        ...Object.values(company.employees).map(e => e.userId)
    ];

    await sock.sendMessage(msg.key.remoteJid, {
        text: `╭━━━ 🏢 𝘾𝙊𝙈𝙋𝘼𝙉𝙔 𝙊𝙁𝙁𝙀𝙍𝙎 ━━━╮
   ${company.name}

📢 *𝙊𝙋𝙀𝙉 𝙊𝙁𝙁𝙀𝙍𝙎*

${openBlock}

${DIVIDER}
👥 *𝙁𝙄𝙇𝙇𝙀𝘿 𝙋𝙊𝙎𝙄𝙏𝙄𝙊𝙉𝙎*

${filledBlock}

${DIVIDER}
🛠️ *𝙈𝘼𝙉𝘼𝙂𝙀𝙈𝙀𝙉𝙏*

📥 .hire <offer #> — hire everyone pending on it
📥 .companyapprove <position> @user — hire one specific applicant

${FOOTER}`,
        mentions
    }, { quoted: msg });

}

function hireOneApplicant(company, positionKey, userId) {

    const rate =
        positionRate(
            company.industry,
            positionKey
        );

    company.employeeSeq =
        (company.employeeSeq || 0) + 1;

    const employeeId =
        `emp_${Date.now()}_${Math.floor(Math.random() * 1000)}_${company.employeeSeq}`;

    const code =
        generateEmployeeCode(company);

    const hiredAt =
        Date.now();

    company.employees[employeeId] = {

        num: company.employeeSeq,

        code,

        userId,

        position: positionKey,

        salaryRate: rate,

        role: null,

        hiredAt

    };

    startEmployment({
        userId,
        companyName: company.name,
        position: positionKey,
        tier: tierForLevel(company.level),
        hiredAt,
        companyType: "player"
    });

    return company.employees[employeeId];

}

async function companyApproveCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    const company = users[sender].company;
    if (!company) return await replyNoCompany(sock, msg);

    company.offers = company.offers || {};
    company.employees = company.employees || {};

    const context = msg.message?.extendedTextMessage?.contextInfo;

    let target = null;
    if (context?.participant) target = context.participant;
    else if (context?.mentionedJid?.length) target = context.mentionedJid[0];

    const positionArg = text
        .replace(".companyapprove", "")
        .replace(/@\d+/g, "")
        .trim();

    const positionKey = positionArg.toLowerCase();

    if (!target || !positionKey) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: errorBox("𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗔𝗣𝗣𝗥𝗢𝗩𝗘", "Specify the position and mention the applicant.", [".companyapprove background artist @user"])
        }, { quoted: msg });
    }

    const offer = company.offers[positionKey];

    if (!offer) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ *${company.name}* has no open offer for *${titleCase(positionKey)}*.`
        }, { quoted: msg });
    }

    const isPending = offer.pending.some(p => p.userId === target);

    if (!isPending) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ @${target.split("@")[0]} hasn't applied for *${titleCase(positionKey)}*.`,
            mentions: [target]
        }, { quoted: msg });
    }

    const maxSlots = getMaxSlots(company.industry, positionKey);
    const filledCount = Object.values(company.employees).filter(e => e.position === positionKey).length;

    if (filledCount >= maxSlots) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ *${titleCase(positionKey)}* is already fully staffed at *${company.name}* (${filledCount}/${maxSlots}) — can't approve anyone else into it.`
        }, { quoted: msg });
    }

    const employeeCount = Object.keys(company.employees).length;

    if (employeeCount >= MAX_EMPLOYEES) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ *${company.name}* is at the ${MAX_EMPLOYEES}-employee cap — can't approve anyone right now.`
        }, { quoted: msg });
    }

    hireOneApplicant(company, positionKey, target);
    offer.pending = offer.pending.filter(p => p.userId !== target);

    const newFilledCount = filledCount + 1;
    if (newFilledCount >= maxSlots) delete company.offers[positionKey];

    saveUsers(users);

    const rate = positionRate(company.industry, positionKey);
    const liveAmount = Math.round(incomeAtLevel(company.level) * (rate / 100));

    await sock.sendMessage(msg.key.remoteJid, {
        text: `✅ @${target.split("@")[0]} has been hired as *${titleCase(positionKey)}* at *${company.name}*.\n\n💰 Salary: ~${liveAmount.toLocaleString()} 🌙 per payout\n📊 Slots filled: ${newFilledCount}/${maxSlots}`,
        mentions: [target]
    }, { quoted: msg });

}

async function companyDisapproveCommand(sock, msg, text) {

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const users = loadUsers();

    if (!users[sender]) {
        return await replyNotRegistered(sock, msg);
    }

    const company =
        users[sender].company;

    if (!company) {
        return await replyNoCompany(sock, msg);
    }

    company.offers =
        company.offers || {};

    company.employees =
        company.employees || {};

    const context =
        msg.message?.extendedTextMessage?.contextInfo;

    let target = null;

    if (context?.participant) {
        target = context.participant;
    }
    else if (context?.mentionedJid?.length) {
        target = context.mentionedJid[0];
    }

    const positionArg =
        text
            .replace(
                /^\.company\s+disapprove\s*/i,
                ""
            )
            .replace(/@\d+/g, "")
            .trim();

    const positionKey =
        positionArg.toLowerCase();

    if (!target || !positionKey) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: errorBox(
                    "𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗗𝗜𝗦𝗔𝗣𝗣𝗥𝗢𝗩𝗘",
                    "Specify the position and the applicant.",
                    [
                        ".company disapprove analyst @user"
                    ]
                )
            },
            { quoted: msg }
        );

    }

    const offer =
        company.offers[positionKey];

    if (!offer) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ *${company.name}* has no open offer for *${titleCase(positionKey)}*.

📥 Check .companyoffers for your active offers.`
            },
            { quoted: msg }
        );

    }

    const applicantIndex =
        offer.pending.findIndex(
            applicant =>
                applicant.userId === target
        );

    if (applicantIndex === -1) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ @${target.split("@")[0]} is not currently pending for *${titleCase(positionKey)}*.

They may already have been hired, rejected, or their application may no longer exist.`,
                mentions: [target]
            },
            { quoted: msg }
        );

    }

    offer.pending.splice(
        applicantIndex,
        1
    );

    saveUsers(users);

    return await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`╭━━━ ❌ 𝘼𝙋𝙋𝙇𝙄𝘾𝘼𝙏𝙄𝙊𝙉 𝘿𝙀𝘾𝙇𝙄𝙉𝙀𝘿 ━━━╮

👤 Applicant : @${target.split("@")[0]}
💼 Position  : ${titleCase(positionKey)}
🏢 Company   : ${company.name}

The application has been declined and removed from the pending list.

${FOOTER}`,
            mentions: [target]
        },
        { quoted: msg }
    );

}

async function companyHireCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    const company = users[sender].company;
    if (!company) return await replyNoCompany(sock, msg);

    company.offers = company.offers || {};
    company.employees = company.employees || {};

    const arg = text.replace(".hire", "").trim();
    const offerId = Number(arg);

    if (!arg || !Number.isInteger(offerId)) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: errorBox("𝗛𝗜𝗥𝗘", "Enter an offer number from .companyoffers.", [".hire 12"])
        }, { quoted: msg });
    }

    const foundEntry = Object.entries(company.offers).find(([, o]) => o.id === offerId);

    if (!foundEntry) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ *${company.name}* has no open offer #${offerId}. Check .companyoffers.`
        }, { quoted: msg });
    }

    const [positionKey, offer] = foundEntry;

    if (offer.pending.length === 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `📭 No one has applied to offer #${offerId} (*${titleCase(positionKey)}*) yet.`
        }, { quoted: msg });
    }

    const maxSlots = getMaxSlots(company.industry, positionKey);
    const currentFilled = Object.values(company.employees).filter(e => e.position === positionKey).length;
    const remainingSlots = maxSlots - currentFilled;

    if (remainingSlots <= 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ *${titleCase(positionKey)}* is already fully staffed (${currentFilled}/${maxSlots}) — nothing to hire.`
        }, { quoted: msg });
    }

    const companyRemaining = MAX_EMPLOYEES - Object.keys(company.employees).length;

    if (companyRemaining <= 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ *${company.name}* is at the ${MAX_EMPLOYEES}-employee cap — can't hire anyone right now.`
        }, { quoted: msg });
    }

    const actualSlots = Math.min(remainingSlots, companyRemaining);
    const sortedPending = [...offer.pending].sort((a, b) => a.appliedAt - b.appliedAt);
    const toHire = sortedPending.slice(0, actualSlots);
    const leftover = sortedPending.slice(actualSlots);

    const hiredMentions = [];
    const hiredLines = [];

    for (const applicant of toHire) {
        const employee = hireOneApplicant(company, positionKey, applicant.userId);
        hiredMentions.push(applicant.userId);
        hiredLines.push(`@${applicant.userId.split("@")[0]} — code ${employee.code}`);
    }

    offer.pending = leftover;

    const newFilled = currentFilled + toHire.length;
    if (newFilled >= maxSlots) delete company.offers[positionKey];

    saveUsers(users);

    const rate = positionRate(company.industry, positionKey);
    const liveAmount = Math.round(incomeAtLevel(company.level) * (rate / 100));

    const leftoverNote = leftover.length > 0
        ? `\n\n⏳ ${leftover.length} applicant(s) still pending — capacity reached this round. Run .hire ${offerId} again if a slot frees up.`
        : "";

    await sock.sendMessage(msg.key.remoteJid, {
        text: `✅ Hired ${toHire.length} for *${titleCase(positionKey)}* at *${company.name}*:\n${hiredLines.join("\n")}\n\n💰 Salary: ~${liveAmount.toLocaleString()} 🌙 each per payout\n📊 Slots filled: ${newFilled}/${maxSlots}${leftoverNote}`,
        mentions: hiredMentions
    }, { quoted: msg });

}

async function companyEmployeesCommand(sock, msg, text) {

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const users = loadUsers();

    if (!users[sender]) {
        return await replyNotRegistered(sock, msg);
    }

    const company =
        users[sender].company;

    if (!company) {
        return await replyNoCompany(sock, msg);
    }

    company.employees =
        company.employees || {};

    const arg =
        text.replace(".employees", "").trim();

    const employeeEntries =
        Object.entries(company.employees);

    if (arg) {

        const num =
            Number(arg);

        if (!Number.isInteger(num)) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text: errorBox(
                        "𝗘𝗠𝗣𝗟𝗢𝗬𝗘𝗘𝗦",
                        "Enter an employee number from the roster.",
                        [
                            ".employees 3"
                        ]
                    )
                },
                { quoted: msg }
            );

        }

        const found =
            employeeEntries.find(
                ([, employee]) =>
                    employee.num === num
            );

        if (!found) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`╭━━━ ⚠️ 𝙀𝙈𝙋𝙇𝙊𝙔𝙀𝙀 𝙉𝙊𝙏 𝙁𝙊𝙐𝙉𝘿 ━━━╮

*${company.name}* has no employee #${num}.

📥 Check .employees for the current roster.

${FOOTER}`
                },
                { quoted: msg }
            );

        }

        const [, employee] =
            found;

        const rate =
            positionRate(
                company.industry,
                employee.position
            );

        const amount =
            Math.round(
                incomeAtLevel(company.level) *
                (rate / 100)
            );

        const hiredDate =
            new Date(
                employee.hiredAt
            ).toDateString();

        const registeredName =
            users[employee.userId]?.name ||
            "not registered";

        const dutyLog =
            employee.dutyLog || [];

        const now =
            Date.now();

        const weeklyCount =
            dutyLog.filter(
                ts =>
                    ts >=
                    now -
                    DUTY_WEEKLY_BONUS_WINDOW_MS
            ).length;

        const lastDuty =
            dutyLog.length
                ? new Date(
                    dutyLog[
                        dutyLog.length - 1
                    ]
                ).toLocaleString()
                : "never";

        const currentlyOnDuty =
            wasOnDutyDuring(
                employee,
                company.lastPayout,
                company.lastPayout +
                PAYOUT_INTERVAL_MS
            );

        const statusLine =
            currentlyOnDuty
                ? "✅ on duty — will be paid"
                : "❌ hasn't checked in yet";

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`╭━━━ 👤 𝙀𝙈𝙋𝙇𝙊𝙔𝙀𝙀 #${employee.num} ━━━╮
        ${company.name}

👤 𝙉𝙖𝙢𝙚      : ${registeredName}
📱 𝙀𝙢𝙥𝙡𝙤𝙮𝙚𝙚  : @${employee.userId.split("@")[0]}
🔑 𝘾𝙤𝙙𝙚      : ${employee.code || "n/a"}
💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣  : ${titleCase(employee.position)}
🎭 𝙍𝙤𝙡𝙚      : ${employee.role || "none"}
💰 𝙎𝙖𝙡𝙖𝙧𝙮    : ~${amount.toLocaleString()} 🌙/payout
📅 𝙃𝙞𝙧𝙚𝙙     : ${hiredDate}

${DIVIDER}

✅ 𝙏𝙝𝙞𝙨 𝙥𝙚𝙧𝙞𝙤𝙙 : ${statusLine}
📊 𝙏𝙝𝙞𝙨 𝙬𝙚𝙚𝙠   : ${weeklyCount}/${DUTY_WEEKLY_BONUS_THRESHOLD} check-ins
🕐 𝙇𝙖𝙨𝙩 𝙙𝙪𝙩𝙮   : ${lastDuty}

${DIVIDER}

📥 .promote ${employee.num}
🔎 .oversee ${employee.code || "EMP-XXXX"}

${FOOTER}`,
                mentions: [
                    employee.userId
                ]
            },
            { quoted: msg }
        );

    }

    if (employeeEntries.length === 0) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`╭━━━ 👥 𝙀𝙈𝙋𝙇𝙊𝙔𝙀 𝙍𝙊𝙎𝙏𝙀𝙍 ━━━╮
        ${company.name}

📭 No employees yet.

📥 Open a position with:
.companyoffer <position>

${FOOTER}`
            },
            { quoted: msg }
        );

    }

    const income =
        incomeAtLevel(
            company.level
        );

    const sortedEntries =
        [...employeeEntries].sort(
            ([, a], [, b]) =>
                a.num - b.num
        );

    const employeeBlocks =
        sortedEntries.map(
            ([, employee]) => {

                const rate =
                    positionRate(
                        company.industry,
                        employee.position
                    );

                const amount =
                    Math.round(
                        income *
                        (rate / 100)
                    );

                const hiredDate =
                    new Date(
                        employee.hiredAt
                    ).toDateString();

                const registeredName =
                    users[
                        employee.userId
                    ]?.name ||
                    "not registered";

                return `👤 *#${employee.num} — ${registeredName}*
📱 @${employee.userId.split("@")[0]}
💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣 : ${titleCase(employee.position)}
🔑 𝘾𝙤𝙙𝙚      : ${employee.code || "n/a"}
💰 𝙋𝙖𝙮      : ~${amount.toLocaleString()} 🌙/payout
📅 𝙃𝙞𝙧𝙚𝙙     : ${hiredDate}`;

            }
        );

    const rosterBlock =
        employeeBlocks.join(
            `\n\n${DIVIDER}\n\n`
        );

    const mentions =
        sortedEntries.map(
            ([, employee]) =>
                employee.userId
        );

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`╭━━━ 👥 𝙀𝙈𝙋𝙇𝙊𝙔𝙀𝙀 𝙍𝙊𝙎𝙏𝙀𝙍 ━━━╮
        ${company.name}

👥 𝙀𝙈𝙋𝙇𝙊𝙔𝙀𝙀𝙎 : ${employeeEntries.length}/${MAX_EMPLOYEES}

${DIVIDER}

${rosterBlock}

${DIVIDER}

🔎 .employees <num> — full employee details
🔑 .oversee <code> — lookup by employee code
📢 .companyoffers — manage positions

${FOOTER}`,
            mentions
        },
        { quoted: msg }
    );

}

async function companyOverseeCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    const company = users[sender].company;
    if (!company) return await replyNoCompany(sock, msg);

    company.employees = company.employees || {};

    const arg = text.replace(".oversee", "").trim().toUpperCase();

    if (!arg) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: errorBox("𝗢𝗩𝗘𝗥𝗦𝗘𝗘", "Enter an employee code from .employees.", [".oversee EMP-4821"])
        }, { quoted: msg });
    }

    const found = Object.values(company.employees).find(e => (e.code || "").toUpperCase() === arg);

    if (!found) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ *${company.name}* has no employee with code *${arg}*. Check .employees for the current roster.`
        }, { quoted: msg });
    }

    const employee = found;
    const rate = positionRate(company.industry, employee.position);
    const amount = Math.round(incomeAtLevel(company.level) * (rate / 100));
    const hiredDate = new Date(employee.hiredAt).toDateString();
    const registeredName = users[employee.userId]?.name || "not registered";

    const dutyLog = employee.dutyLog || [];
    const now = Date.now();
    const weeklyCount = dutyLog.filter(ts => ts >= now - DUTY_WEEKLY_BONUS_WINDOW_MS).length;
    const lastDuty = dutyLog.length ? new Date(dutyLog[dutyLog.length - 1]).toLocaleString() : "never";
    const currentlyOnDuty = wasOnDutyDuring(employee, company.lastPayout, company.lastPayout + PAYOUT_INTERVAL_MS);

    const statusLine = currentlyOnDuty
        ? "✅ on duty — will be paid"
        : "❌ hasn't checked in yet";

    await sock.sendMessage(msg.key.remoteJid, {
        text: `╭━━━ 🔎 𝙊𝙑𝙀𝙍𝙎𝙀𝙀𝙄𝙉𝙂 #${employee.num} ━━━╮

👤 𝙉𝙖𝙢𝙚      : ${registeredName}
📱 𝙀𝙢𝙥𝙡𝙤𝙮𝙚𝙚  : @${employee.userId.split("@")[0]}
🔑 𝘾𝙤𝙙𝙚      : ${employee.code}
💼 𝙋𝙤𝙨𝙞𝙩𝙞𝙤𝙣  : ${titleCase(employee.position)}
🎭 𝙍𝙤𝙡𝙚      : ${employee.role || "none"}
💰 𝙎𝙖𝙡𝙖𝙧𝙮    : ~${amount.toLocaleString()} 🌙/payout (only if on duty)
📅 𝙃𝙞𝙧𝙚𝙙     : ${hiredDate}

${DIVIDER}
✅ 𝙏𝙝𝙞𝙨 𝙥𝙚𝙧𝙞𝙤𝙙 : ${statusLine}
📊 𝙏𝙝𝙞𝙨 𝙬𝙚𝙚𝙠   : ${weeklyCount}/${DUTY_WEEKLY_BONUS_THRESHOLD} check-ins toward bonus
🕐 𝙇𝙖𝙨𝙩 𝙙𝙪𝙩𝙮   : ${lastDuty}

${DIVIDER}
📥 .promote ${employee.num} to promote this employee.

${FOOTER}`,
        mentions: [employee.userId]
    }, { quoted: msg });

}

function getPromotionLadder(industryKey) {
    const industry = getIndustry(industryKey);
    if (!industry) return [];
    return Object.entries(industry.positions)
        .sort((a, b) => a[1] - b[1])
        .map(([position]) => position);
}

async function companyPromoteCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    const company = users[sender].company;
    if (!company) return await replyNoCompany(sock, msg);

    company.employees = company.employees || {};
    company.offers = company.offers || {};

    const arg = text
    .replace(/^\.companypromote\s*/i, "")
    .trim();
    const num = Number(arg);

    if (!arg || !Number.isInteger(num)) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: errorBox("𝗣𝗥𝗢𝗠𝗢𝗧𝗘", "Enter an employee number from .employees.", [".promote 3"])
        }, { quoted: msg });
    }

    const found = Object.entries(company.employees).find(([, e]) => e.num === num);

    if (!found) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ *${company.name}* has no employee #${num}. Check .employees for the current roster.`
        }, { quoted: msg });
    }

    const [, employee] = found;
    const ladder = getPromotionLadder(company.industry);
    const currentIndex = ladder.indexOf(employee.position);

    if (currentIndex === -1) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ #${num}'s position (*${titleCase(employee.position)}*) isn't recognized in *${company.name}*'s current industry catalog — can't compute a promotion path.`
        }, { quoted: msg });
    }

    if (currentIndex === ladder.length - 1) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ #${num} is already at the top position (*${titleCase(employee.position)}*) — nowhere higher to promote to.`
        }, { quoted: msg });
    }

    const nextPosition = ladder[currentIndex + 1];
    const nextMaxSlots = getMaxSlots(company.industry, nextPosition);
    const nextFilledCount = Object.values(company.employees).filter(e => e.position === nextPosition).length;

    if (nextFilledCount >= nextMaxSlots) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ *${titleCase(nextPosition)}* is already fully staffed (${nextFilledCount}/${nextMaxSlots}) — can't promote #${num} into it right now.`
        }, { quoted: msg });
    }

    const oldPosition = employee.position;
    employee.position = nextPosition;
    employee.salaryRate = positionRate(company.industry, nextPosition);
    employee.promotedAt = Date.now();

    updatePosition({
        userId: employee.userId,
        companyName: company.name,
        oldPosition,
        newPosition: nextPosition,
        tier: tierForLevel(company.level),
        changedAt: employee.promotedAt,
        companyType: "player"
    });

    if (company.offers[nextPosition]) delete company.offers[nextPosition];

    saveUsers(users);

    const liveAmount = Math.round(incomeAtLevel(company.level) * (employee.salaryRate / 100));

    await sock.sendMessage(msg.key.remoteJid, {
        text: `🎉 @${employee.userId.split("@")[0]} promoted: *${titleCase(oldPosition)}* → *${titleCase(nextPosition)}*!\n\n💰 New salary: ~${liveAmount.toLocaleString()} 🌙 per payout\n\n*${titleCase(oldPosition)}* is now vacant at *${company.name}* — .companyoffer to refill it.`,
        mentions: [employee.userId]
    }, { quoted: msg });

}

module.exports = {
    companyCommand,
    companyCreateCommand,
    companyUpgradeCommand,
    companyOfferCommand,
    companyOffersCommand,
    companyApproveCommand,
    companyDisapproveCommand,
    companyHireCommand,
    companyEmployeesCommand,
    companyOverseeCommand,
    companyPromoteCommand,
    incomeAtLevel,
    formatDuration,
    PAYOUT_INTERVAL_MS,
    wasOnDutyDuring,
    DUTY_COOLDOWN_MS,
    DUTY_DAILY_CAP,
    DUTY_LOG_RETENTION_MS,
    DUTY_WEEKLY_BONUS_THRESHOLD,
    DUTY_WEEKLY_BONUS_WINDOW_MS
};