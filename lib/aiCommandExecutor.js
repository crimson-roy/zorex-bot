"use strict";

const fs = require("fs");
const dataPath = require("./dataPath");
const { checkCooldown, setCooldown } = require("../commands/cooldown");
const { checkDailyLimit, incrementDailyPlay, getDailyStatus } = require("../commands/dailylimit");
const {
    companyCommand,
    companyUpgradeCommand,
    upgradeCostAtLevel
} = require("../commands/company");
const { cardCommands, seriesSearchCommand } = require("../commands/card");
const { economyCommands } = require("../commands/economy");
const { dailyCommand } = require("../commands/daily");
const { workCommand } = require("../commands/work");
const {
    viewCollection,
    viewInventory
} = require("../commands/auction");

const USERS_FILE = dataPath("users.json");
const COLLECTION_FILE = dataPath("collection.json");
const COMMAND_COOLDOWN_MS = 30 * 1000;
const CONFIRM_EXPOSURE_THRESHOLD = 5_000_000;
const MAX_BATCH_REPEATS = 25;
const ALLOWED_ACTIONS = new Set([
    "balance",
    "profile",
    "company",
    "card_search",
    "series_search",
    "inventory",
    "collection",
    "deposit",
    "withdraw",
    "daily",
    "work",
    "company_upgrade",
    "transfer",
    "casino",
    "slots"
]);

function loadJson(file, fallback = {}) {
    try {
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
        }
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {
        return fallback;
    }
}

function saveJson(file, value) {
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 4));
    fs.renameSync(temp, file);
}

function formatSigned(value) {
    const amount = Number(value) || 0;
    return amount >= 0
        ? `+${amount.toLocaleString()}`
        : `-${Math.abs(amount).toLocaleString()}`;
}

function sanitizeText(value, maxLength) {
    return String(value || "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}

function normalizeTier(value) {
    const tier = sanitizeText(value, 8).toUpperCase();
    return ["UR", "SSR", "SR", "S", "R", "C"].includes(tier)
        ? tier
        : "";
}

function normalizeAction(raw) {
    if (!raw || typeof raw !== "object") return null;

    const name = sanitizeText(raw.name, 32).toLowerCase();
    if (!ALLOWED_ACTIONS.has(name)) return null;

    if (name === "casino" || name === "slots") {
        const amount = Number(raw.amount);
        const repeats = Number(raw.repeats ?? 1);

        if (
            !Number.isFinite(amount) ||
            amount <= 0 ||
            !Number.isInteger(repeats) ||
            repeats < 1 ||
            repeats > MAX_BATCH_REPEATS
        ) {
            return null;
        }

        return { name, amount, repeats };
    }

    if (
        name === "deposit" ||
        name === "withdraw"
    ) {
        const rawAmount =
            String(raw.amount ?? "")
                .trim()
                .toLowerCase();

        if (rawAmount === "all") {
            return {
                name,
                amount: "all"
            };
        }

        const amount =
            Number(raw.amount);

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            return null;
        }

        return {
            name,
            amount
        };
    }

    if (name === "transfer") {
        const amount =
            Number(raw.amount);

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            return null;
        }

        return {
            name,
            amount
        };
    }

    if (name === "work") {
        const tier =
            String(
                raw.tier ?? "1"
            ).trim();

        return {
            name,
            tier:
                ["1", "2", "3"].includes(tier)
                    ? tier
                    : "1"
        };
    }

    if (
        name === "inventory" ||
        name === "collection"
    ) {
        const index =
            Number(raw.index);

        return {
            name,
            index:
                Number.isInteger(index) &&
                index > 0
                    ? index
                    : null
        };
    }

    if (name === "card_search") {
        const query = sanitizeText(raw.query, 120);
        if (!query) return null;

        return {
            name,
            query,
            tier: normalizeTier(raw.tier)
        };
    }

    if (name === "series_search") {
        const query = sanitizeText(raw.query, 120);
        if (!query) return null;

        return { name, query };
    }

    return { name };
}

function normalizeCommandPlan(rawCommands) {
    if (!Array.isArray(rawCommands)) return [];

    const normalized = [];
    for (const raw of rawCommands.slice(0, 8)) {
        const action = normalizeAction(raw);
        if (action) normalized.push(action);
    }
    return normalized;
}

function resolveTransferTarget(msg) {
    const context =
        msg?.message
            ?.extendedTextMessage
            ?.contextInfo;

    if (
        Array.isArray(
            context?.mentionedJid
        ) &&
        context.mentionedJid.length > 0
    ) {
        return context.mentionedJid[0];
    }

    if (context?.participant) {
        return context.participant;
    }

    return null;
}

