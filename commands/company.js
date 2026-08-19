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

// PERSISTENCE FIX: real per-user state, written every payout/upgrade —
// routed through dataPath() so it survives a redeploy. See lib/dataPath.js.
const USERS_FILE = dataPath("users.json");

// ---------- Tunable economy constants ----------
const CREATE_COST = 100000000;
const BASE_INCOME = 100000;
const INCOME_MULTIPLIER = 1.15;
const BASE_UPGRADE_COST = 35000;
const UPGRADE_COST_MULTIPLIER = 1.07;

// STEP 1 CHANGE: 12h -> 24h, per the company/employment spec.
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
// Same divider/footer/box language used across every employment command
// (owner-side here, employee-side in commands/jobs.js) so .companyoffers,
// .oversee, .joboffers, .jobapply, .job, .duty and .jobinfo all read as
// one consistent product.
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

// Random 4-digit code, unique within this company, assigned once at hire
// and never changed. This is what .oversee looks employees up by.
function generateEmployeeCode(company) {

    const existing = new Set(Object.values(company.employees || {}).map(e => e.code));
    let code;

    do {
        code = "EMP-" + Math.floor(1000 + Math.random() * 9000);
    } while (existing.has(code));

    return code;

}

// Was this employee logged as on duty at any point during [start, end)?
// Presence is checked per PAYOUT PERIOD (not calendar day) so that a
// company payout that's overdue by several days checks each of those
// days independently against when .duty was actually run, rather than
// only ever looking at "today."
function wasOnDutyDuring(employee, start, end) {
    const log = employee.dutyLog || [];
    return log.some(ts => ts >= start && ts < end);
}

// Credits any full PAYOUT_INTERVAL_MS periods that have passed since the
// company's last payout, advances lastPayout by exactly that many
// periods, and settles each period independently:
//
//   - An employee who was on duty (.duty) at any point during that
//     specific period gets their computed cut credited DIRECTLY to their
//     personal wallet — this is real auto-pay, not a company-wallet
//     reservation the owner has to manually distribute later.
//   - An employee who was NOT on duty during that period forfeits that
//     period's cut entirely — it simply stays in the company's net
//     (there is currently no "call-in"/excused-absence path; see the
//     header comment in this file).
//
// The company wallet only ever receives income minus whatever was
// actually paid out to present employees — it's the company's real
// retained profit, not a salary-reserve account.
//
// Returns null if nothing was owed yet, otherwise
// { totalIncome, totalSalaries, netToCompanyWallet, employeePayouts }
// where employeePayouts is { userId: amountCreditedThisSettlement }.
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
            if (!wasOnDutyDuring(employee, periodStart, periodEnd)) continue; // forfeited

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


// ---------- .company — status view (bare command, no subcommand) ----------
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


// ---------- .company deposit crescent <amount> | .company deposit <assetId> <amount> ----------
// Two very different transfers under one subcommand, disambiguated by
// the first word:
//   - "crescent" -> money, personal wallet -> company wallet (this is
//     the ORIGINAL .company deposit <amount> behavior, unchanged in
//     substance — just re-routed behind the "crescent" keyword instead
//     of being the bare default).
//   - any valid asset ID (gold, land, etc., from invest.js's ASSETS
//     catalog) -> a straight quantity transfer, personal inventory ->
//     company.assets. No money changes hands and no market rate is
//     involved — this is NOT the same as .companyinvest buy, which
//     spends company wallet to buy NEW assets from the market. This
//     only moves assets the person already owns.
// ---------- .company deposit crescent <amount> | .company deposit <assetId> <amount> ----------
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

    // .company deposit crescent 50000
    // .company deposit gold 2
    const parts = text.trim().split(/\s+/);

    // Expected:
    // parts[0] = .company
    // parts[1] = deposit
    // parts[2] = crescent / assetId
    // parts[3] = amount

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


    // ========================================================
    // CRESCENT DEPOSIT
    // Personal wallet -> company wallet
    // ========================================================

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


        // Never allow the transfer if the personal wallet
        // doesn't contain enough money.
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


        // Perform the transfer.
        users[sender].wallet =
            personalWallet - amount;

        company.wallet += amount;


        // Save ONLY after both sides of the transfer
        // have been updated in memory.
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


        // Success confirmation.
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


    // ========================================================
    // ASSET DEPOSIT
    // Personal inventory -> company assets
    // ========================================================

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


    // Remove from personal inventory.
    holding.quantity -= amount;

    if (holding.quantity <= 0) {

        inventory[sender] = items.filter(
            item =>
                !(item.id === kind && item.type === "asset")
        );

    }


    // Save personal inventory first.
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


    // Add to company assets.
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


