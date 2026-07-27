/*
    trade.js

    Command router for the Zorex Bot peer-to-peer trading system.
    Implements every command from design spec §3:

        .trade @user
        .tradeaccept
        .tradedecline
        .tradesell <item_id> <amount>
        .tradepay <amount>
        .tradecancel
        .tradeinfo

    Mirrors the surrounding codebase's handler shape (see
    economy.js's economyCommands(sock, msg, text)) so it can be wired
    into the same message-routing switchboard the same way.

    Wiring into the existing bot:

        const { tradeCommands } = require("./commands/trade");
        const { startTradeSweeper } = require("./lib/tradeTimeouts");

        // once, after sock connects:
        startTradeSweeper(sock);

        // in the main message handler, alongside economyCommands(...):
        await tradeCommands(sock, msg, text);
*/

const fs = require("fs");

const tradeState = require("../lib/tradeState");
const escrow = require("../lib/tradeEscrow");
const validate = require("../lib/tradeValidate");
const messages = require("../lib/tradeMessages");

const USERS_FILE = "./users.json";

// ---------- Local read-only users loader (see tradeEscrow.js integration note) ----------

function loadUsersReadOnly() {

    if (!fs.existsSync(USERS_FILE)) {

        fs.writeFileSync(USERS_FILE, "{}");

    }

    try {

        return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));

    } catch (err) {

        console.error("[TRADE-CORRUPTION] users.json contains invalid JSON:", err);

        return {};

    }

}

// ---------- Helpers ----------

function getSender(msg) {

    return msg.key.participant || msg.key.remoteJid;

}

function getMentionedJids(msg) {

    const context = msg.message?.extendedTextMessage?.contextInfo;

    return (context && context.mentionedJid) || [];

}

function reply(sock, msg, payload) {

    // payload may be a plain string, or { text, mentions }
    if (typeof payload === "string") {

        return sock.sendMessage(
            msg.key.remoteJid,
            { text: payload },
            { quoted: msg }
        );

    }

    return sock.sendMessage(
        msg.key.remoteJid,
        { text: payload.text, mentions: payload.mentions || [] },
        { quoted: msg }
    );

}

function itemLabel(itemIdentifier) {

    const capitalized = itemIdentifier.charAt(0).toUpperCase() + itemIdentifier.slice(1);

    return `📦 ${capitalized}`;

}

/*
    Runs a list of { valid, error } checks in order and returns the
    first failing one, or null if all pass. Keeps handlers readable
    and matches §4's "fail fast, return the first matching error"
    instruction.
*/
function firstFailure(results) {

    for (const result of results) {

        if (!result.valid) return result.error;

    }

    return null;

}

// ---------- .trade @user ----------

async function handleTradeStart(sock, msg, sender, args) {

    const users = loadUsersReadOnly();

    const registeredCheck = validate.validateIsRegistered(users, sender, false);

    if (!registeredCheck.valid) {

        return reply(sock, msg, registeredCheck.error);

    }

    const mentioned = getMentionedJids(msg);

    const mentionCheck = validate.validateMentionsExactlyOne(mentioned);

    if (!mentionCheck.valid) {

        return reply(sock, msg, mentionCheck.error);

    }

    const target = mentioned[0];

    const failure = firstFailure([
        validate.validateNotSelfTrade(sender, target),
        validate.validateIsRegistered(users, target, true),
        validate.validateNotBot(target, sock?.user?.id)
    ]);

    if (failure) {

        return reply(sock, msg, failure);

    }

    // Fresh busy-status reads, immediately before the write (§8.2).
    const senderStatus = tradeState.getUserTradeStatus(sender);
    const senderFreeCheck = validate.validateSenderFree(senderStatus);

    if (!senderFreeCheck.valid) {

        return reply(sock, msg, senderFreeCheck.error);

    }

    const targetStatus = tradeState.getUserTradeStatus(target);
    const targetFreeCheck = validate.validateTargetFree(targetStatus);

    if (!targetFreeCheck.valid) {

        return reply(sock, msg, targetFreeCheck.error);

    }

    const now = Date.now();

    const request = {
        requestId: tradeState.generateRequestId(),
        initiator: sender,
        recipient: target,
        chatJid: msg.key.remoteJid,
        createdAt: now,
        expiresAt: now + 60000,
        status: "pending"
    };

    tradeState.addRequest(request);

    const notice = messages.tradeRequested(sender, target);

    return reply(sock, msg, notice);

}

// ---------- .tradeaccept ----------