function bindCommandContext(
    commands,
    msg
) {
    const transferTarget =
        resolveTransferTarget(
            msg
        );

    return commands.map(command => {
        if (
            command.name !==
            "transfer"
        ) {
            return command;
        }

        return {
            ...command,
            target:
                transferTarget ||
                null
        };
    });
}

function companyUpgradeExposure(
    registeredUserId
) {
    if (!registeredUserId) {
        return 0;
    }

    const users =
        loadJson(
            USERS_FILE,
            {}
        );

    const company =
        users[registeredUserId]
            ?.company;

    if (!company) {
        return 0;
    }

    return upgradeCostAtLevel(
        Number(
            company.level ||
            0
        )
    );
}

function actionExposure(
    command,
    registeredUserId
) {
    if (
        command.name === "casino" ||
        command.name === "slots"
    ) {
        return (
            command.amount *
            command.repeats
        );
    }

    if (
        command.name ===
        "transfer"
    ) {
        return command.amount;
    }

    if (
        command.name ===
        "company_upgrade"
    ) {
        return companyUpgradeExposure(
            registeredUserId
        );
    }

    return 0;
}

function calculateExposure(
    commands,
    registeredUserId
) {
    return commands.reduce(
        (total, command) =>
            total +
            actionExposure(
                command,
                registeredUserId
            ),
        0
    );
}

function requiresConfirmation(
    commands,
    registeredUserId
) {
    return (
        calculateExposure(
            commands,
            registeredUserId
        ) >
        CONFIRM_EXPOSURE_THRESHOLD
    );
}

function actionSummaryLine(
    command,
    registeredUserId
) {
    switch (command.name) {
        case "balance":
            return "• Show account balance";

        case "profile":
            return "• Show Zorex profile";

        case "company":
            return "• Show company status";

        case "inventory":
            return command.index
                ? `• Show inventory item #${command.index}`
                : "• Show inventory";

        case "collection":
            return command.index
                ? `• Show collection item #${command.index}`
                : "• Show card collection";

        case "deposit":
            return `• Deposit ${command.amount === "all" ? "all wallet funds" : command.amount.toLocaleString() + " 🌙"}`;

        case "withdraw":
            return `• Withdraw ${command.amount === "all" ? "all bank funds" : command.amount.toLocaleString() + " 🌙"}`;

        case "daily":
            return "• Claim daily reward";

        case "work":
            return `• Work tier ${command.tier}`;

        case "company_upgrade": {
            const cost =
                companyUpgradeExposure(
                    registeredUserId
                );

            return cost > 0
                ? `• Upgrade company — current cost ${cost.toLocaleString()} 🌙`
                : "• Upgrade company";
        }

        case "transfer":
            return `• Transfer ${command.amount.toLocaleString()} 🌙 to ${command.target ? "the mentioned/replied user" : "a recipient (mention/reply required)"}`;

        case "card_search":
            return "• Search card: " + command.query +
                (command.tier ? ` [${command.tier}]` : "");

        case "series_search":
            return "• Search card series: " + command.query;

        case "casino":
            return `• Casino: ${command.amount.toLocaleString()} 🌙 × ${command.repeats} = ${(command.amount * command.repeats).toLocaleString()} 🌙 exposure`;

        case "slots":
            return `• Slots: ${command.amount.toLocaleString()} 🌙 × ${command.repeats} = ${(command.amount * command.repeats).toLocaleString()} 🌙 exposure`;

        default:
            return "• Unsupported action";
    }
}

function describePlan(
    commands,
    registeredUserId
) {
    const exposure =
        calculateExposure(
            commands,
            registeredUserId
        );

    const lines =
        commands.map(
            command =>
                actionSummaryLine(
                    command,
                    registeredUserId
                )
        );

    if (exposure > 0) {
        lines.push(
            `\n*Total requested exposure:* ${exposure.toLocaleString()} 🌙`
        );
    }

    return lines.join("\n");
}

function makeExecutionMsg(msg, registeredUserId) {
    return {
        ...msg,
        key: {
            ...msg.key,
            participant: registeredUserId
        }
    };
}

function makeTargetExecutionMsg(
    msg,
    registeredUserId,
    target
) {
    const existingExtended =
        msg?.message
            ?.extendedTextMessage ||
        {};

    const existingContext =
        existingExtended
            .contextInfo ||
        {};

    return {
        ...msg,
        key: {
            ...msg.key,
            participant:
                registeredUserId
        },
        message: {
            ...(msg.message || {}),
            extendedTextMessage: {
                ...existingExtended,
                contextInfo: {
                    ...existingContext,
                    participant:
                        target ||
                        existingContext.participant,
                    mentionedJid:
                        target
                            ? [target]
                            : (
                                existingContext.mentionedJid ||
                                []
                            )
                }
            }
        }
    };
}

