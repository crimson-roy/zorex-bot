/*
    tradeMessages.js

    Message Builder for the Zorex Bot trading system.

    Every function here returns either a plain string, or an object
    shaped { text, mentions } when the message needs to @-tag a user
    (mirrors how economy.js sends `mentions: [sender, target]` on
    donate/addcrescent messages).

    Visual style intentionally mirrors the existing boxes in
    economy.js (╭━━━━, ▪️▪️▪️, ¤¤¤¤¤¤) so trade messages don't look
    like they came from a different bot.
*/

function tag(jid) {

    return `@${jid.split("@")[0]}`;

}

// ---------- Generic boxed error (mirrors economy.js's errorBox) ----------

function errorBox(title, message, examples) {

    if (!examples || examples.length === 0) {

        return `╭━━━━ ⚠️ ${title} ━━━━╮
   ${message}
╰━━━━━━━━━━━━━━━━━━━━━━━╯`;

    }

    const exampleLines = examples
        .map(e => `  📥 ${e}`)
        .join("\n");

    return `╭━━━━ ⚠️ ${title} ━━━━╮
   ${message}
  ─── 📝 𝖤𝖷𝖠𝖬𝖯𝖫𝖤 ───
${exampleLines}
╰━━━━━━━━━━━━━━━━━━━━━━━╯`;

}

// ---------- §11 Error Message Catalog ----------

function notRegistered() {

    // Trade re-uses the existing notRegisteredMessage() from
    // economy.js at the call site — this is only a fallback in case
    // trade.js is ever used without that import available.
    return `╭━━━━ ⚠️ 𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗔𝗧𝗜𝗢𝗡 ━━━━╮
👤 Please register your account. ✨
────── 📝 𝗙𝗢𝗥𝗠𝗔𝗧 ──────
⌨️ .register YOUR_NAME
────── 💡 𝗘𝗫𝗔𝗠𝗣𝗟𝗘 ──────
🔥 .register Crimson Roy
╰━━━━━━━━━━━━━━━━━━━━━━━╯`;

}

function mentionExactlyOne() {

    return errorBox(
        "𝗧𝗥𝗔𝗗𝗘",
        "Mention exactly one user to trade with.",
        [".trade @user"]
    );

}

function cannotTradeSelf() {

    return "😂 You can't trade with yourself.";

}

function targetNotRegistered() {

    return "⚠️ That user does not have a Zorex profile.";

}

function cannotTradeBot() {

    return "🤖 You can't trade with a bot.";

}

function senderAlreadyTrading() {

    return "⚠️ You're already in another trade. Finish or cancel it first with `.tradecancel`.";

}

function targetAlreadyTrading() {

    return "⚠️ That user is already trading with someone else right now.";

}

function noPendingRequest() {

    return "❌ No trade request found for you.";

}

function onlyRecipientCanRespond() {

    return "⚠️ Only the recipient can respond to this trade request.";

}

function requestExpiredForActor() {

    return "⌛ That trade request has expired.";

}

function noActiveTrade() {

    return "❌ No active trade found. Start one with `.trade @user`.";

}

function sellerRoleTaken() {

    return "⚠️ This trade already has a seller. Use `.tradepay` if you're buying.";

}

function buyerRoleTaken() {

    return "⚠️ This trade already has a buyer. Use `.tradesell` if you're selling.";

}

function dontOwnItem() {

    return "❌ You don't own that item.";

}

function insufficientQuantity(owned) {

    return `❌ Insufficient quantity — you only have ${owned}.`;

}

function alreadyDepositedItem() {

    return "⚠️ You've already deposited an item for this trade.";

}

function alreadyDepositedMoney() {

    return "⚠️ You've already deposited payment for this trade.";

}

function invalidSellAmount() {

    return errorBox(
        "𝗧𝗥𝗔𝗗𝗘 𝗦𝗘𝗟𝗟",
        "Enter a valid item and amount.",
        [".tradesell fish 10"]
    );

}

function invalidPayAmount() {

    return errorBox(
        "𝗧𝗥𝗔𝗗𝗘 𝗣𝗔𝗬",
        "Enter a valid amount.",
        [".tradepay 5000"]
    );

}

function insufficientBalance(wallet) {

    return `❌ Insufficient balance — you have ${wallet.toLocaleString()} 🌙.`;

}

function alreadyCompletedDefensive() {

    return "⚠️ This trade already completed and can no longer be cancelled.";

}

function genericWriteFailure() {

    return "❌ Something went wrong — your trade state was not changed. Please try again.";

}

function fakeItem() {

    return "❌ That item doesn't exist.";

}

// ---------- §4 Flow / status messages ----------

function tradeRequested(initiatorJid, recipientJid) {

    return {
        text:
`🔄 ${tag(initiatorJid)} has requested to trade with ${tag(recipientJid)}.

You have 60 seconds to respond.

Use:
.tradeaccept
.tradedecline`,
        mentions: [initiatorJid, recipientJid]
    };

}

function requestExpiredNotice(initiatorJid, recipientJid) {

    return {
        text: `⌛ Trade request between ${tag(initiatorJid)} and ${tag(recipientJid)} expired.`,
        mentions: [initiatorJid, recipientJid]
    };

}

