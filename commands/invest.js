const fs = require("fs");
const dataPath = require("../lib/dataPath");
const { loadInventory, saveInventory } = require("./inventory");
const { findEmploymentAnywhere } = require("../lib/jobOffers");

// PERSISTENCE FIX: both are written by this file (wallet on every buy/
// sell, market rates on every tick) — routed through dataPath() so a
// redeploy doesn't wipe portfolios or reset the market. See lib/dataPath.js.
const USERS_FILE = dataPath("users.json");
const MARKET_FILE = dataPath("market.json");

// How often the market moves, and how many missed ticks we'll catch up on
// in one go if the bot was offline for a while (prevents a huge compounding
// jump after a long downtime).
const TICK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CATCHUP_TICKS = 12;

// risk: 0 = "Secure" (🛡️, gentle steady drift, never crashes)
// risk: N = N% chance each tick of a crash (-15% to -30%), otherwise a
// normal up/down drift (-3% to +5%)
const ASSETS = {
    gold:  { name: "Solid Gold Bullion",          emoji: "🥇", baseRate: 40000,    risk: 0 },
    stark: { name: "StarkCorp High-Yield Shares", emoji: "📈", baseRate: 4805,     risk: 2 },
    land:  { name: "Commercial Real Estate Deed", emoji: "🗺️", baseRate: 1500000, risk: 0 },
    oil:   { name: "Crude Oil Futures",           emoji: "🛢️", baseRate: 3116,    risk: 2 },
    tech:  { name: "Quantum Computing Chips",     emoji: "💾", baseRate: 169645,  risk: 5 },
    bonds: { name: "Sovereign Treasury Bonds",    emoji: "📜", baseRate: 206534,  risk: 0 },
    art:   { name: "Digital Asset Collectible",   emoji: "🎨", baseRate: 179,     risk: 10 }
};

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 4), "utf8");
}

function loadMarket() {
    if (!fs.existsSync(MARKET_FILE)) fs.writeFileSync(MARKET_FILE, "{}");
    return JSON.parse(fs.readFileSync(MARKET_FILE, "utf8"));
}

function saveMarket(market) {
    fs.writeFileSync(MARKET_FILE, JSON.stringify(market, null, 4), "utf8");
}

function randomFloat(min, max) {
    return Math.random() * (max - min) + min;
}

function riskLabel(risk) {
    return risk === 0 ? "🛡️ Secure" : `⚠️ ${risk}% Risk`;
}

// Moves every asset's rate forward by however many 30-min ticks have
// elapsed since it was last touched, capped at MAX_CATCHUP_TICKS. Called at
// the start of every .invest / .assets use, so the market stays live
// without needing a background timer.
function tickMarket() {

    const market = loadMarket();
    const now = Date.now();
    let changed = false;

    for (const id in ASSETS) {

        const def = ASSETS[id];

        if (!market[id]) {
            market[id] = { rate: def.baseRate, lastTick: now };
            changed = true;
            continue;
        }

        const elapsed = now - market[id].lastTick;
        let ticks = Math.floor(elapsed / TICK_INTERVAL_MS);

        if (ticks <= 0) continue;

        ticks = Math.min(ticks, MAX_CATCHUP_TICKS);
        changed = true;

        let rate = market[id].rate;

        for (let i = 0; i < ticks; i++) {

            if (def.risk > 0 && Math.random() * 100 < def.risk) {
                rate *= 1 - randomFloat(0.15, 0.30); // crash
            } else if (def.risk > 0) {
                rate *= 1 + randomFloat(-0.03, 0.05); // normal drift
            } else {
                rate *= 1 + randomFloat(-0.005, 0.015); // secure, gentle drift
            }

        }

        market[id].rate = Math.max(1, Math.round(rate));
        market[id].lastTick = now;

    }

    if (changed) saveMarket(market);

    return market;

}

function notRegisteredMessage() {
    return `⚠️ You are not registered.\n\nUse:\n\n.register YOUR_NAME`;
}

