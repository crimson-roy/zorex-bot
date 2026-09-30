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
const {
    cardCommands,
    seriesSearchCommand,
    loadCards
} = require("../commands/card");
const {
    shopCommands,
    loadShop
} = require("../commands/shop");
const {
    cshopCommands,
    getCurrentRotation
} = require("../commands/cshop");
const { economyCommands } = require("../commands/economy");
const { dailyCommand } = require("../commands/daily");
const { workCommand } = require("../commands/work");
const {
    setWelcomeCommand,
    setLeaveCommand
} = require("../commands/greetings");
const {
    openGroup,
    closeGroup,
    isGroupAdmin
} = require("../commands/misc");
const {
    startOwner
} = require("../commands/owner");
const {
    groupCommands
} = require("../commands/group");
const {
    armSpamKickRule,
    clearSpamKickRule
} = require("../commands/moderation");
const {
    viewCollection,
    viewInventory
} = require("../commands/auction");
const { depthVideoCommand } = require("../commands/graphics");
const { upscaleCommand } = require("../commands/videoUpscale");
const { editCommand } = require("../commands/edit");
const { normalizeName, listAnimations } = require("./editorAnimations");

const USERS_FILE = dataPath("users.json");
const COLLECTION_FILE = dataPath("collection.json");
const COMMAND_COOLDOWN_MS = 30 * 1000;
const CONFIRM_EXPOSURE_THRESHOLD = 5_000_000;
const MAX_BATCH_REPEATS = 25;
const { editorCommand } = require("../commands/editor");

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
    "shop_buy",
    "cshop_buy",
    "set_welcome",
    "set_leave",
    "group_open",
    "group_close",
    "add_owner",
    "promote_user",
    "demote_user",
    "mute_user",
    "unmute_user",
    "kick_user",
    "mute_all",
    "unmute_all",
    "casino",
    "slots",
    "video_depth",
    "video_upscale",
    "video_edit_animation",
    "editor_queue",
    "editor_job",
    "editor_cancel"
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