async function sendBalance(sock, msg, userId) {
    const users = loadJson(USERS_FILE, {});
    const user = users[userId];

    if (!user) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: "⚠️ Your registered Zorex profile could not be found." },
            { quoted: msg }
        );
    }

    const bankLimit = Number(user.bankLimit ?? 100000);

    return await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🏧 *ACCOUNT BALANCE*

> *${user.name || "Zorex User"}*
> Wallet: ${Number(user.wallet || 0).toLocaleString()} 🌙
> Bank: ${Number(user.bank || 0).toLocaleString()} 🌙
> Capacity: ${bankLimit.toLocaleString()} 🌙`
        },
        { quoted: msg }
    );
}

async function sendProfile(sock, msg, userId) {
    const users = loadJson(USERS_FILE, {});
    const user = users[userId];

    if (!user) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: "⚠️ Your registered Zorex profile could not be found." },
            { quoted: msg }
        );
    }

    const companyName = user.company?.name || "None";

    return await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`👤 *ZOREX PROFILE*

> Name: ${user.name || "Unknown"}
> Age: ${user.age || "Not Set"}
> Bio: ${user.bio || "No bio set."}
> Role: ${user.role || "User"}
> Level: ${Number(user.level || 1)}
> Rank: ${user.rank || "Beginner"}
> Company: ${companyName}
> Wallet: ${Number(user.wallet || 0).toLocaleString()} 🌙
> Bank: ${Number(user.bank || 0).toLocaleString()} 🌙`
        },
        { quoted: msg }
    );
}

function returnExpiredCharm(users, userId) {
    const active = users[userId]?.luckyCharmActive;

    if (!active || Date.now() < Number(active.expiresAt || 0)) {
        return false;
    }

    delete users[userId].luckyCharmActive;

    const collection = loadJson(COLLECTION_FILE, {});
    if (!collection[userId]) collection[userId] = [];

    collection[userId].push({
        id: "luckycharm",
        name: "Lucky Charm",
        type: "luck",
        obtainedFrom: "auction",
        obtainedAt: Date.now()
    });

    saveJson(COLLECTION_FILE, collection);
    return true;
}

function casinoRound(users, userId, bet) {
    const user = users[userId];
    user.wallet -= bet;

    let win;
    let charmUsed = false;

    if (
        user.luckyCharmActive &&
        Date.now() < Number(user.luckyCharmActive.expiresAt || 0)
    ) {
        win = true;
        charmUsed = true;
        delete user.luckyCharmActive;
    } else {
        win = Math.random() * 100 < 60;
    }

    if (win) {
        const prize = bet * 2;
        user.wallet += prize;

        return {
            result: "WIN",
            prize,
            net: prize - bet,
            charmUsed
        };
    }

    return {
        result: "LOSS",
        prize: 0,
        net: -bet,
        charmUsed
    };
}

function slotsRound(users, userId, bet) {
    const user = users[userId];
    user.wallet -= bet;

    const symbols = ["🍒", "🍋", "🔔", "💎"];
    const roll = Math.random() * 100;

    let slotResult;
    let multiplier = 0;

    if (roll < 40) {
        let a = symbols[Math.floor(Math.random() * symbols.length)];
        let b = symbols[Math.floor(Math.random() * symbols.length)];
        let c = symbols[Math.floor(Math.random() * symbols.length)];

        while (a === b || a === c || b === c) {
            b = symbols[Math.floor(Math.random() * symbols.length)];
            c = symbols[Math.floor(Math.random() * symbols.length)];
        }

        slotResult = `${a} | ${b} | ${c}`;
    } else if (roll < 82) {
        const symbol = symbols[Math.floor(Math.random() * symbols.length)];
        let other = symbols[Math.floor(Math.random() * symbols.length)];

        while (other === symbol) {
            other = symbols[Math.floor(Math.random() * symbols.length)];
        }

        slotResult = `${symbol} | ${symbol} | ${other}`;
        multiplier = 2;
    } else if (roll < 98) {
        const symbol = symbols[Math.floor(Math.random() * symbols.length)];
        slotResult = `${symbol} | ${symbol} | ${symbol}`;
        multiplier = 3;
    } else {
        slotResult = "7️⃣ | 7️⃣ | 7️⃣";
        multiplier = 7;
    }

    if (multiplier > 0) {
        const prize = bet * multiplier;
        user.wallet += prize;

        return {
            result: "WIN",
            slotResult,
            multiplier,
            prize,
            net: prize - bet
        };
    }

    return {
        result: "LOSS",
        slotResult,
        multiplier: 0,
        prize: 0,
        net: -bet
    };
}

async function runBatchGame(sock, msg, userId, command) {
    const game = command.name;
    const label = game === "casino" ? "Casino" : "Slots";

    const cooldown = checkCooldown(
        userId,
        game,
        COMMAND_COOLDOWN_MS
    );

    if (cooldown) {
        const seconds = Math.ceil(cooldown / 1000);

        await sock.sendMessage(
            msg.key.remoteJid,
            { text: `⏳ *${label} batch not started* — try again in ${seconds}s.` },
            { quoted: msg }
        );

        return {
            game,
            completed: 0,
            requested: command.repeats,
            reason: "cooldown"
        };
    }

    const users = loadJson(USERS_FILE, {});
    const user = users[userId];

    if (!user) {
        await sock.sendMessage(
            msg.key.remoteJid,
            { text: "⚠️ Your registered Zorex profile could not be found." },
            { quoted: msg }
        );

        return {
            game,
            completed: 0,
            requested: command.repeats,
            reason: "profile"
        };
    }

    const charmReturned =
        game === "casino"
            ? returnExpiredCharm(users, userId)
            : false;

    if (charmReturned) {
        saveJson(USERS_FILE, users);
    }

    const daily = getDailyStatus(userId, game);
    const remaining = Math.max(0, daily.limit - daily.used);

    if (remaining <= 0) {
        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`📅 *${label} daily limit reached*

