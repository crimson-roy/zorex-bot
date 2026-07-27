/*
    tradeEscrow.js

    Escrow Manager for the Zorex Bot trading system.

    Implements:
      - §6  Item Adapter Layer (getOwnedQuantity / removeQuantity / addQuantity)
      - §4.3 Role assignment (bundled into the deposit functions so the
              role write and the escrow write happen in one atomic
              session mutation)
      - §4.4 / §4.5 Deposit logic
      - §4.7 / §8.6 Automatic completion (atomic, ordered writes)
      - §4.8 / §9.2 Cancel + timeout-return logic (shared implementation,
              since both "return whatever is deposited" per §4.8)
      - §8.4 Live re-validation of ownership/balance at call time

    INTEGRATION NOTE (see design spec §0, §12.13):
    economy.js does not currently export loadUsers/saveUsers, so this
    module maintains its own reader/writer pointed at the same
    "./users.json" file, using the identical schema convention
    (users[jid].wallet). If economy.js is later updated to export
    loadUsers/saveUsers, swap the two local functions below for a
    `require("../economy")` import so there is a single source of
    truth for wallet I/O.

    INTEGRATION NOTE 2:
    This module requires the existing item store module (the one
    exposing loadCollection/loadInventory/saveCollection/saveInventory/
    addItem/removeItem) from commands/inventory.js — this file lives
    at lib/tradeEscrow.js, so the path goes up one level to root, then
    into commands/.
*/

const fs = require("fs");

const itemStore = require("../commands/inventory");

const USERS_FILE = "./users.json";

// ---------- Local wallet I/O (see integration note above) ----------

function loadUsersForTrade() {

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

function saveUsersForTrade(users) {

    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify(users, null, 4)
    );

}

// ---------- Small id generator (mirrors tradeState.js's randomToken) ----------

function randomToken(length) {

    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";

    let out = "";

    for (let i = 0; i < length; i++) {

        out += chars.charAt(Math.floor(Math.random() * chars.length));

    }

    return out;

}

function generateItemInstanceId() {

    return `itm_${Date.now()}_${randomToken(6)}`;

}

// ---------- §6 Item Adapter Layer ----------

function matchesIdentifier(item, itemIdentifier) {

    const needle = String(itemIdentifier).toLowerCase();

    const nameField = (item.name || item.itemId || "").toLowerCase();

    return nameField === needle;

}

/*
    Returns the combined { collectionItems, inventoryItems } arrays
    for a user that match itemIdentifier (case-insensitive against
    `name` or `itemId`, whichever the live item objects use).
*/
function findMatchingItems(userId, itemIdentifier) {

    const collection = itemStore.loadCollection();
    const inventory = itemStore.loadInventory();

    const collectionItems = (collection[userId] || []).filter(
        it => matchesIdentifier(it, itemIdentifier)
    );

    const inventoryItems = (inventory[userId] || []).filter(
        it => matchesIdentifier(it, itemIdentifier)
    );

    return { collection, inventory, collectionItems, inventoryItems };

}

/*
    §6 — getOwnedQuantity(userId, itemIdentifier)
    Sums matching items across both files. Stackable items (those
    carrying a `quantity` field) contribute their quantity; one-
    object-per-unit items contribute 1 each.
*/
function getOwnedQuantity(userId, itemIdentifier) {

    const { collectionItems, inventoryItems } = findMatchingItems(userId, itemIdentifier);

    const sum = (items) => items.reduce(
        (total, it) => total + (typeof it.quantity === "number" ? it.quantity : 1),
        0
    );

    return sum(collectionItems) + sum(inventoryItems);

}

/*
    §6 — removeQuantity(userId, itemIdentifier, amount)

    Removes `amount` units from whichever file(s) hold matching
    items, preferring to drain collection matches before inventory
    matches only in the sense that we walk collection first — in
    practice an item name should only ever live in one of the two
    files for a given user, since routing is by item.type.

    Returns a normalized escrow record:
        { itemIdentifier, type, amount, sample, depositedBy, depositedAt }
    or null if the live owned quantity was insufficient (defensive —
    the caller is expected to have already checked via
    getOwnedQuantity/validateSufficientQuantity immediately before
    calling this, per §8.4).
*/
function removeQuantity(userId, itemIdentifier, amount, depositedBy) {

    const { collection, inventory, collectionItems, inventoryItems } =
        findMatchingItems(userId, itemIdentifier);

    const allMatches = [
        ...collectionItems.map(it => ({ item: it, source: "collection" })),
        ...inventoryItems.map(it => ({ item: it, source: "inventory" }))
    ];

    const totalOwned = allMatches.reduce(
        (total, m) => total + (typeof m.item.quantity === "number" ? m.item.quantity : 1),
        0
    );

    if (totalOwned < amount) {

        return null;

    }

    let remaining = amount;
    let sample = null;
    let resolvedType = null;

    const collectionUserItems = collection[userId] || [];
    const inventoryUserItems = inventory[userId] || [];

    for (const match of allMatches) {

        if (remaining <= 0) break;

        if (!sample) {

            sample = { ...match.item };
            resolvedType = match.item.type;

        }

        const list = match.source === "collection" ? collectionUserItems : inventoryUserItems;
        const index = list.findIndex(it => it.id === match.item.id);

        if (index === -1) continue;

        if (typeof list[index].quantity === "number") {

            if (list[index].quantity > remaining) {

                list[index].quantity -= remaining;
                remaining = 0;

            } else {

                remaining -= list[index].quantity;
                list.splice(index, 1);

            }

        } else {

            list.splice(index, 1);
            remaining -= 1;

        }

    }

    collection[userId] = collectionUserItems;
    inventory[userId] = inventoryUserItems;

    itemStore.saveCollection(collection);
    itemStore.saveInventory(inventory);

    return {
        itemIdentifier: String(itemIdentifier).toLowerCase(),
        type: resolvedType,
        amount,
        sample,
        depositedBy,
        depositedAt: Date.now()
    };

}