// ---------- .invest — market listing, or "buy"/"sell" subcommands ----------
async function investCommand(sock, msg, text) {

    const args = text.replace(".invest", "").trim().split(/\s+/).filter(Boolean);
    const sub = (args[0] || "").toLowerCase();

    if (sub === "buy" || sub === "sell") {
        return await tradeAsset(sock, msg, sub, args.slice(1));
    }

    const market = tickMarket();

    const lines = Object.entries(ASSETS).map(([id, def]) => {
        const rate = market[id].rate;
        return `${def.emoji} ${def.name} [${id}]
   Rate: ${rate.toLocaleString()} 🌙 | ${riskLabel(def.risk)}`;
    });

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
     📈 𝗚𝗟𝗢𝗕𝗔𝗟 𝗠𝗔𝗥𝗞𝗘𝗧
╰━━━━━━━━━━━━━━━━━━━━━━━╯
${lines.join("\n")}
━━━━━━━━━━━━━━━━━━━━━━━━━
.invest buy <id> <amount>
.invest sell <id> <amount>`
        },
        { quoted: msg }
    );

}

async function tradeAsset(sock, msg, action, args) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: notRegisteredMessage() },
            { quoted: msg }
        );
    }

    const id = (args[0] || "").toLowerCase();
    const def = ASSETS[id];

    if (!def) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: `⚠️ Unknown asset "${args[0] || ""}".\n\nUse .invest to see valid IDs (gold, stark, land, oil, tech, bonds, art).` },
            { quoted: msg }
        );
    }

    const amount = Number(args[1]);

    if (!Number.isInteger(amount) || amount <= 0) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: `⚠️ Usage:\n\n.invest ${action} ${id} <amount>\n\nExample:\n\n.invest ${action} ${id} 5` },
            { quoted: msg }
        );
    }

    const market = tickMarket();
    const rate = market[id].rate;
    const total = rate * amount;

    const inventory = loadInventory();
    const items = inventory[sender] || [];
    const holding = items.find(it => it.id === id && it.type === "asset");

    if (action === "buy") {

        if (users[sender].wallet < total) {
            return await sock.sendMessage(
                msg.key.remoteJid,
                { text: `❌ You need ${total.toLocaleString()} 🌙 to buy ${amount} ${def.name}.\n\n💰 Wallet: ${users[sender].wallet.toLocaleString()} 🌙` },
                { quoted: msg }
            );
        }

        users[sender].wallet -= total;
        saveUsers(users);

        if (holding) {
            holding.quantity += amount;
        } else {
            if (!inventory[sender]) inventory[sender] = [];
            inventory[sender].push({ id, type: "asset", quantity: amount, obtainedAt: Date.now() });
        }

        saveInventory(inventory);

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `${def.emoji} *BOUGHT*
» Asset   : ${def.name} x${amount}
» Cost    : ${total.toLocaleString()} 🌙
» Rate    : ${rate.toLocaleString()} 🌙 each
» Wallet  : ${users[sender].wallet.toLocaleString()} 🌙`
            },
            { quoted: msg }
        );

    } else {

        const owned = holding ? holding.quantity : 0;

        if (owned < amount) {
            return await sock.sendMessage(
                msg.key.remoteJid,
                { text: `❌ You only hold ${owned} ${def.name} — can't sell ${amount}.` },
                { quoted: msg }
            );
        }

        holding.quantity -= amount;

        if (holding.quantity <= 0) {
            inventory[sender] = items.filter(it => !(it.id === id && it.type === "asset"));
        }

        saveInventory(inventory);

        users[sender].wallet += total;
        saveUsers(users);

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `${def.emoji} *SOLD*
» Asset   : ${def.name} x${amount}
» Proceeds: ${total.toLocaleString()} 🌙
» Rate    : ${rate.toLocaleString()} 🌙 each
» Wallet  : ${users[sender].wallet.toLocaleString()} 🌙`
            },
            { quoted: msg }
        );

    }

}

// ---------- .assets — personal portfolio ----------
async function assetsCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: notRegisteredMessage() },
            { quoted: msg }
        );
    }

    const market = tickMarket();
    const inventory = loadInventory();
    const holdings = (inventory[sender] || []).filter(it => it.type === "asset" && ASSETS[it.id]);

    const liquid = users[sender].wallet + users[sender].bank;

    if (holdings.length === 0) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
   💼 𝗙𝗜𝗡𝗔𝗡𝗖𝗜𝗔𝗟 𝗔𝗨𝗗𝗜𝗧 💼
╰━━━━━━━━━━━━━━━━━━━━━━━╮
ℹ️ No assets currently held in your portfolio.
━━━━━━━━━━━━━━━━━━━━━━━━━
» Liquid Reserves : ${liquid.toLocaleString()} 🌙
» Asset Value     : 0 🌙
» Total Net Worth : ${liquid.toLocaleString()} 🌙`
            },
            { quoted: msg }
        );

    }

    let assetValue = 0;

    const lines = holdings.map(h => {
        const def = ASSETS[h.id];
        const rate = market[h.id].rate;
        const value = rate * h.quantity;
        assetValue += value;
        return `${def.emoji} ${def.name} x${h.quantity}
   Value: ${value.toLocaleString()} 🌙 (${rate.toLocaleString()} 🌙 each)`;
    });

    const netWorth = liquid + assetValue;

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
   💼 𝗙𝗜𝗡𝗔𝗡𝗖𝗜𝗔𝗟 𝗔𝗨𝗗𝗜𝗧 💼
╰━━━━━━━━━━━━━━━━━━━━━━━╮
${lines.join("\n")}
━━━━━━━━━━━━━━━━━━━━━━━━━
» Liquid Reserves : ${liquid.toLocaleString()} 🌙
» Asset Value     : ${assetValue.toLocaleString()} 🌙
» Total Net Worth : ${netWorth.toLocaleString()} 🌙`
        },
        { quoted: msg }
    );

}