> Used: ${daily.used}/${daily.limit}`
            },
            { quoted: msg }
        );

        return {
            game,
            completed: 0,
            requested: command.repeats,
            reason: "daily-limit"
        };
    }

    const targetRounds = Math.min(command.repeats, remaining);
    const startingWallet = Number(user.wallet || 0);

    const lines = [];
    let completed = 0;
    let totalWagered = 0;
    let stopReason = "";

    for (let i = 0; i < targetRounds; i++) {
        if (Number(user.wallet || 0) < command.amount) {
            stopReason = "wallet";
            break;
        }

        const limit = checkDailyLimit(userId, game);

        if (limit) {
            stopReason = "daily-limit";
            break;
        }

        const result =
            game === "casino"
                ? casinoRound(users, userId, command.amount)
                : slotsRound(users, userId, command.amount);

        incrementDailyPlay(userId, game);
        saveJson(USERS_FILE, users);

        completed++;
        totalWagered += command.amount;

        if (game === "casino") {
            lines.push(
                result.result === "WIN"
                    ? (
                        `> Round ${completed} — WIN${result.charmUsed ? " 🍀" : ""} — ` +
                        `prize ${result.prize.toLocaleString()} 🌙 ` +
                        `(net ${formatSigned(result.net)} 🌙)`
                    )
                    : (
                        `> Round ${completed} — LOSS — ` +
                        `${formatSigned(result.net)} 🌙`
                    )
            );
        } else {
            lines.push(
                result.result === "WIN"
                    ? (
                        `> Round ${completed} — ${result.slotResult} — ` +
                        `WIN ×${result.multiplier} — net ${formatSigned(result.net)} 🌙`
                    )
                    : (
                        `> Round ${completed} — ${result.slotResult} — ` +
                        `LOSS — ${formatSigned(result.net)} 🌙`
                    )
            );
        }
    }

    if (completed > 0) {
        setCooldown(userId, game);
    }

    const finalWallet = Number(user.wallet || 0);
    const net = finalWallet - startingWallet;

    if (completed < command.repeats && !stopReason) {
        stopReason =
            targetRounds < command.repeats
                ? "daily-limit"
                : "";
    }

    let stopLine = "";

    if (stopReason === "wallet") {
        stopLine =
            "\n⚠️ Batch stopped because the wallet could not cover another round.";
    } else if (stopReason === "daily-limit") {
        stopLine =
            "\n📅 Batch stopped at today's game limit.";
    }

    const afterDaily = getDailyStatus(userId, game);

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🎰 *${label} Batch — ${completed}/${command.repeats} rounds*

${lines.length ? lines.join("\n") : "> No rounds completed."}

*Summary*
> Wager per round: ${command.amount.toLocaleString()} 🌙
> Total wagered: ${totalWagered.toLocaleString()} 🌙
> Net result: ${formatSigned(net)} 🌙
> Final wallet: ${finalWallet.toLocaleString()} 🌙
> Daily plays: ${afterDaily.used}/${afterDaily.limit}${stopLine}`
        },
        { quoted: msg }
    );

    return {
        game,
        completed,
        requested: command.repeats,
        totalWagered,
        net,
        finalWallet,
        reason: stopReason || null
    };
}