/*
    §6 — addQuantity(userId, escrowItemRecord)

    Inverse of removeQuantity: either increments an existing stack
    for this user matching itemIdentifier/type, or (re)creates
    entries from escrowItemRecord.sample. Routes to collection.json
    if sample.type === "card", otherwise inventory.json — matching
    the existing addItem() routing rule.
*/
function addQuantity(userId, escrowItemRecord) {

    const { itemIdentifier, amount, sample } = escrowItemRecord;

    const isCard = sample && sample.type === "card";

    const store = isCard ? itemStore.loadCollection() : itemStore.loadInventory();

    if (!store[userId]) store[userId] = [];

    const existingStack = store[userId].find(
        it => matchesIdentifier(it, itemIdentifier) && typeof it.quantity === "number"
    );

    if (existingStack) {

        existingStack.quantity += amount;

    } else if (sample && typeof sample.quantity === "number") {

        // Stackable item type but no existing stack for this user yet.
        store[userId].push({
            ...sample,
            id: generateItemInstanceId(),
            quantity: amount
        });

    } else {

        // Non-stackable: recreate `amount` individual unit objects.
        for (let i = 0; i < amount; i++) {

            store[userId].push({
                ...(sample || {}),
                id: generateItemInstanceId()
            });

        }

    }

    if (isCard) {

        itemStore.saveCollection(store);

    } else {

        itemStore.saveInventory(store);

    }

}

// ---------- Wallet helpers used by escrow ----------

function debitWallet(userId, amount) {

    const users = loadUsersForTrade();

    if (!users[userId] || users[userId].wallet < amount) {

        return false;

    }

    users[userId].wallet -= amount;

    saveUsersForTrade(users);

    return true;

}

function creditWallet(userId, amount) {

    const users = loadUsersForTrade();

    if (!users[userId]) return false;

    users[userId].wallet += amount;

    saveUsersForTrade(users);

    return true;

}

function getWalletBalance(userId) {

    const users = loadUsersForTrade();

    return users[userId] ? users[userId].wallet : 0;

}

// ---------- §4.4 Deposit item into escrow (atomic per §8.2) ----------

/*
    Attempts to move `amount` of `itemIdentifier` from sellerId's
    inventory into the session's escrow, and assigns the seller role
    in the same session write.

    Ordering (per header note on write ordering risk):
      1. Remove the item from the seller's inventory/collection file
         (this is the "irreversible" half — done first so that if the
         session write fails afterward, we can attempt to roll back
         by re-adding the item, rather than silently deleting an item
         we never actually escrowed).
      2. Write the session with escrow.item populated.
      3. If step 2 throws, attempt to roll back step 1 by calling
         addQuantity with the same record, and log loudly either way.

    Returns { ok: true, session } or { ok: false, reason } where
    reason is one of "session_missing" | "write_failed".
*/
function depositItemIntoEscrow(tradeState, tradeId, sellerId, itemIdentifier, amount) {

    const escrowRecord = removeQuantity(sellerId, itemIdentifier, amount, sellerId);

    if (!escrowRecord) {

        return { ok: false, reason: "insufficient" };

    }

    let mutatedSession;

    try {

        mutatedSession = tradeState.mutateSession(tradeId, (session) => {

            session.escrow.item = escrowRecord;

            if (!session.seller) {

                session.seller = sellerId;

            }

            session.lastActivityAt = Date.now();
            session.expiresAt = session.lastActivityAt + 300000;

        });

    } catch (err) {

        console.error("[TRADE] Failed writing activeTrades.json after item deposit, rolling back inventory:", err);

        addQuantity(sellerId, escrowRecord);

        return { ok: false, reason: "write_failed" };

    }

    if (!mutatedSession) {

        // Session vanished between validation and write (e.g. timed
        // out or completed by a concurrent tick) — roll back.
        console.error("[TRADE] Session disappeared during item deposit, rolling back inventory.");

        addQuantity(sellerId, escrowRecord);

        return { ok: false, reason: "session_missing" };

    }

    return { ok: true, session: mutatedSession };

}

// ---------- §4.5 Deposit money into escrow (atomic per §8.2) ----------