async function handleTradeAccept(sock, msg, sender) {

    const request = tradeState.findRequestByUser(sender);

    const failure = firstFailure([
        validate.validateRequestExists(request)
    ]);

    if (failure) {

        return reply(sock, msg, failure);

    }

    const recipientFailure = firstFailure([
        validate.validateIsRecipient(request, sender),
        validate.validateRequestNotExpired(request)
    ]);

    if (recipientFailure) {

        return reply(sock, msg, recipientFailure);

    }

    const removed = tradeState.removeRequestById(request.requestId);

    if (!removed) {

        // Someone else resolved it in the same instant (declined/expired).
        return reply(sock, msg, messages.noPendingRequest());

    }

    const now = Date.now();

    const session = {
        tradeId: tradeState.generateTradeId(),
        participants: [request.initiator, request.recipient],
        chatJid: request.chatJid,
        seller: null,
        buyer: null,
        escrow: {
            item: null,
            money: null
        },
        createdAt: now,
        lastActivityAt: now,
        expiresAt: now + 300000,
        status: "active"
    };

    tradeState.addSession(session);

    const notice = messages.tradeAccepted(request.initiator, request.recipient);

    return reply(sock, msg, notice);

}

// ---------- .tradedecline ----------

async function handleTradeDecline(sock, msg, sender) {

    const request = tradeState.findRequestByUser(sender);

    const failure = firstFailure([
        validate.validateRequestExists(request)
    ]);

    if (failure) {

        return reply(sock, msg, failure);

    }

    const recipientFailure = validate.validateIsRecipient(request, sender);

    if (!recipientFailure.valid) {

        return reply(sock, msg, recipientFailure.error);

    }

    tradeState.removeRequestById(request.requestId);

    return reply(sock, msg, messages.tradeDeclined());

}

// ---------- .tradesell <item_id> <amount> ----------

async function handleTradeSell(sock, msg, sender, args) {

    const session = tradeState.findSessionByUser(sender);

    const sessionFailure = validate.validateSessionExists(session);

    if (!sessionFailure.valid) {

        return reply(sock, msg, sessionFailure.error);

    }

    if (args.length < 2) {

        return reply(sock, msg, messages.invalidSellAmount());

    }

    const itemIdentifier = args[0].toLowerCase();
    const amountCheck = validate.validateAmountIsPositiveInteger(args[1]);

    if (!amountCheck.valid) {

        return reply(sock, msg, messages.invalidSellAmount());

    }

    const amount = amountCheck.amount;

    const roleFailure = validate.validateSellerRole(session, sender);

    if (!roleFailure.valid) {

        return reply(sock, msg, roleFailure.error);

    }

    const alreadyDepositedFailure = validate.validateNotAlreadyDepositedItem(session, sender);

    if (!alreadyDepositedFailure.valid) {

        return reply(sock, msg, alreadyDepositedFailure.error);

    }

    // Fresh ownership read immediately before the write (§8.2, §8.4).
    const owned = escrow.getOwnedQuantity(sender, itemIdentifier);

    const ownsFailure = validate.validateOwnsItem(owned);

    if (!ownsFailure.valid) {

        return reply(sock, msg, ownsFailure.error);

    }

    const quantityFailure = validate.validateSufficientQuantity(owned, amount);

    if (!quantityFailure.valid) {

        return reply(sock, msg, quantityFailure.error);

    }

    const result = escrow.depositItemIntoEscrow(tradeState, session.tradeId, sender, itemIdentifier, amount);

    if (!result.ok) {

        if (result.reason === "insufficient") {

            return reply(sock, msg, validate.validateSufficientQuantity(0, amount).error);

        }

        return reply(sock, msg, messages.genericWriteFailure());

    }

    await reply(sock, msg, messages.itemDeposited(sender, itemLabel(itemIdentifier), amount));

    return checkAndComplete(sock, msg, result.session);

}

// ---------- .tradepay <amount> ----------

