const fs = require("fs");
const dataPath = require("../lib/dataPath");
// Public/employee-facing job commands — .joboffers, .jobapply, .job, .duty.
//
// NOTE: the spec's "3 excused call-ins per 30 days" allowance is NOT
// implemented here. Right now, no .duty check-in during a payout period
// means that period's salary is simply forfeited — there's no command to
// spend a call-in and no exception path. Flagged, not built.
const { getIndustry, positionRate, getMaxSlots } = require("../lib/industries");
const { getDutyFlavor } = require("../lib/dutyFlavor");
const { tierForLevel } = require("../lib/tierStar");
const { findOfferById, listOpenOffers, findEmploymentAnywhere } = require("../lib/jobOffers");
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

const USERS_FILE = dataPath("users.json");

function loadUsers() {

    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");

    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));

}

function saveUsers(users) {

    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 4), "utf8");

}

function errorBox(title, message, examples) {
    const exampleLines = examples.map(e => `  📥 ${e}`).join("\n");
    return `╭━━━━ ⚠️ ${title} ━━━━╮
   ${message}
  ─── 📝 𝖤𝖷𝖠𝖬𝖯𝖫𝖤 ───
${exampleLines}
╰━━━━━━━━━━━━━━━━━━━━━━━╯`;
}

function titleCase(str) {
    return (str || "")
        .split(" ")
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

// ---------- .joboffers — public listing of every open position ----------
// Majors (Nova Empire, Elegance, Chez Adélu) are deliberately NOT included
// yet — see the comment in lib/jobOffers.js's listOpenOffers(). This only
// ever shows player companies until that's resolved.
async function jobOffersCommand(sock, msg) {

    const users = loadUsers();
    const offers = listOpenOffers(users);

    if (offers.length === 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `📭 No open positions right now. Check back later!`
        }, { quoted: msg });
    }

    const lines = offers.map(o => {
        const rate = positionRate(o.industry, o.positionKey);
        const amount = Math.round(incomeAtLevel(o.level) * (rate / 100));
        const maxSlots = getMaxSlots(o.industry, o.positionKey);
        const filledCount = Object.values(o.company.employees || {}).filter(e => e.position === o.positionKey).length;
        return `#${o.offer.id} ${titleCase(o.positionKey)} [${filledCount}/${maxSlots}] @ *${o.companyName}* — ~${amount.toLocaleString()} 🌙/payout`;
    });

    await sock.sendMessage(msg.key.remoteJid, {
        text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
   📢 𝗢𝗣𝗘𝗡 𝗝𝗢𝗕 𝗢𝗙𝗙𝗘𝗥𝗦 📢
╰━━━━━━━━━━━━━━━━━━━━━━━╮
${lines.join("\n")}
━━━━━━━━━━━━━━━━━━━━━━━━━
Apply with: .jobapply <offer number>`
    }, { quoted: msg });

}

// ---------- .jobapply <offer number> ----------
// Enforces one active job per person (own assumption — see
// findEmploymentAnywhere() in lib/jobOffers.js). Doesn't require
// .register beyond having a users.json entry, matching the pattern the
// rest of the economy commands use.
async function jobApplyCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Please register first — .register YOUR_NAME`
        }, { quoted: msg });
    }

    const idArg = text.replace(".jobapply", "").trim();
    const offerId = Number(idArg);

    if (!idArg || isNaN(offerId)) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: errorBox("𝗝𝗢𝗕 𝗔𝗣𝗣𝗟𝗬", "Enter the offer number from .joboffers.", [".jobapply 12"])
        }, { quoted: msg });
    }

    const found = findOfferById(users, offerId);

    if (!found) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Offer #${offerId} isn't open anymore — check .joboffers for current listings.`
        }, { quoted: msg });
    }

    if (found.ownerId === sender) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You can't apply to your own company.`
        }, { quoted: msg });
    }

    const existingJob = findEmploymentAnywhere(users, sender);

    if (existingJob) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You're already working as *${titleCase(existingJob.position)}* at *${existingJob.companyName}*.`
        }, { quoted: msg });
    }

    const alreadyApplied = found.offer.pending.some(p => p.userId === sender);

    if (alreadyApplied) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You've already applied for that position — waiting on the owner's review.`
        }, { quoted: msg });
    }

    const maxSlots = getMaxSlots(found.company.industry, found.positionKey);
    const filledCount = Object.values(found.company.employees || {}).filter(e => e.position === found.positionKey).length;

    if (filledCount >= maxSlots) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ *${titleCase(found.positionKey)}* at *${found.company.name}* is already fully staffed (${filledCount}/${maxSlots}) — check .joboffers for other openings.`
        }, { quoted: msg });
    }

    found.offer.pending.push({ userId: sender, appliedAt: Date.now() });

    saveUsers(users);

    await sock.sendMessage(msg.key.remoteJid, {
        text: `✅ Application submitted for *${titleCase(found.positionKey)}* at *${found.company.name}*!\n\nThe owner will review it via .companyoffers.`
    }, { quoted: msg });

}