function depositMoneyIntoEscrow(tradeState, tradeId, buyerId, amount) {

    const debited = debitWallet(buyerId, amount);

    if (!debited) {

        return { ok: false, reason: "insufficient" };

    }

    const escrowRecord = {
        amount,
        depositedBy: buyerId,
        depositedAt: Date.now()
    };

    let mutatedSession;

    try {

        mutatedSession = tradeState.mutateSession(tradeId, (session) => {

            session.escrow.money = escrowRecord;

            if (!session.buyer) {

                session.buyer = buyerId;

            }

            session.lastActivityAt = Date.now();
            session.expiresAt = session.lastActivityAt + 300000;

        });

    } catch (err) {

        console.error("[TRADE] Failed writing activeTrades.json after money deposit, rolling back wallet:", err);

        creditWallet(buyerId, amount);

        return { ok: false, reason: "write_failed" };

    }

    if (!mutatedSession) {

        console.error("[TRADE] Session disappeared during money deposit, rolling back wallet.");

        creditWallet(buyerId, amount);

        return { ok: false, reason: "session_missing" };

    }

    return { ok: true, session: mutatedSession };

}

// ---------- §4.7 / §8.6 Automatic completion ----------

/*
    Only ever call this once both escrow.item and escrow.money are
    confirmed non-null on a freshly-read session. Ordering per §8.6:
      1. Credit seller's wallet (users.json)
      2. Credit buyer's item (collection/inventory json)
      3. Delete the session entry (activeTrades.json)

    If a crash happens between steps, the worst case is assets
    already correctly delivered with a stale session entry left
    behind — safe direction, cleaned up by isDoubleDepositedStale()
    below on the next sweep or lookup.
*/
function completeTrade(tradeState, session) {

    creditWallet(session.seller, session.escrow.money.amount);

    addQuantity(session.buyer, session.escrow.item);

    tradeState.removeSessionById(session.tradeId);

    return {
        seller: session.seller,
        buyer: session.buyer,
        moneyAmount: session.escrow.money.amount,
        itemIdentifier: session.escrow.item.itemIdentifier,
        itemAmount: session.escrow.item.amount
    };

}

/*
    §8.6 / §12.16 — a session found with BOTH escrow fields non-null
    should already have been completed by the deposit handler that
    filled the second slot. If one is ever encountered in this state
    by the cancel handler or the timeout sweeper (e.g. after a crash
    between completeTrade()'s writes), it must NOT be re-transferred
    — only deleted.
*/
function isFullyEscrowedStale(session) {

    return Boolean(session.escrow.item) && Boolean(session.escrow.money);

}

// ---------- §4.8 / §9.2 Cancel / timeout-return (shared logic) ----------

/*
    Returns whatever is currently in escrow to its original
    depositor(s) and deletes the session. Safe to call on a session
    with nothing deposited (pure no-op deletion), one side deposited
    (single refund/return), or defensively on a fully-escrowed stale
    session (deletes only, per isFullyEscrowedStale above).

    Returns a summary object describing what happened so trade.js
    can pick the right message:
        { kind: "already_completed" }
        { kind: "nothing" }
        { kind: "item_returned", to, itemLabel, amount }
        { kind: "money_returned", to, amount }
        { kind: "both_returned", itemTo, itemLabel, itemAmount, moneyTo, moneyAmount }
*/
function releaseEscrowAndDeleteSession(tradeState, session) {

    if (isFullyEscrowedStale(session)) {

        console.error(
            `[TRADE] Session ${session.tradeId} found fully-escrowed during cancel/timeout — deleting without re-transfer (already completed).`
        );

        tradeState.removeSessionById(session.tradeId);

        return { kind: "already_completed" };

    }

    const hasItem = Boolean(session.escrow.item);
    const hasMoney = Boolean(session.escrow.money);

    if (hasItem) {

        addQuantity(session.escrow.item.depositedBy, session.escrow.item);

    }

    if (hasMoney) {

        creditWallet(session.escrow.money.depositedBy, session.escrow.money.amount);

    }

    tradeState.removeSessionById(session.tradeId);

    if (hasItem && hasMoney) {

        // Should be unreachable given isFullyEscrowedStale() above,
        // kept only as an exhaustive fallback.
        return {
            kind: "both_returned",
            itemTo: session.escrow.item.depositedBy,
            itemLabel: session.escrow.item.itemIdentifier,
            itemAmount: session.escrow.item.amount,
            moneyTo: session.escrow.money.depositedBy,
            moneyAmount: session.escrow.money.amount
        };

    }

    if (hasItem) {

        return {
            kind: "item_returned",
            to: session.escrow.item.depositedBy,
            itemLabel: session.escrow.item.itemIdentifier,
            amount: session.escrow.item.amount
        };

    }

    if (hasMoney) {

        return {
            kind: "money_returned",
            to: session.escrow.money.depositedBy,
            amount: session.escrow.money.amount
        };

    }

    return { kind: "nothing" };

}

module.exports = {
    getOwnedQuantity,
    removeQuantity,
    addQuantity,
    debitWallet,
    creditWallet,
    getWalletBalance,
    depositItemIntoEscrow,
    depositMoneyIntoEscrow,
    completeTrade,
    isFullyEscrowedStale,
    releaseEscrowAndDeleteSession
};
