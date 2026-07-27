/*
    tradeValidate.js

    Validation Layer for the Zorex Bot trading system.

    Every exported function is pure with respect to state: it takes
    already-loaded data (users object, session object, request
    object, owned quantity, etc.) and returns a result object of the
    shape:

        { valid: true }
        { valid: false, error: <string from tradeMessages> }

    None of these functions read or write any file themselves and
    none of them send any message — that keeps them trivially
    testable and keeps trade.js in full control of exactly when a
    "fresh read" happens relative to the eventual write, per design
    spec §8.2 (minimize awaited work between the state read used for
    validation and the write that follows it).
*/

const messages = require("./tradeMessages");

// ---------- §4.1 .trade validation ----------

function validateMentionsExactlyOne(mentionedJids) {

    if (!mentionedJids || mentionedJids.length !== 1) {

        return { valid: false, error: messages.mentionExactlyOne() };

    }

    return { valid: true };

}

function validateNotSelfTrade(senderId, targetId) {

    if (senderId === targetId) {

        return { valid: false, error: messages.cannotTradeSelf() };

    }

    return { valid: true };

}

function validateIsRegistered(users, userId, isTarget) {

    if (!users[userId]) {

        return {
            valid: false,
            error: isTarget ? messages.targetNotRegistered() : messages.notRegistered()
        };

    }

    return { valid: true };

}

function validateNotBot(targetId, botJid) {

    if (botJid && targetId === botJid) {

        return { valid: false, error: messages.cannotTradeBot() };

    }

    return { valid: true };

}

function validateSenderFree(senderStatus) {

    if (senderStatus.busy) {

        return { valid: false, error: messages.senderAlreadyTrading() };

    }

    return { valid: true };

}

function validateTargetFree(targetStatus) {

    if (targetStatus.busy) {

        return { valid: false, error: messages.targetAlreadyTrading() };

    }

    return { valid: true };

}

// ---------- §4.2 accept/decline validation ----------

function validateRequestExists(request) {

    if (!request) {

        return { valid: false, error: messages.noPendingRequest() };

    }

    return { valid: true };

}

function validateRequestNotExpired(request) {

    // Per §12.13: always re-check wall-clock time here, even if the
    // sweeper hasn't caught this entry yet.
    if (Date.now() > request.expiresAt) {

        return { valid: false, error: messages.requestExpiredForActor() };

    }

    return { valid: true };

}

function validateIsRecipient(request, senderId) {

    if (request.recipient !== senderId) {

        return { valid: false, error: messages.onlyRecipientCanRespond() };

    }

    return { valid: true };

}

// ---------- §4.4 / §4.5 session-command validation ----------

function validateSessionExists(session) {

    if (!session) {

        return { valid: false, error: messages.noActiveTrade() };

    }

    return { valid: true };

}

function validateSellerRole(session, senderId) {

    if (session.seller && session.seller !== senderId) {

        return { valid: false, error: messages.sellerRoleTaken() };

    }

    return { valid: true };

}

function validateBuyerRole(session, senderId) {

    if (session.buyer && session.buyer !== senderId) {

        return { valid: false, error: messages.buyerRoleTaken() };

    }

    return { valid: true };

}

function validateAmountIsPositiveInteger(rawValue) {

    const cleaned = String(rawValue || "").replace(/,/g, "");

    const amount = Number(cleaned);

    if (
        cleaned === "" ||
        isNaN(amount) ||
        !Number.isFinite(amount) ||
        !Number.isInteger(amount) ||
        amount <= 0
    ) {

        return { valid: false, amount: null };

    }

    return { valid: true, amount };

}

function validateNotAlreadyDepositedItem(session, senderId) {

    if (
        session.escrow.item &&
        session.escrow.item.depositedBy === senderId
    ) {

        return { valid: false, error: messages.alreadyDepositedItem() };

    }

    return { valid: true };

}

function validateNotAlreadyDepositedMoney(session, senderId) {

    if (
        session.escrow.money &&
        session.escrow.money.depositedBy === senderId
    ) {

        return { valid: false, error: messages.alreadyDepositedMoney() };

    }

    return { valid: true };

}

function validateOwnsItem(ownedQuantity) {

    if (ownedQuantity <= 0) {

        return { valid: false, error: messages.dontOwnItem() };

    }

    return { valid: true };

}

function validateSufficientQuantity(ownedQuantity, requestedAmount) {

    if (ownedQuantity < requestedAmount) {

        return { valid: false, error: messages.insufficientQuantity(ownedQuantity) };

    }

    return { valid: true };

}

function validateSufficientBalance(wallet, requestedAmount) {

    if (wallet < requestedAmount) {

        return { valid: false, error: messages.insufficientBalance(wallet) };

    }

    return { valid: true };

}

module.exports = {
    validateMentionsExactlyOne,
    validateNotSelfTrade,
    validateIsRegistered,
    validateNotBot,
    validateSenderFree,
    validateTargetFree,
    validateRequestExists,
    validateRequestNotExpired,
    validateIsRecipient,
    validateSessionExists,
    validateSellerRole,
    validateBuyerRole,
    validateAmountIsPositiveInteger,
    validateNotAlreadyDepositedItem,
    validateNotAlreadyDepositedMoney,
    validateOwnsItem,
    validateSufficientQuantity,
    validateSufficientBalance
};