async function handleTradePay(sock, msg, sender, args) {

    const session = tradeState.findSessionByUser(sender);

    const sessionFailure = validate.validateSessionExists(session);

    if (!sessionFailure.valid) {

        return reply(sock, msg, sessionFailure.error);

    }

    if (args.length < 1) {

        return reply(sock, msg, messages.invalidPayAmount());

    }

    const amountCheck = validate.validateAmountIsPositiveInteger(args[0]);

    if (!amountCheck.valid) {

        return reply(sock, msg, messages.invalidPayAmount());

    }

    const amount = amountCheck.amount;

    const roleFailure = validate.validateBuyerRole(session, sender);

    if (!roleFailure.valid) {

        return reply(sock, msg, roleFailure.error);

    }

    const alreadyDepositedFailure = validate.validateNotAlreadyDepositedMoney(session, sender);

    if (!alreadyDepositedFailure.valid) {

        return reply(sock, msg, alreadyDepositedFailure.error);

    }

    // Fresh balance read immediately before the write (§8.2, §8.4).
    const balance = escrow.getWalletBalance(sender);

    const balanceFailure = validate.validateSufficientBalance(balance, amount);

    if (!balanceFailure.valid) {

        return reply(sock, msg, balanceFailure.error);

    }

    const result = escrow.depositMoneyIntoEscrow(tradeState, session.tradeId, sender, amount);

    if (!result.ok) {

        if (result.reason === "insufficient") {

            return reply(sock, msg, messages.insufficientBalance(0));

        }

        return reply(sock, msg, messages.genericWriteFailure());

    }

    await reply(sock, msg, messages.paymentDeposited(amount));

    return checkAndComplete(sock, msg, result.session);

}

// ---------- §4.7 shared completion check, called after every deposit ----------

async function checkAndComplete(sock, msg, session) {

    if (!session.escrow.item || !session.escrow.money) {

        return;

    }

    const outcome = escrow.completeTrade(tradeState, session);

    const notice = messages.tradeComplete(
        outcome.seller,
        outcome.buyer,
        outcome.moneyAmount,
        itemLabel(outcome.itemIdentifier),
        outcome.itemAmount
    );

    return sock.sendMessage(
        msg.key.remoteJid,
        { text: notice.text, mentions: notice.mentions }
    );

}

// ---------- .tradecancel ----------

async function handleTradeCancel(sock, msg, sender) {

    const request = tradeState.findRequestByUser(sender);

    if (request) {

        tradeState.removeRequestById(request.requestId);

        return reply(sock, msg, messages.tradeRequestCancelled());

    }

    const session = tradeState.findSessionByUser(sender);

    if (!session) {

        return reply(sock, msg, messages.noActiveTrade());

    }

    const result = escrow.releaseEscrowAndDeleteSession(tradeState, session);

    switch (result.kind) {

        case "already_completed":
            return reply(sock, msg, messages.alreadyCompletedDefensive());

        case "nothing":
            return reply(sock, msg, messages.cancelledNothingDeposited());

        case "item_returned":
            return reply(sock, msg, messages.cancelledItemReturned(result.to, itemLabel(result.itemLabel), result.amount));

        case "money_returned":
            return reply(sock, msg, messages.cancelledMoneyReturned(result.to, result.amount));

        case "both_returned":
            // Defensive fallback path (§4.8) — should be unreachable
            // in normal operation since completion fires automatically
            // before both sides could ever be simultaneously cancelled.
            await reply(sock, msg, messages.cancelledItemReturned(result.itemTo, itemLabel(result.itemLabel), result.itemAmount));
            return reply(sock, msg, messages.cancelledMoneyReturned(result.moneyTo, result.moneyAmount));

        default:
            return reply(sock, msg, messages.genericWriteFailure());

    }

}

// ---------- .tradeinfo ----------

async function handleTradeInfo(sock, msg, sender) {

    const request = tradeState.findRequestByUser(sender);

    if (request) {

        return reply(sock, msg, messages.tradeInfoRequest(request));

    }

    const session = tradeState.findSessionByUser(sender);

    if (session) {

        return reply(sock, msg, messages.tradeInfoSession(session));

    }

    return reply(sock, msg, messages.noTradeOrRequest());

}

// ---------- Router ----------

async function tradeCommands(sock, msg, text) {

    if (!text || typeof text !== "string") return;

    const trimmed = text.trim();

    if (!trimmed.startsWith(".trade")) return;

    const parts = trimmed.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    const sender = getSender(msg);

    switch (command) {

        case ".trade":
            return handleTradeStart(sock, msg, sender, args);

        case ".tradeaccept":
            return handleTradeAccept(sock, msg, sender);

        case ".tradedecline":
            return handleTradeDecline(sock, msg, sender);

        case ".tradesell":
            return handleTradeSell(sock, msg, sender, args);

        case ".tradepay":
            return handleTradePay(sock, msg, sender, args);

        case ".tradecancel":
            return handleTradeCancel(sock, msg, sender);

        case ".tradeinfo":
            return handleTradeInfo(sock, msg, sender);

        default:
            // Not a recognized trade subcommand (e.g. a message that
            // merely starts with ".trade" as a prefix of something
            // else) — ignore silently, matching how unmatched
            // commands elsewhere in the bot fall through.
            return;

    }

}

module.exports = {
    tradeCommands
};