function sanitizeMessage(value, maxLength = 1500) {
    return String(value || "")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(/\r\n?/g, "\n")
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

    if (name === "video_depth") {
        const requestedMist =
            sanitizeText(raw.mist || "none", 16).toLowerCase();

        const mist =
            ["none", "soft", "mist", "heavy"].includes(requestedMist)
                ? requestedMist
                : "none";

        return {
            name,
            mist,
            quality: "max"
        };
    }

    if (name === "video_upscale") {
        const scale = String(raw.scale || "4").trim();

        if (!["2", "4", "8"].includes(scale)) {
            return null;
        }

        return {
            name,
            scale,
            quality:
                raw.quality === false
                    ? "normal"
                    : "max"
        };
    }

    if (name === "video_edit_animation") {
        const animation =
            normalizeName(
                sanitizeText(
                    raw.animation,
                    64
                )
            );

        const allowed =
            listAnimations()
                .some(
                    item =>
                        item.name ===
                        animation
                );

        if (!allowed) {
            return null;
        }

        return {
            name,
            animation
        };
    }

    if (
        name === "editor_job" ||
        name === "editor_cancel"
    ) {
        const jobId =
            sanitizeText(
                raw.job_id,
                32
            )
                .toUpperCase();

        if (!/^ZRX-[A-F0-9]+$/.test(jobId)) {
            return null;
        }

        return {
            name,
            job_id:
                jobId
        };
    }

    if (name === "editor_queue") {
        return {
            name
        };
    }

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

    if (name === "shop_buy") {
        const item =
            sanitizeText(
                raw.item,
                120
            );

        const quantity =
            Number(
                raw.quantity ?? 1
            );

        if (
            !item ||
            !Number.isInteger(quantity) ||
            quantity < 1 ||
            quantity > 100
        ) {
            return null;
        }

        return {
            name,
            item,
            quantity
        };
    }

    if (name === "cshop_buy") {
        const slot =
            Number(raw.slot);

        if (
            !Number.isInteger(slot) ||
            slot < 1 ||
            slot > 100
        ) {
            return null;
        }

        return {
            name,
            slot
        };
    }

    if (
        name === "set_welcome" ||
        name === "set_leave"
    ) {
        const message =
            sanitizeMessage(
                raw.message,
                1500
            );

        if (!message) {
            return null;
        }

        return {
            name,
            message
        };
    }

    if (name === "mute_user") {
        const rawDuration =
            sanitizeText(
                raw.duration,
                32
            ).toLowerCase();

        const duration =
            /^(?:\d+)(?:mins?|min|m|hrs?|hr|h|d)$/.test(
                rawDuration
            )
                ? rawDuration
                : "";

        const kickIfSpam =
            raw.kick_if_spam === true;

        const spamLimit =
            Math.max(
                2,
                Math.min(
                    Number(
                        raw.spam_limit ||
                        5
                    ) || 5,
                    20
                )
            );

        const spamWindowSeconds =
            Math.max(
                5,
                Math.min(
                    Number(
                        raw.spam_window_seconds ||
                        30
                    ) || 30,
                    300
                )
            );

        return {
            name,
            duration,
            kick_if_spam:
                kickIfSpam,
            spam_limit:
                spamLimit,
            spam_window_seconds:
                spamWindowSeconds
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

function normalizeCatalogValue(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function resolveShopPurchaseSnapshot(command) {
    const shop = loadShop();
    const requested =
        normalizeCatalogValue(
            command.item
        );

    if (!requested) return null;

    const entries =
        Object.entries(shop);

    let match =
        entries.find(
            ([id]) =>
                normalizeCatalogValue(id) ===
                requested
        );

    if (!match) {
        match =
            entries.find(
                ([, item]) =>
                    normalizeCatalogValue(
                        item.name
                    ) === requested
            );
    }

    if (!match) {
        const partial =
            entries.filter(
                ([id, item]) => {
                    const idText =
                        normalizeCatalogValue(id);

                    const nameText =
                        normalizeCatalogValue(
                            item.name
                        );

                    return (
                        idText.includes(
                            requested
                        ) ||
                        nameText.includes(
                            requested
                        ) ||
                        requested.includes(
                            idText
                        ) ||
                        requested.includes(
                            nameText
                        )
                    );
                }
            );

        if (partial.length === 1) {
            match = partial[0];
        }
    }

    if (!match) return null;

    const [itemId, item] =
        match;

    const requestedQty =
        Math.max(
            1,
            Math.min(
                Number(
                    command.quantity ||
                    1
                ),
                100
            )
        );

    const quantity =
        item.type === "bank" ||
        itemId === "raffle_ticket"
            ? requestedQty
            : 1;

    const unitPrice =
        Number(
            item.price ||
            0
        );

    if (
        !Number.isFinite(unitPrice) ||
        unitPrice <= 0
    ) {
        return null;
    }

    return {
        kind: "shop",
        itemId,
        itemName:
            item.name ||
            itemId,
        itemType:
            item.type ||
            "unknown",
        quantity,
        unitPrice,
        totalPrice:
            unitPrice *
            quantity
    };
}

function resolveCshopPurchaseSnapshot(command) {
    const state =
        getCurrentRotation();

    const slot =
        state.slots.find(
            entry =>
                entry.slot ===
                command.slot
        );

    if (!slot) return null;

    const cards =
        loadCards();

    const card =
        cards[slot.cardId];

    return {
        kind: "cshop",
        rotationId:
            state.rotationId,
        rotationDate:
            state.rotationDate,
        slot:
            slot.slot,
        cardId:
            slot.cardId,
        cardName:
            card?.name ||
            slot.cardId,
        tier:
            slot.tier,
        price:
            Number(
                slot.price ||
                0
            ),
        totalPrice:
            Number(
                slot.price ||
                0
            )
    };
}

function sameShopSnapshot(a, b) {
    return Boolean(
        a &&
        b &&
        a.itemId === b.itemId &&
        a.quantity === b.quantity &&
        a.unitPrice === b.unitPrice &&
        a.totalPrice === b.totalPrice
    );
}

function sameCshopSnapshot(a, b) {
    return Boolean(
        a &&
        b &&
        a.rotationId === b.rotationId &&
        a.slot === b.slot &&
        a.cardId === b.cardId &&
        a.price === b.price
    );
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
            command.name ===
            "transfer"
        ) {
            return {
                ...command,
                target:
                    transferTarget ||
                    null
            };
        }

        if (
            command.name === "add_owner" ||
            command.name === "promote_user" ||
            command.name === "demote_user" ||
            command.name === "mute_user" ||
            command.name === "unmute_user" ||
            command.name === "kick_user"
        ) {
            return {
                ...command,
                target:
                    transferTarget ||
                    null
            };
        }

        if (
            command.name ===
            "shop_buy"
        ) {
            return {
                ...command,
                purchase:
                    resolveShopPurchaseSnapshot(
                        command
                    )
            };
        }

        if (
            command.name ===
            "cshop_buy"
        ) {
            return {
                ...command,
                purchase:
                    resolveCshopPurchaseSnapshot(
                        command
                    )
            };
        }

        return command;
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

    if (
        command.name ===
        "shop_buy" ||
        command.name ===
        "cshop_buy"
    ) {
        return Number(
            command.purchase
                ?.totalPrice ||
            0
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

        case "shop_buy":
            return command.purchase
                ? (
                    `• Buy ${command.purchase.itemName} × ${command.purchase.quantity} — ` +
                    `${command.purchase.totalPrice.toLocaleString()} 🌙`
                )
                : `• Buy shop item "${command.item}" — item not found`;

        case "cshop_buy":
            return command.purchase
                ? (
                    `• Buy CShop slot ${command.purchase.slot}: ${command.purchase.cardName} ` +
                    `[${command.purchase.tier}] — ${command.purchase.price.toLocaleString()} 🌙`
                )
                : `• Buy CShop slot ${command.slot} — slot unavailable`;

        case "set_welcome":
            return `• Set this group's welcome message to: "${command.message.slice(0, 120)}${command.message.length > 120 ? "…" : ""}"`;

        case "set_leave":
            return `• Set this group's leave message to: "${command.message.slice(0, 120)}${command.message.length > 120 ? "…" : ""}"`;

        case "group_open":
            return "• Open this group so all members can send messages";

        case "group_close":
            return "• Close this group so only admins can send messages";

        case "add_owner":
            return command.target
                ? "• Add the mentioned/replied user as a Zorex owner"
                : "• Add a Zorex owner — mention/reply required";

        case "promote_user":
            return command.target
                ? "• Promote the mentioned/replied user to group admin"
                : "• Promote a group admin — mention/reply required";

        case "demote_user":
            return command.target
                ? "• Demote the mentioned/replied group admin"
                : "• Demote a group admin — mention/reply required";

        case "mute_user":
            return command.target
                ? (
                    `• Mute the mentioned/replied user` +
                    (command.duration ? ` for ${command.duration}` : "") +
                    (
                        command.kick_if_spam
                            ? `; kick if they send ${command.spam_limit} messages within ${command.spam_window_seconds}s while muted`
                            : ""
                    )
                )
                : "• Mute a user — mention/reply required";

        case "unmute_user":
            return command.target
                ? "• Unmute the mentioned/replied user"
                : "• Unmute a user — mention/reply required";

        case "kick_user":
            return command.target
                ? "• Kick the mentioned/replied user from this group"
                : "• Kick a user — mention/reply required";

        case "mute_all":
            return "• Enable mute-all auto-delete mode for non-admins";

        case "unmute_all":
            return "• Disable mute-all auto-delete mode";

        case "card_search":
            return "• Search card: " + command.query +
                (command.tier ? ` [${command.tier}]` : "");

        case "series_search":
            return "• Search card series: " + command.query;

        case "casino":
            return `• Casino: ${command.amount.toLocaleString()} 🌙 × ${command.repeats} = ${(command.amount * command.repeats).toLocaleString()} 🌙 exposure`;

        case "slots":
            return `• Slots: ${command.amount.toLocaleString()} 🌙 × ${command.repeats} = ${(command.amount * command.repeats).toLocaleString()} 🌙 exposure`;

        case "video_depth":
            return command.mist === "none"
                ? "• Create a full-quality depth video from the replied clip"
                : `• Apply full-quality depth-aware ${command.mist} mist to the replied clip`;

        case "video_upscale":
            return `• AI upscale the replied video ×${command.scale}${command.quality === "max" ? " in maximum-quality mode" : ""}`;

        case "video_edit_animation":
            return `• Apply native Zorex animation ${command.animation} to the replied video`;

        case "editor_queue":
            return "• Show your current Zorex Editor queue";

        case "editor_job":
            return `• Show editor job ${command.job_id}`;

        case "editor_cancel":
            return `• Cancel editor job ${command.job_id}`;

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

function makePermissionTargetMsg(
    msg,
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
            ...msg.key
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

function parseMuteDurationMs(
    value
) {
    const raw =
        String(value || "")
            .trim()
            .toLowerCase();

    if (!raw) {
        return 2 * 60 * 60 * 1000;
    }

    const match =
        raw.match(
            /^(\d+)(mins?|min|m|hrs?|hr|h|d)$/
        );

    if (!match) {
        return 2 * 60 * 60 * 1000;
    }

    const amount =
        Number(
            match[1]
        );

    const unit =
        match[2];

    if (
        unit === "d"
    ) {
        return amount *
            24 *
            60 *
            60 *
            1000;
    }

    if (
        unit.startsWith("h")
    ) {
        return amount *
            60 *
            60 *
            1000;
    }

    return amount *
        60 *
        1000;
}

function messageSenderAliases(
    msg
) {
    const key =
        msg?.key || {};

    return [
        ...new Set(
            [
                key.participant,
                key.participantAlt,
                key.senderPn,
                key.senderLid
            ]
                .filter(Boolean)
                .map(String)
        )
    ];
}

async function requesterIsGroupAdmin(
    sock,
    msg
) {
    const groupId =
        msg?.key?.remoteJid;

    if (
        !groupId?.endsWith(
            "@g.us"
        )
    ) {
        return false;
    }

    for (
        const alias of
        messageSenderAliases(
            msg
        )
    ) {
        if (
            await isGroupAdmin(
                sock,
                groupId,
                alias
            )
        ) {
            return true;
        }
    }

    return false;
}

async function executeAiCommandPlan(
    sock,
    msg,
    registeredUserId,
    commands,
    context = {}
) {
    const executionMsg =
        makeExecutionMsg(
            msg,
            registeredUserId
        );

    const results = [];

    for (const command of commands) {
        switch (command.name) {
            case "video_depth": {
                const args =
                    command.mist === "none"
                        ? ["quality"]
                        : ["mist", command.mist, "quality"];

                await depthVideoCommand(
                    sock,
                    msg,
                    args,
                    context.media?.type === "video"
                        ? context.media
                        : null
                );

                results.push({
                    name: "video_depth",
                    mist: command.mist,
                    quality: "max"
                });
                break;
            }

            case "video_upscale": {
                const args = [
                    command.scale,
                    ...(command.quality === "max" ? ["quality"] : [])
                ];

                await upscaleCommand(
                    sock,
                    msg,
                    args,
                    context.media?.type === "video"
                        ? context.media
                        : null
                );

                results.push({
                    name: "video_upscale",
                    scale: command.scale,
                    quality: command.quality
                });
                break;
            }

            case "video_edit_animation": {
                await editCommand(
                    sock,
                    msg,
                    ".edit " +
                        command.animation,
                    context.media?.type === "video"
                        ? context.media
                        : null
                );

                results.push({
                    name: "video_edit_animation",
                    animation:
                        command.animation
                });
                break;
            }

            case "editor_queue": {
                await editorCommand(
                    sock,
                    msg,
                    ".queue"
                );

                results.push({
                    name: "editor_queue"
                });
                break;
            }

            case "editor_job": {
                await editorCommand(
                    sock,
                    msg,
                    `.queue ${command.job_id}`
                );

                results.push({
                    name: "editor_job",
                    job_id: command.job_id
                });
                break;
            }

            case "editor_cancel": {
                await editorCommand(
                    sock,
                    msg,
                    `.queue cancel ${command.job_id}`
                );

                results.push({
                    name: "editor_cancel",
                    job_id: command.job_id
                });
                break;
            }

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

            case "shop_buy": {
                if (!command.purchase) {
                    await sock.sendMessage(
                        msg.key.remoteJid,
                        {
                            text:
                                `❌ I couldn't find "${command.item}" in the current Zorex shop.`
                        },
                        {
                            quoted:
                                msg
                        }
                    );

                    results.push({
                        name:
                            "shop_buy",
                        completed:
                            false,
                        reason:
                            "item-not-found"
                    });

                    break;
                }

                const current =
                    resolveShopPurchaseSnapshot(
                        command
                    );

                if (
                    !sameShopSnapshot(
                        command.purchase,
                        current
                    )
                ) {
                    await sock.sendMessage(
                        msg.key.remoteJid,
                        {
                            text:
`⚠️ *Shop purchase changed*

The item's price or purchase details changed after Zorex prepared the request.

> Nothing was purchased. Please ask again so I can use the current shop details.`
                        },
                        {
                            quoted:
                                msg
                        }
                    );

                    results.push({
                        name:
                            "shop_buy",
                        completed:
                            false,
                        reason:
                            "shop-changed"
                    });

                    break;
                }

                await shopCommands(
                    sock,
                    executionMsg,
                    `.shop buy ${current.itemId} ${current.quantity}`
                );

                results.push({
                    name:
                        "shop_buy",
                    completed:
                        true,
                    itemId:
                        current.itemId,
                    quantity:
                        current.quantity,
                    totalPrice:
                        current.totalPrice
                });

                break;
            }

            case "cshop_buy": {
                if (!command.purchase) {
                    await sock.sendMessage(
                        msg.key.remoteJid,
                        {
                            text:
                                `❌ CShop slot ${command.slot} is not available right now.`
                        },
                        {
                            quoted:
                                msg
                        }
                    );

                    results.push({
                        name:
                            "cshop_buy",
                        completed:
                            false,
                        reason:
                            "slot-unavailable"
                    });

                    break;
                }

                const current =
                    resolveCshopPurchaseSnapshot(
                        command
                    );

                if (
                    !sameCshopSnapshot(
                        command.purchase,
                        current
                    )
                ) {
                    await sock.sendMessage(
                        msg.key.remoteJid,
                        {
                            text:
`⚠️ *CShop changed before purchase*

The slot no longer contains the same card at the same price.

> Nothing was purchased. Run the request again to see the current slot.`
                        },
                        {
                            quoted:
                                msg
                        }
                    );

                    results.push({
                        name:
                            "cshop_buy",
                        completed:
                            false,
                        reason:
                            "rotation-changed"
                    });

                    break;
                }

                await cshopCommands(
                    sock,
                    executionMsg,
                    `.cshop buy ${current.slot}`
                );

                results.push({
                    name:
                        "cshop_buy",
                    completed:
                        true,
                    slot:
                        current.slot,
                    cardId:
                        current.cardId,
                    price:
                        current.price
                });

                break;
            }

            case "set_welcome":
                await setWelcomeCommand(
                    sock,
                    msg,
                    `.setwelcome ${command.message}`
                );
                results.push({
                    name:
                        "set_welcome"
                });
                break;

            case "set_leave":
                await setLeaveCommand(
                    sock,
                    msg,
                    `.setleave ${command.message}`
                );
                results.push({
                    name:
                        "set_leave"
                });
                break;

            case "group_open":
                await openGroup(
                    sock,
                    msg
                );
                results.push({
                    name:
                        "group_open"
                });
                break;

            case "group_close":
                await closeGroup(
                    sock,
                    msg
                );
                results.push({
                    name:
                        "group_close"
                });
                break;

            case "add_owner": {
                if (!command.target) {
                    await sock.sendMessage(
                        msg.key.remoteJid,
                        {
                            text:
`⚠️ *Add owner needs a target*

> Mention the person or reply to one of their messages, then ask Zorex AI to add them as owner.`
                        },
                        {
                            quoted:
                                msg
                        }
                    );

                    results.push({
                        name:
                            "add_owner",
                        completed:
                            false,
                        reason:
                            "missing-target"
                    });

                    break;
                }

                const targetMsg =
                    makePermissionTargetMsg(
                        msg,
                        command.target
                    );

                await startOwner(
                    sock,
                    targetMsg,
                    ".addowner"
                );

                results.push({
                    name:
                        "add_owner",
                    target:
                        command.target
                });

                break;
            }

            case "promote_user": {
                if (!command.target) {
                    await sock.sendMessage(
                        msg.key.remoteJid,
                        {
                            text:
`⚠️ *Promote needs a target*

> Mention the person or reply to one of their messages.`
                        },
                        {
                            quoted:
                                msg
                        }
                    );

                    results.push({
                        name:
                            "promote_user",
                        completed:
                            false,
                        reason:
                            "missing-target"
                    });

                    break;
                }

                const targetMsg =
                    makePermissionTargetMsg(
                        msg,
                        command.target
                    );

                await groupCommands(
                    sock,
                    targetMsg,
                    ".promote"
                );

                results.push({
                    name:
                        "promote_user",
                    target:
                        command.target
                });

                break;
            }

            case "demote_user": {
                if (!command.target) {
                    await sock.sendMessage(
                        msg.key.remoteJid,
                        {
                            text:
`⚠️ *Demote needs a target*

> Mention the person or reply to one of their messages.`
                        },
                        {
                            quoted:
                                msg
                        }
                    );

                    results.push({
                        name:
                            "demote_user",
                        completed:
                            false,
                        reason:
                            "missing-target"
                    });

                    break;
                }

                const targetMsg =
                    makePermissionTargetMsg(
                        msg,
                        command.target
                    );

                await groupCommands(
                    sock,
                    targetMsg,
                    ".demote"
                );

                results.push({
                    name:
                        "demote_user",
                    target:
                        command.target
                });

                break;
            }

            case "mute_user": {
                if (!command.target) {
                    await sock.sendMessage(
                        msg.key.remoteJid,
                        {
                            text:
`⚠️ *Mute needs a target*

> Mention the person or reply to one of their messages.`
                        },
                        {
                            quoted:
                                msg
                        }
                    );

                    results.push({
                        name:
                            "mute_user",
                        completed:
                            false,
                        reason:
                            "missing-target"
                    });

                    break;
                }

                const targetMsg =
                    makePermissionTargetMsg(
                        msg,
                        command.target
                    );

                const adminAllowed =
                    await requesterIsGroupAdmin(
                        sock,
                        msg
                    );

                const durationText =
                    command.duration
                        ? ` ${command.duration}`
                        : "";

                await groupCommands(
                    sock,
                    targetMsg,
                    `.mute @user${durationText}`
                );

                if (
                    adminAllowed &&
                    command.kick_if_spam
                ) {
                    const expiresAt =
                        Date.now() +
                        parseMuteDurationMs(
                            command.duration
                        );

                    armSpamKickRule(
                        msg.key.remoteJid,
                        command.target,
                        msg.key.participant ||
                            msg.key.remoteJid,
                        expiresAt,
                        command.spam_limit,
                        command.spam_window_seconds *
                            1000
                    );

                    await sock.sendMessage(
                        msg.key.remoteJid,
                        {
                            text:
`🛡️ Spam escalation armed for @${command.target.split("@")[0]}.

> If they send ${command.spam_limit} messages within ${command.spam_window_seconds}s while muted, Zorex will kick them.`,
                            mentions:
                                [command.target]
                        },
                        {
                            quoted:
                                msg
                        }
                    );
                }

                results.push({
                    name:
                        "mute_user",
                    target:
                        command.target,
                    kickIfSpam:
                        Boolean(
                            adminAllowed &&
                            command.kick_if_spam
                        )
                });

                break;
            }

            case "unmute_user": {
                if (!command.target) {
                    await sock.sendMessage(
                        msg.key.remoteJid,
                        {
                            text:
                                "⚠️ Mention or reply to the user you want to unmute."
                        },
                        {
                            quoted:
                                msg
                        }
                    );

                    results.push({
                        name:
                            "unmute_user",
                        completed:
                            false,
                        reason:
                            "missing-target"
                    });

                    break;
                }

                const targetMsg =
                    makePermissionTargetMsg(
                        msg,
                        command.target
                    );

                const adminAllowed =
                    await requesterIsGroupAdmin(
                        sock,
                        msg
                    );

                await groupCommands(
                    sock,
                    targetMsg,
                    ".unmute @user"
                );

                if (adminAllowed) {
                    clearSpamKickRule(
                        msg.key.remoteJid,
                        command.target
                    );
                }

                results.push({
                    name:
                        "unmute_user",
                    target:
                        command.target
                });

                break;
            }

            case "kick_user": {
                if (!command.target) {
                    await sock.sendMessage(
                        msg.key.remoteJid,
                        {
                            text:
                                "⚠️ Mention or reply to the user you want to kick."
                        },
                        {
                            quoted:
                                msg
                        }
                    );

                    results.push({
                        name:
                            "kick_user",
                        completed:
                            false,
                        reason:
                            "missing-target"
                    });

                    break;
                }

                const targetMsg =
                    makePermissionTargetMsg(
                        msg,
                        command.target
                    );

                const adminAllowed =
                    await requesterIsGroupAdmin(
                        sock,
                        msg
                    );

                await groupCommands(
                    sock,
                    targetMsg,
                    ".kick @user"
                );

                if (adminAllowed) {
                    clearSpamKickRule(
                        msg.key.remoteJid,
                        command.target
                    );
                }

                results.push({
                    name:
                        "kick_user",
                    target:
                        command.target
                });

                break;
            }

            case "mute_all":
                await groupCommands(
                    sock,
                    msg,
                    ".mute all"
                );
                results.push({
                    name:
                        "mute_all"
                });
                break;

            case "unmute_all":
                await groupCommands(
                    sock,
                    msg,
                    ".unmute all"
                );
                results.push({
                    name:
                        "unmute_all"
                });
                break;

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