async function executeAiCommandPlan(
    sock,
    msg,
    registeredUserId,
    commands
) {
    const executionMsg =
        makeExecutionMsg(
            msg,
            registeredUserId
        );

    const results = [];

    for (const command of commands) {
        switch (command.name) {
            case "balance":
                await sendBalance(
                    sock,
                    msg,
                    registeredUserId
                );
                results.push({
                    name:
                        "balance"
                });
                break;

            case "profile":
                await sendProfile(
                    sock,
                    msg,
                    registeredUserId
                );
                results.push({
                    name:
                        "profile"
                });
                break;

            case "company":
                await companyCommand(
                    sock,
                    executionMsg,
                    ".company"
                );
                results.push({
                    name:
                        "company"
                });
                break;

            case "inventory":
                await viewInventory(
                    sock,
                    executionMsg,
                    command.index
                        ? `.inv ${command.index}`
                        : ".inv"
                );
                results.push({
                    name:
                        "inventory",
                    index:
                        command.index
                });
                break;

            case "collection":
                await viewCollection(
                    sock,
                    executionMsg,
                    command.index
                        ? `.col ${command.index}`
                        : ".col"
                );
                results.push({
                    name:
                        "collection",
                    index:
                        command.index
                });
                break;

            case "deposit":
                await economyCommands(
                    sock,
                    executionMsg,
                    `.dep ${command.amount}`
                );
                results.push({
                    name:
                        "deposit",
                    amount:
                        command.amount
                });
                break;

            case "withdraw":
                await economyCommands(
                    sock,
                    executionMsg,
                    `.wd ${command.amount}`
                );
                results.push({
                    name:
                        "withdraw",
                    amount:
                        command.amount
                });
                break;

            case "daily":
                await dailyCommand(
                    sock,
                    executionMsg
                );
                results.push({
                    name:
                        "daily"
                });
                break;

            case "work":
                await workCommand(
                    sock,
                    executionMsg,
                    `.work ${command.tier}`
                );
                results.push({
                    name:
                        "work",
                    tier:
                        command.tier
                });
                break;

            case "company_upgrade":
                await companyUpgradeCommand(
                    sock,
                    executionMsg
                );
                results.push({
                    name:
                        "company_upgrade"
                });
                break;

            case "transfer": {
                if (!command.target) {
                    await sock.sendMessage(
                        msg.key.remoteJid,
                        {
                            text:
`⚠️ *Transfer needs a recipient*

> Mention the person or reply to one of their messages, then ask Zorex AI to send the amount.`
                        },
                        {
                            quoted:
                                msg
                        }
                    );

                    results.push({
                        name:
                            "transfer",
                        completed:
                            false,
                        reason:
                            "missing-target"
                    });

                    break;
                }

                const targetMsg =
                    makeTargetExecutionMsg(
                        msg,
                        registeredUserId,
                        command.target
                    );

                await economyCommands(
                    sock,
                    targetMsg,
                    `.donate ${command.amount}`
                );

                results.push({
                    name:
                        "transfer",
                    amount:
                        command.amount,
                    target:
                        command.target
                });
                break;
            }

            case "card_search": {
                const commandText =
                    `.cs ${command.query}${command.tier ? ` ${command.tier}` : ""}`;

                await cardCommands(
                    sock,
                    executionMsg,
                    commandText
                );

                results.push({
                    name:
                        "card_search",
                    query:
                        command.query,
                    tier:
                        command.tier ||
                        null
                });
                break;
            }

            case "series_search":
                await seriesSearchCommand(
                    sock,
                    executionMsg,
                    `.ss ${command.query}`
                );
                results.push({
                    name:
                        "series_search",
                    query:
                        command.query
                });
                break;

            case "casino":
            case "slots":
                results.push(
                    await runBatchGame(
                        sock,
                        msg,
                        registeredUserId,
                        command
                    )
                );
                break;

            default:
                break;
        }
    }

    return {
        results,
        summary:
            commands
                .map(
                    command =>
                        actionSummaryLine(
                            command,
                            registeredUserId
                        )
                )
                .join("\n")
    };
}

module.exports = {
    CONFIRM_EXPOSURE_THRESHOLD,
    MAX_BATCH_REPEATS,
    ALLOWED_ACTIONS,
    normalizeCommandPlan,
    bindCommandContext,
    calculateExposure,
    requiresConfirmation,
    describePlan,
    executeAiCommandPlan
};