function tradeAccepted(userA, userB) {

    return {
        text:
`🤝 ${tag(userA)} and ${tag(userB)} have entered a trade.

Available commands:
.tradesell <item_id> <amount>
.tradepay <amount>
.tradecancel
.tradeinfo`,
        mentions: [userA, userB]
    };

}

function tradeDeclined() {

    return "❌ Trade declined.";

}

function tradeRequestCancelled() {

    return "❌ Trade request cancelled.";

}

function itemDeposited(sellerJid, itemLabel, amount) {

    return {
        text:
`📦 ${tag(sellerJid)} deposited:
${itemLabel} ×${amount}

Waiting for buyer payment.`,
        mentions: [sellerJid]
    };

}

function paymentDeposited(amount) {

    return `💰 Payment deposited: ${amount.toLocaleString()} 🌙\n\nWaiting for seller item.`;

}

function tradeComplete(sellerJid, buyerJid, moneyAmount, itemLabel, itemAmount) {

    return {
        text:
`✅ Trade Complete!

Seller received: ${moneyAmount.toLocaleString()} 🌙
Buyer received: ${itemLabel} ×${itemAmount}

Powered by Zorex AI 🤖`,
        mentions: [sellerJid, buyerJid]
    };

}

function cancelledNothingDeposited() {

    return "❌ Trade cancelled. Nothing was deposited.";

}

function cancelledItemReturned(sellerJid, itemLabel, amount) {

    return {
        text: `❌ Trade cancelled. ${itemLabel} ×${amount} returned to ${tag(sellerJid)}.`,
        mentions: [sellerJid]
    };

}

function cancelledMoneyReturned(buyerJid, amount) {

    return {
        text: `❌ Trade cancelled. ${amount.toLocaleString()} 🌙 refunded to ${tag(buyerJid)}.`,
        mentions: [buyerJid]
    };

}

function sessionTimedOut(userA, userB) {

    return {
        text:
`⌛ Trade between ${tag(userA)} and ${tag(userB)} timed out due to inactivity.

Any deposited items or money have been returned.`,
        mentions: [userA, userB]
    };

}

function noTradeOrRequest() {

    return "You have no active trade or trade request.";

}

function formatDuration(ms) {

    if (ms <= 0) return "0s";

    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes <= 0) return `${seconds}s`;

    return `${minutes}m ${seconds}s`;

}

function tradeInfoRequest(request) {

    const remaining = formatDuration(request.expiresAt - Date.now());

    return {
        text:
`📋 𝗧𝗥𝗔𝗗𝗘 𝗥𝗘𝗤𝗨𝗘𝗦𝗧
▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️
Initiator: ${tag(request.initiator)}
Recipient: ${tag(request.recipient)}
Time remaining: ${remaining}
Status: pending
▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️`,
        mentions: [request.initiator, request.recipient]
    };

}

function tradeInfoSession(session) {

    const remaining = formatDuration(session.expiresAt - Date.now());

    const [userA, userB] = session.participants;

    const itemLine = session.escrow.item
        ? `${session.escrow.item.itemIdentifier} ×${session.escrow.item.amount}`
        : "— none yet";

    const moneyLine = session.escrow.money
        ? `${session.escrow.money.amount.toLocaleString()} 🌙`
        : "— none yet";

    return {
        text:
`📋 𝗧𝗥𝗔𝗗𝗘 𝗦𝗧𝗔𝗧𝗨𝗦
▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️
Participants: ${tag(userA)}, ${tag(userB)}
Seller: ${session.seller ? tag(session.seller) : "unassigned"}
Buyer: ${session.buyer ? tag(session.buyer) : "unassigned"}
Item deposited: ${itemLine}
Money deposited: ${moneyLine}
Time remaining: ${remaining}
Status: active
▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️`,
        mentions: [userA, userB]
    };

}

module.exports = {
    tag,
    errorBox,
    notRegistered,
    mentionExactlyOne,
    cannotTradeSelf,
    targetNotRegistered,
    cannotTradeBot,
    senderAlreadyTrading,
    targetAlreadyTrading,
    noPendingRequest,
    onlyRecipientCanRespond,
    requestExpiredForActor,
    noActiveTrade,
    sellerRoleTaken,
    buyerRoleTaken,
    dontOwnItem,
    insufficientQuantity,
    alreadyDepositedItem,
    alreadyDepositedMoney,
    invalidSellAmount,
    invalidPayAmount,
    insufficientBalance,
    alreadyCompletedDefensive,
    genericWriteFailure,
    fakeItem,
    tradeRequested,
    requestExpiredNotice,
    tradeAccepted,
    tradeDeclined,
    tradeRequestCancelled,
    itemDeposited,
    paymentDeposited,
    tradeComplete,
    cancelledNothingDeposited,
    cancelledItemReturned,
    cancelledMoneyReturned,
    sessionTimedOut,
    noTradeOrRequest,
    tradeInfoRequest,
    tradeInfoSession,
    formatDuration
};