// ---------- .companyinvest — same mechanics, spends the COMPANY wallet ----------
// Authorized callers: the company's OWNER (always, no role needed — it's
// their company), or an EMPLOYEE holding the "investor" role granted via
// .company assign investor @user. Holdings are stored directly on the
// company object (company.assets — same {id, quantity} shape as a
// personal inventory asset entry) rather than in inventory.json, since
// this is company-scoped data that already lives alongside
// company.wallet/company.employees.
async function resolveInvestingCompany(users, sender) {

    if (users[sender].company) {
        return { company: users[sender].company, ownerId: sender };
    }

    const job = findEmploymentAnywhere(users, sender);

    if (job) {
        const employerCompany = users[job.ownerId].company;
        const employeeRecord = employerCompany.employees[job.employeeId];
        if (employeeRecord && employeeRecord.role === "investor") {
            return { company: employerCompany, ownerId: job.ownerId };
        }
    }

    return null;

}

async function companyInvestCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, { text: notRegisteredMessage() }, { quoted: msg });
    }

    const resolved = await resolveInvestingCompany(users, sender);

    if (!resolved) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You need to own a company, or hold the *investor* role at one (via .company assign investor), to use .companyinvest.`
        }, { quoted: msg });
    }

    const { company } = resolved;
    company.wallet = company.wallet || 0;
    company.assets = company.assets || [];

    const args = text.replace(".companyinvest", "").trim().split(/\s+/).filter(Boolean);
    const sub = (args[0] || "").toLowerCase();

    if (sub !== "buy" && sub !== "sell") {

        const market = tickMarket();

        const lines = Object.entries(ASSETS).map(([id, def]) => {
            const rate = market[id].rate;
            return `${def.emoji} ${def.name} [${id}]
   Rate: ${rate.toLocaleString()} 🌙 | ${riskLabel(def.risk)}`;
        });

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
   📈 𝗖𝗢𝗠𝗣𝗔𝗡𝗬 𝗠𝗔𝗥𝗞𝗘𝗧
╰━━━━━━━━━━━━━━━━━━━━━━━╮
${lines.join("\n")}
━━━━━━━━━━━━━━━━━━━━━━━━━
🏢 Company Wallet: ${company.wallet.toLocaleString()} 🌙

.companyinvest buy <id> <amount>
.companyinvest sell <id> <amount>`
        }, { quoted: msg });

    }

    const id = (args[1] || "").toLowerCase();
    const def = ASSETS[id];

    if (!def) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Unknown asset "${args[1] || ""}".\n\nUse .companyinvest to see valid IDs (gold, stark, land, oil, tech, bonds, art).`
        }, { quoted: msg });
    }

    const amount = Number(args[2]);

    if (!Number.isInteger(amount) || amount <= 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Usage:\n\n.companyinvest ${sub} ${id} <amount>\n\nExample:\n\n.companyinvest ${sub} ${id} 5`
        }, { quoted: msg });
    }

    const market = tickMarket();
    const rate = market[id].rate;
    const total = rate * amount;

    const holding = company.assets.find(a => a.id === id);

    if (sub === "buy") {

        if (company.wallet < total) {
            return await sock.sendMessage(msg.key.remoteJid, {
                text: `❌ Company wallet needs ${total.toLocaleString()} 🌙 to buy ${amount} ${def.name}.\n\n🏢 Company Wallet: ${company.wallet.toLocaleString()} 🌙`
            }, { quoted: msg });
        }

        company.wallet -= total;

        if (holding) {
            holding.quantity += amount;
        } else {
            company.assets.push({ id, quantity: amount, obtainedAt: Date.now() });
        }

        saveUsers(users);

        await sock.sendMessage(msg.key.remoteJid, {
            text: `${def.emoji} *COMPANY BOUGHT*
» Asset   : ${def.name} x${amount}
» Cost    : ${total.toLocaleString()} 🌙
» Rate    : ${rate.toLocaleString()} 🌙 each
» Company Wallet: ${company.wallet.toLocaleString()} 🌙`
        }, { quoted: msg });

    } else {

        const owned = holding ? holding.quantity : 0;

        if (owned < amount) {
            return await sock.sendMessage(msg.key.remoteJid, {
                text: `❌ Company only holds ${owned} ${def.name} — can't sell ${amount}.`
            }, { quoted: msg });
        }

        holding.quantity -= amount;

        if (holding.quantity <= 0) {
            company.assets = company.assets.filter(a => a.id !== id);
        }

        company.wallet += total;

        saveUsers(users);

        await sock.sendMessage(msg.key.remoteJid, {
            text: `${def.emoji} *COMPANY SOLD*
» Asset   : ${def.name} x${amount}
» Proceeds: ${total.toLocaleString()} 🌙
» Rate    : ${rate.toLocaleString()} 🌙 each
» Company Wallet: ${company.wallet.toLocaleString()} 🌙`
        }, { quoted: msg });

    }

}

module.exports = {
    investCommand,
    assetsCommand,
    companyInvestCommand
};