// ---------- .company distribute [@user | reply <amount>] ----------
// No target -> withdraw the FULL company wallet balance to the owner's
// personal wallet. Tag/reply a user -> pay that specific employee a
// given amount from the company wallet — rejected if they're not
// actually on the roster. company.employees is always empty until the
// hiring step of the spec ships, so every "pay an employee" attempt
// correctly rejects for now — that's accurate behavior, not a bug: no
// one is actually employed yet.
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

    // ---- No target: withdraw everything to the owner's personal wallet ----
   // ---- No target: withdraw all OR a specific amount to owner's personal wallet ----

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

    // Get everything after ".company distribute"
    const amountText = text
        .replace(".company", "")
        .replace("distribute", "")
        .trim();

    let amount;

    // Bare ".company distribute" = withdraw everything
    if (!amountText) {

        amount = company.wallet;

    } else {

        // ".company distribute 50000" = withdraw exactly 50,000
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

    // ---- Target given: pay a specific employee ----
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


// ---------- .company assign <role> @user ----------
// Grants an employee a role (e.g. "investor", "distributor") that later
// gates access to role-specific commands (.companyinvest, etc.). Role
// names aren't validated against a fixed catalog yet — that can be
// tightened once role-gated commands actually exist and need to check
// for specific values. Same as .company distribute, this always rejects
// for now since company.employees is empty until hiring ships.
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


// ---------- .company — router. Bare command -> status view. ----------
// ".company deposit/distribute/assign" are new subcommands added for
// the company/employment spec — everything else about how .company is
// invoked is unchanged.
//
// CHANGE: "deposit" now passes the full `trimmed` text (like distribute
// and assign already did), not just parts[2] — companyDeposit needs to
// see the "crescent"/asset-id keyword that comes before the amount now.
async function companyCommand(sock, msg, text) {

    const trimmed = (text || ".company").trim();
    const parts = trimmed.split(/\s+/);
    const sub = (parts[1] || "").toLowerCase();

    if (sub === "deposit") {
        return await companyDeposit(sock, msg, trimmed);
    }

    if (sub === "distribute") {
        return await companyDistribute(sock, msg, trimmed);
    }

    if (sub === "assign") {
        return await companyAssign(sock, msg, trimmed);
    }

    return await companyStatusView(sock, msg);

}


// ---------- .companycreate <name> <industry> — start a company for 100,000,000 ----------
// Industry is now REQUIRED and must match an entry in lib/industries.js.
// Parsing rule: the LAST whitespace-separated token is the industry,
// everything before it is the company name. This matches the spec's
// single-word industry keys (animation / retail / food) — if the
// industry list ever grows multi-word keys, this parsing needs to
// change to something more explicit (e.g. a trailing --industry flag).
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

    // Need at least a name token AND an industry token.
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

// ---------- .companyupgrade — level up, cost +7%, income +15% each time ----------
async function companyUpgradeCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    const company = users[sender].company;

    if (!company) return await replyNoCompany(sock, msg);

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

// ---------- .companyoffer <position> — open a position from the industry catalog ----------
// Rejects if: no industry set, position isn't in that industry's catalog,
// the position is already at its maxSlots capacity, an offer for it is
// already open AND that offer still has room, or the roster is at the
// MAX_EMPLOYEES cap. A position can hold multiple employees at once (see
// lib/industries.js's maxSlots) — this only blocks re-offering once FULL.
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


// ---------- .companyoffers — owner view of open offers + filled positions ----------
async function companyOffersCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    const company = users[sender].company;
    if (!company) return await replyNoCompany(sock, msg);

    company.offers = company.offers || {};
    company.employees = company.employees || {};

    const income = incomeAtLevel(company.level);

    // Every offer gets its own card — position, slots, live pay, and its
    // own pending applicants underneath (pending is tracked per-offer in
    // the real data, so applicants are shown per-card rather than merged
    // into one global list).
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

// Shared by .companyapprove and .hire — actually creates the employee
// record for one applicant. Does NOT touch company.offers[positionKey]
// (removing the applicant from pending, closing the offer once full) —
// callers handle that themselves since .companyapprove removes exactly
// one applicant while .hire may drain several in one call.
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

    // ========================================================
    // PORTFOLIO HISTORY
    // ========================================================

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

// ---------- .companyapprove <position> @user (or reply) — hire ONE specific pending applicant ----------
// For when multiple people applied to the same offer and the owner wants
// a particular one, not just whoever's oldest. For "just hire everyone
// pending, in order," see .hire below.
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

// ---------- .hire <offer #> — hire EVERYONE currently pending on that offer ----------
// First-come-first-served if applicants outnumber remaining slots — the
// oldest applications get hired, the rest stay pending (not discarded)
// in case a slot frees up later. This is the "quick path" — pick a
// specific applicant instead via .companyapprove.
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

// ---------- .employees [num] — owner-only roster / employee detail ----------
// Bare .employees -> roster (name, position, num, hired date).
// .employees <num> -> single-employee detail view.
//
// Attendance/duty-performance ("present XX/XX times since hired") is
// spec'd (§10-11) but that whole subsystem hasn't been built yet — it's
// still an open question (rolling vs. calendar call-in window). Rather
// than fake numbers, both views say so plainly instead of showing a
// stat that doesn't exist yet.
async function companyEmployeesCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    const company = users[sender].company;
    if (!company) return await replyNoCompany(sock, msg);

    company.employees = company.employees || {};

    const arg = text.replace(".employees", "").trim();
    const employeeEntries = Object.entries(company.employees);

    // ---- Detail view: .employees <num> ----
    if (arg) {

        const num = Number(arg);

        if (!Number.isInteger(num)) {
            return await sock.sendMessage(msg.key.remoteJid, {
                text: errorBox("𝗘𝗠𝗣𝗟𝗢𝗬𝗘𝗘𝗦", "Enter an employee number from .employees.", [".employees 3"])
            }, { quoted: msg });
        }

        const found = employeeEntries.find(([, e]) => e.num === num);

        if (!found) {
            return await sock.sendMessage(msg.key.remoteJid, {
                text: `⚠️ *${company.name}* has no employee #${num}. Check .employees for the current roster.`
            }, { quoted: msg });
        }

        const [, employee] = found;
        const rate = positionRate(company.industry, employee.position);
        const amount = Math.round(incomeAtLevel(company.level) * (rate / 100));
        const hiredDate = new Date(employee.hiredAt).toDateString();
        const registeredName = users[employee.userId]?.name || "not registered";

        const dutyLog = employee.dutyLog || [];
        const now = Date.now();
        const weeklyCount = dutyLog.filter(ts => ts >= now - DUTY_WEEKLY_BONUS_WINDOW_MS).length;
        const lastDuty = dutyLog.length ? new Date(dutyLog[dutyLog.length - 1]).toLocaleString() : "never";
        const currentlyOnDuty = wasOnDutyDuring(employee, company.lastPayout, company.lastPayout + PAYOUT_INTERVAL_MS);

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
   👤 𝗘𝗠𝗣𝗟𝗢𝗬𝗘𝗘 #${employee.num}
╰━━━━━━━━━━━━━━━━━━━━━━━╮
» Name     : ${registeredName}
» Employee : @${employee.userId.split("@")[0]}
» Code     : ${employee.code || "n/a"}
» Position : ${titleCase(employee.position)}
» Role     : ${employee.role || "none"}
» Salary   : ~${amount.toLocaleString()} 🌙 per payout (only paid if on duty)
» Hired    : ${hiredDate}
» This period: ${currentlyOnDuty ? "✅ on duty — will be paid" : "❌ hasn't checked in yet"}
» This week: ${weeklyCount}/${DUTY_WEEKLY_BONUS_THRESHOLD} check-ins toward bonus
» Last duty: ${lastDuty}
━━━━━━━━━━━━━━━━━━━━━━━━━
.promote ${employee.num} to promote this employee.`,
            mentions: [employee.userId]
        }, { quoted: msg });

    }

    // ---- Roster view: bare .employees ----
    if (employeeEntries.length === 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `👥 *${company.name}* has no employees yet.\n\nOpen a position with .companyoffer <position>.`
        }, { quoted: msg });
    }

    const income = incomeAtLevel(company.level);

    const lines = employeeEntries
        .sort(([, a], [, b]) => a.num - b.num)
        .map(([, e]) => {
            const rate = positionRate(company.industry, e.position);
            const amount = Math.round(income * (rate / 100));
            return `#${e.num} [${e.code || "n/a"}] ${titleCase(e.position)} — @${e.userId.split("@")[0]} (~${amount.toLocaleString()} 🌙/payout)`;
        });

    const mentions = employeeEntries.map(([, e]) => e.userId);

    await sock.sendMessage(msg.key.remoteJid, {
        text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
   👥 ${company.name} — 𝗘𝗠𝗣𝗟𝗢𝗬𝗘𝗘𝗦
╰━━━━━━━━━━━━━━━━━━━━━━━╮
${lines.join("\n")}
━━━━━━━━━━━━━━━━━━━━━━━━━
.employees <num> for details, or .oversee <code>`,
        mentions
    }, { quoted: msg });

}

// ---------- .oversee <code> — owner-only lookup by employee code ----------
// Same detail view as .employees <num>, just looked up by the random
// per-hire code instead of hire-order number — meant for an owner with a
// big enough roster (40+, per spec) that scrolling for a name is slower
// than typing a code someone gave them directly.
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

// Ordered "promotion ladder" for an industry — every position in that
// industry's catalog, sorted by salary rate ascending. Used by .promote
// to find the next rung up. Array.sort is stable in modern Node, so the
// handful of same-rate ties (e.g. Retail's Cashier/Stock Clerk both at
// 0.25%) break by the catalog's own declared order rather than randomly.
function getPromotionLadder(industryKey) {
    const industry = getIndustry(industryKey);
    if (!industry) return [];
    return Object.entries(industry.positions)
        .sort((a, b) => a[1] - b[1])
        .map(([position]) => position);
}

// ---------- .promote <num> — move an employee up the industry's rate ladder ----------
// DESIGN CALL, not spec-mandated: "promotion" = moving to the next
// higher-rated position in the same industry catalog. An ad-hoc salary
// bump was considered and rejected — spec §5 is explicit that rates are
// fixed per catalog position, not owner-set — so moving position was the
// only mechanism left that doesn't contradict that. Easy to swap for a
// different model if this isn't what was meant.
async function companyPromoteCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) return await replyNotRegistered(sock, msg);

    const company = users[sender].company;
    if (!company) return await replyNoCompany(sock, msg);

    company.employees = company.employees || {};
    company.offers = company.offers || {};

    const arg = text.replace(".promote", "").trim();
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

    // The old position is now vacant — close any stray open offer for it,
    // but do NOT auto-reopen it; owner runs .companyoffer again if they
    // want to backfill.
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