// ---------- .job — an employee's view of their own current job ----------
// Salary shown here is REAL auto-pay now (see collectPendingIncome() in
// commands/company.js) — it's credited straight to the employee's wallet
// once the company's payout settles, but ONLY for periods they were
// actually on duty (.duty) during. No duty check-in that period = that
// period's cut is forfeited, not owed/rolled over.
async function jobCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Please register first — .register YOUR_NAME`
        }, { quoted: msg });
    }

    const job = findEmploymentAnywhere(users, sender);

    if (!job) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `📭 You don't currently have a job.\n\nBrowse open positions with .joboffers.`
        }, { quoted: msg });
    }

    const company = users[job.ownerId].company;
    const employee = company.employees[job.employeeId];
    const rate = positionRate(company.industry, job.position);
    const amount = Math.round(incomeAtLevel(company.level) * (rate / 100));
    const timeLeft = formatDuration(company.lastPayout + PAYOUT_INTERVAL_MS - Date.now());
    const onDutyThisPeriod = wasOnDutyDuring(employee, company.lastPayout, company.lastPayout + PAYOUT_INTERVAL_MS);

    const dutyLog = employee.dutyLog || [];
    const now = Date.now();
    const weeklyCount = dutyLog.filter(ts => ts >= now - DUTY_WEEKLY_BONUS_WINDOW_MS).length;

    await sock.sendMessage(msg.key.remoteJid, {
        text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
   💼 𝗬𝗢𝗨𝗥 𝗝𝗢𝗕
╰━━━━━━━━━━━━━━━━━━━━━━━╮
» Company : ${job.companyName}
» Position: ${titleCase(job.position)}
» Salary  : ~${amount.toLocaleString()} 🌙 per payout
» Payout  : in ${timeLeft}
» Status  : ${onDutyThisPeriod ? "✅ checked in this period — you'll get paid" : "❌ no .duty yet this period — you'll forfeit this payout"}
» Weekly  : ${weeklyCount}/${DUTY_WEEKLY_BONUS_THRESHOLD} check-ins toward the weekly bonus
━━━━━━━━━━━━━━━━━━━━━━━━━
Run .duty to check in and get paid this cycle.`
    }, { quoted: msg });

}

// ---------- .duty — employee check-in, auto-pay gate ----------
// 2h cooldown between check-ins, max DUTY_DAILY_CAP per rolling 24h.
// 15+ check-ins within a rolling 7 days pays an instant weekly bonus
// (one extra period's salary) the moment the threshold is crossed.
//
// This does NOT pay anything by itself — it just logs the timestamp that
// collectPendingIncome() (commands/company.js) checks against when the
// company's payout settles. See that file's header comment for the full
// payout model, and the note in this file's header about call-ins/excused
// absences NOT being implemented yet.
async function dutyCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Please register first — .register YOUR_NAME`
        }, { quoted: msg });
    }

    const job = findEmploymentAnywhere(users, sender);

    if (!job) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `📭 You don't have a job to report duty for.\n\nBrowse open positions with .joboffers.`
        }, { quoted: msg });
    }

    const company = users[job.ownerId].company;
    const employee = company.employees[job.employeeId];
    const now = Date.now();

    let dutyLog = (employee.dutyLog || []).filter(ts => ts >= now - DUTY_LOG_RETENTION_MS);

    const lastCheckIn = dutyLog.length ? dutyLog[dutyLog.length - 1] : null;

    if (lastCheckIn && now - lastCheckIn < DUTY_COOLDOWN_MS) {
        const wait = formatDuration(lastCheckIn + DUTY_COOLDOWN_MS - now);
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⏳ You're still on cooldown — try again in ${wait}.`
        }, { quoted: msg });
    }

    const last24h = dutyLog.filter(ts => ts >= now - (24 * 60 * 60 * 1000));

    if (last24h.length >= DUTY_DAILY_CAP) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You've already checked in ${DUTY_DAILY_CAP} times in the last 24h — that's the daily limit. Come back later.`
        }, { quoted: msg });
    }

    dutyLog.push(now);
    employee.dutyLog = dutyLog;

    const weeklyCount = dutyLog.filter(ts => ts >= now - DUTY_WEEKLY_BONUS_WINDOW_MS).length;
    const rate = positionRate(company.industry, employee.position);
    const periodAmount = Math.round(incomeAtLevel(company.level) * (rate / 100));

    let bonusLine = "";

    const bonusEligible = weeklyCount >= DUTY_WEEKLY_BONUS_THRESHOLD &&
        (!employee.lastBonusAt || now - employee.lastBonusAt >= DUTY_WEEKLY_BONUS_WINDOW_MS);

    if (bonusEligible) {

        users[sender].wallet = (users[sender].wallet || 0) + periodAmount;
        employee.lastBonusAt = now;

        bonusLine = `\n\n🎉 *WEEKLY BONUS!* ${DUTY_WEEKLY_BONUS_THRESHOLD}+ check-ins this week — ${periodAmount.toLocaleString()} 🌙 bonus credited to your wallet!`;

    }

    saveUsers(users);

    const flavor = getDutyFlavor(employee.position);

    await sock.sendMessage(msg.key.remoteJid, {
        text: `✅ *${titleCase(employee.position)}* — you ${flavor}.\n\n📋 Checked in: ${last24h.length + 1}/${DUTY_DAILY_CAP} today | ${weeklyCount}/${DUTY_WEEKLY_BONUS_THRESHOLD} this week${bonusLine}`
    }, { quoted: msg });

}

// ---------- .jobinfo <company name> — public company lookup ----------
// PLAYER COMPANIES ONLY for now — the three majors (Nova Empire, Elegance,
// Chez Adélu) are excluded because their income model is still an open
// question (no `level` to run incomeAtLevel() against — see the header
// comment in lib/jobOffers.js's listOpenOffers() for the same blocker on
// .joboffers). Star rating comes from lib/tierStar.js (spec §4).
//
// Player companies don't have a bio field or a way to set one yet — the
// spec's bio example was under the majors' section specifically — so this
// shows a plain "not set" placeholder rather than inventing filler text.
//
// Matching: exact company-name match (case-insensitive) first; if none,
// falls back to a substring match, but only if that substring matches
// EXACTLY one company (ambiguous matches ask the user to be more
// specific rather than guessing). Company names aren't enforced unique
// anywhere in the system, so if two companies share an exact name this
// just returns whichever is found first — a pre-existing gap, not
// something new here.
async function jobInfoCommand(sock, msg, text) {

    const query = text.replace(".jobinfo", "").trim();

    if (!query) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: errorBox("𝗝𝗢𝗕𝗜𝗡𝗙𝗢", "Enter a company name.", [".jobinfo Roy Trading Group"])
        }, { quoted: msg });
    }

    const users = loadUsers();
    const q = query.toLowerCase();

    const exactMatches = Object.entries(users).filter(([, u]) => u.company && u.company.name.toLowerCase() === q);

    let match = exactMatches[0];

    if (!match) {

        const substrMatches = Object.entries(users).filter(([, u]) => u.company && u.company.name.toLowerCase().includes(q));

        if (substrMatches.length > 1) {
            const names = substrMatches.map(([, u]) => `• ${u.company.name}`).join("\n");
            return await sock.sendMessage(msg.key.remoteJid, {
                text: `⚠️ Multiple companies match "${query}" — be more specific:\n\n${names}`
            }, { quoted: msg });
        }

        match = substrMatches[0];

    }

    if (!match) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `📭 No company found matching "${query}".\n\n(Note: Nova Empire, Elegance, and Chez Adélu aren't searchable here yet.)`
        }, { quoted: msg });
    }

    const [, ownerData] = match;
    const company = ownerData.company;
    const industry = getIndustry(company.industry);
    const stars = tierForLevel(company.level);
    const income = incomeAtLevel(company.level);

    const openLines = Object.values(company.offers || {}).map(offer => {
        const rate = positionRate(company.industry, offer.position);
        const amount = Math.round(income * (rate / 100));
        const maxSlots = getMaxSlots(company.industry, offer.position);
        const filledCount = Object.values(company.employees || {}).filter(e => e.position === offer.position).length;
        return `#${offer.id} ${titleCase(offer.position)} [${filledCount}/${maxSlots}] — ~${amount.toLocaleString()} 🌙/payout`;
    });

    await sock.sendMessage(msg.key.remoteJid, {
        text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
   🏢 ${company.name}
╰━━━━━━━━━━━━━━━━━━━━━━━╮
» Industry : ${industry ? industry.label : "unknown"}
» Rating   : ${"⭐".repeat(stars)} (${stars}-Star)
» Bio      : not set
━━━━━━━━━━━━━━━━━━━━━━━━━
📢 Open Positions
${openLines.length ? openLines.join("\n") : "  none right now"}
━━━━━━━━━━━━━━━━━━━━━━━━━
Apply with: .jobapply <offer number>`
    }, { quoted: msg });

}

module.exports = {
    jobOffersCommand,
    jobApplyCommand,
    jobCommand,
    dutyCommand,
    jobInfoCommand
};