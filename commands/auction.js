const fs = require("fs");

const AUCTION_ITEMS_FILE = "./auctionitem.json";
const AUCTION_FILE = "./auction.json";
const SHOP_FILE = "./shop.json";
const CARD_FILE = "./card.json";
const USERS_FILE = "./users.json";
const OWNERS_FILE = "./owners.json";
const COLLECTION_FILE = "./collection.json";
const INVENTORY_FILE = "./inventory.json";

const { resetUserCooldown } = require("./cooldown");
const { resetUserDailyLimit } = require("./dailylimit");
const { findOwners, sendCardDisplay } = require("./card");

const DEFAULT_STARTING_BID = 100000;
const AUCTION_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const WIN_BANK_BONUS = 2000000;            // every auction win adds this, on top of the item's own effect

function loadJSON(file, fallback) {

    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(fallback, null, 4));
    }

    return JSON.parse(fs.readFileSync(file, "utf8"));

}

function saveJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 4));
}

function loadAuctionItems() { return loadJSON(AUCTION_ITEMS_FILE, {}); }
function saveAuctionItems(data) { saveJSON(AUCTION_ITEMS_FILE, data); }

function loadAuction() { return loadJSON(AUCTION_FILE, { active: false }); }
function saveAuction(data) { saveJSON(AUCTION_FILE, data); }

function loadShop() { return loadJSON(SHOP_FILE, {}); }
function loadCards() { return loadJSON(CARD_FILE, {}); }

function loadUsers() { return loadJSON(USERS_FILE, {}); }
function saveUsers(data) { saveJSON(USERS_FILE, data); }

function loadCollection() { return loadJSON(COLLECTION_FILE, {}); }
function saveCollection(data) { saveJSON(COLLECTION_FILE, data); }

function loadInventory() { return loadJSON(INVENTORY_FILE, {}); }
function saveInventory(data) { saveJSON(INVENTORY_FILE, data); }

function loadOwners() { return loadJSON(OWNERS_FILE, ["2348036391250@s.whatsapp.net"]); }
function isOwner(userId) { return loadOwners().includes(userId); }

let auctionTimer = null; // in-memory handle for the single global auction timer


// ---------- .importauction <item_ID> ----------
// Pulls from shop.json OR card.json (whichever has the ID) — never copies price.
async function importAuctionItem(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;

    if (!isOwner(sender)) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have permission to use this command.`
        }, { quoted: msg });
    }

    const args = text.replace(".importauction", "").trim().split(" ").filter(Boolean);
    const itemId = args[0];

    if (!itemId) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Usage:\n\n.importauction <item_ID>\n\nExample:\n.importauction 500k`
        }, { quoted: msg });
    }

    const auctionItems = loadAuctionItems();

    if (auctionItems[itemId]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ This item is already present in the auction pool.`
        }, { quoted: msg });
    }

    const shop = loadShop();
    const cards = loadCards();

    const source = shop[itemId] || cards[itemId];

    if (!source) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ That item doesn't exist in the shop or the card catalog.`
        }, { quoted: msg });
    }

    // Copy only name + effect fields — never price
    const imported = {
        name: source.name,
        type: source.type
    };

    if (source.type === "bank" && source.capacity) {
        imported.capacity = source.capacity;
    }

    if (source.image) {
        imported.image = source.image;
    }

    // Cards use an animated video instead of a static image
    if (source.video) {
        imported.video = source.video;
    }

    auctionItems[itemId] = imported;
    saveAuctionItems(auctionItems);

    return await sock.sendMessage(msg.key.remoteJid, {
        text: `✅ Imported into auction pool!\n\n🎁 Item:\n${imported.name}\n\n🆔 ID:\n${itemId}`
    }, { quoted: msg });

}


// ---------- .auctionstart <item_ID> <startingBid> ----------
async function startAuction(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;

    if (!isOwner(sender)) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have permission to use this command.`
        }, { quoted: msg });
    }

    const auction = loadAuction();

    if (auction.active) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ An auction is already running.\n\nWait for it to end before starting a new one.`
        }, { quoted: msg });
    }

    const args = text.replace(".auctionstart", "").trim().split(" ").filter(Boolean);
    const itemId = args[0];
    let startingBid = Number(args[1]);

    if (!itemId) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Usage:\n\n.auctionstart <item_ID> <startingBid>\n\nExample:\n.auctionstart card001 200000\n\n(startingBid is optional — defaults to ${DEFAULT_STARTING_BID.toLocaleString()})`
        }, { quoted: msg });
    }

    if (!startingBid || isNaN(startingBid) || startingBid <= 0) {
        startingBid = DEFAULT_STARTING_BID;
    }

    const auctionItems = loadAuctionItems();
    const item = auctionItems[itemId];

    if (!item) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ That item hasn't been imported into the auction pool yet.\n\nUse:\n.importauction <item_ID>`
        }, { quoted: msg });
    }

    const startedAt = Date.now();
    const endsAt = startedAt + AUCTION_DURATION_MS;

    const newAuction = {
        active: true,
        itemId,
        item,
        startingBid,
        currentBid: startingBid,
        highestBidder: null,
        startedBy: sender,
        startedInGroup: msg.key.remoteJid,
        startedAt,
        endsAt
    };

    saveAuction(newAuction);

    const caption =
`🔨 *ZOREX AUCTION STARTED!*

🎁 Item:
${item.name}

💰 Starting Bid:
${startingBid.toLocaleString()} 🌙

⏳ Time Limit:
5 minutes

Bid with:

.auctionbid <amount>

(You can bid from any group — highest bid wins!)`;

    if (item.video && fs.existsSync(item.video)) {

        await sock.sendMessage(msg.key.remoteJid, {
            video: fs.readFileSync(item.video),
            caption,
            gifPlayback: true
        }, { quoted: msg });

    } else if (item.image && fs.existsSync(item.image)) {

        await sock.sendMessage(msg.key.remoteJid, {
            image: fs.readFileSync(item.image),
            caption
        }, { quoted: msg });

    } else {

        await sock.sendMessage(msg.key.remoteJid, {
            text: `${caption}\n\n🆔 Item ID: ${itemId}`
        }, { quoted: msg });

    }

    if (auctionTimer) clearTimeout(auctionTimer);

    auctionTimer = setTimeout(async () => {
        await endAuction(sock);
    }, AUCTION_DURATION_MS);

}


// ---------- .auctionbid <amount> ----------
async function placeBid(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;

    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have a Zorex profile.\n\nUse:\n.register YOUR_NAME`
        }, { quoted: msg });
    }

    const auction = loadAuction();

    if (!auction.active) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ There is no active auction right now.`
        }, { quoted: msg });
    }

    const args = text.replace(".auctionbid", "").trim();
    const amount = Number(args);

    if (!amount || isNaN(amount) || amount <= 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Usage:\n\n.auctionbid <amount>\n\nExample:\n.auctionbid 250000`
        }, { quoted: msg });
    }

    if (amount <= auction.currentBid) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ Your bid must be higher than the current bid.\n\n💰 Current Bid:\n${auction.currentBid.toLocaleString()} 🌙`
        }, { quoted: msg });
    }

    if (amount > users[sender].wallet) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have that much in your wallet.\n\n💳 Wallet:\n${users[sender].wallet.toLocaleString()} 🌙`
        }, { quoted: msg });
    }

    auction.currentBid = amount;
    auction.highestBidder = sender;

    saveAuction(auction);

    return await sock.sendMessage(msg.key.remoteJid, {
        text: `🔨 New Highest Bid!\n\n👤 @${sender.split("@")[0]}\n💰 ${amount.toLocaleString()} 🌙\n\n🎁 Item:\n${auction.item.name}`,
        mentions: [sender]
    }, { quoted: msg });

}


// ---------- Fires automatically when the 5-minute timer runs out ----------
async function endAuction(sock) {

    const auction = loadAuction();

    if (!auction.active) return;

    const groupId = auction.startedInGroup;

    if (!auction.highestBidder) {

        saveAuction({ active: false });

        return await sock.sendMessage(groupId, {
            text: `⏰ *Auction time expired!*\n\n🎁 Item:\n${auction.item.name}\n\n❌ No bids were placed — auction cancelled.`
        });

    }

    const winner = auction.highestBidder;
    const winningBid = auction.currentBid;
    const item = auction.item;

    const users = loadUsers();

    if (!users[winner]) {

        saveAuction({ active: false });

        return await sock.sendMessage(groupId, {
            text: `⚠️ Auction ended but the winning bidder's profile could not be found.`
        });

    }

    // Deduct from wallet only — can go negative, bank is never touched
    users[winner].wallet -= winningBid;

    // Every auction win adds a flat bank bonus, on top of anything the item itself does
    users[winner].bankLimit = (users[winner].bankLimit || 100000) + WIN_BANK_BONUS;

    if (item.type === "bank" && item.capacity) {

        users[winner].bankLimit += item.capacity;

    } else if (item.type === "card") {

        // Cards go into the collection
        const collection = loadCollection();

        if (!collection[winner]) collection[winner] = [];

        collection[winner].push({
            id: auction.itemId,
            name: item.name,
            type: item.type,
            image: item.image || null,
            video: item.video || null,
            obtainedFrom: "auction",
            obtainedAt: Date.now()
        });

        saveCollection(collection);

    } else {

        // Everything else (charms, mystery boxes, tools, etc.) goes into the inventory
        const inventory = loadInventory();

        if (!inventory[winner]) inventory[winner] = [];

        inventory[winner].push({
            id: auction.itemId,
            name: item.name,
            type: item.type,
            image: item.image || null,
            video: item.video || null,
            obtainedFrom: "auction",
            obtainedAt: Date.now()
        });

        saveInventory(inventory);

    }

    saveUsers(users);

    // Cooldowns + daily limits reset silently — never mentioned in the win message
    resetUserCooldown(winner);
    resetUserDailyLimit(winner);

    saveAuction({ active: false });

    const caption =
`⏰ *AUCTION TIME EXPIRED*

🔨 *AUCTION ENDED*

🏆 Winner:
@${winner.split("@")[0]}

🎁 Item ${item.name} has been applied to their profile.`;

    if (item.video && fs.existsSync(item.video)) {

        await sock.sendMessage(groupId, {
            video: fs.readFileSync(item.video),
            caption,
            gifPlayback: true,
            mentions: [winner]
        });

    } else if (item.image && fs.existsSync(item.image)) {

        await sock.sendMessage(groupId, {
            image: fs.readFileSync(item.image),
            caption,
            mentions: [winner]
        });

    } else {

        await sock.sendMessage(groupId, {
            text: `${caption}\n\n🆔 Item ID: ${auction.itemId}`,
            mentions: [winner]
        });

    }

}


// ---------- .col — view your collection, or .col <number> for full detail ----------
async function viewCollection(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;

    const collection = loadCollection();
    const items = collection[sender] || [];

    if (items.length === 0) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `📦 Your collection is empty.`
        }, { quoted: msg });

    }

    const args = text.replace(".col", "").trim();

    // .col <number> — show full detail for that specific item
    if (args) {

        const index = Number(args) - 1;

        if (isNaN(index) || index < 0 || index >= items.length) {

            return await sock.sendMessage(msg.key.remoteJid, {
                text: `⚠️ Invalid item number.\n\nUse:\n.col\n\nto see your collection list first.`
            }, { quoted: msg });

        }

        const item = items[index];

        if (item.type === "card") {

            const cards = loadCards();
            const cardData = cards[item.id];

            if (!cardData) {

                return await sock.sendMessage(msg.key.remoteJid, {
                    text: `⚠️ This card's catalog entry could not be found — it may have been removed from card.json.`
                }, { quoted: msg });

            }

            const owners = findOwners(item.id, collection);

            return await sendCardDisplay(sock, msg, item.id, cardData, owners);

        }

        // Non-card items — plain detail view
        return await sock.sendMessage(msg.key.remoteJid, {
            text:
`📦 *Item Detail*

🎁 ${item.name}
🏷️ Type: ${item.type}
🆔 ID: ${item.id}
📅 Obtained: ${new Date(item.obtainedAt).toLocaleString()}`
        }, { quoted: msg });

    }

    // .col — plain list
    const list = items
        .map((it, i) => `${i + 1}. ${it.name} (${it.type})`)
        .join("\n");

    return await sock.sendMessage(msg.key.remoteJid, {
        text: `📦 *YOUR COLLECTION*\n\n${list}\n\nType .col <number> to view a specific item.`
    }, { quoted: msg });

}


// ---------- .inv — view your inventory, or .inv <number> for full detail ----------
async function viewInventory(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;

    const inventory = loadInventory();
    const items = inventory[sender] || [];

    if (items.length === 0) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `🎒 Your inventory is empty.`
        }, { quoted: msg });

    }

    const args = text.replace(".inv", "").trim();

    // .inv <number> — show full detail for that specific item
    if (args) {

        const index = Number(args) - 1;

        if (isNaN(index) || index < 0 || index >= items.length) {

            return await sock.sendMessage(msg.key.remoteJid, {
                text: `⚠️ Invalid item number.\n\nUse:\n.inv\n\nto see your inventory list first.`
            }, { quoted: msg });

        }

        const item = items[index];

        const detailText =
`🎒 *Item Detail*

🎁 ${item.name}
🏷️ Type: ${item.type}${item.quantity ? `\n📦 Quantity: ${item.quantity}` : ""}
🆔 ID: ${item.id}
📅 Obtained: ${new Date(item.obtainedAt).toLocaleString()}`;

        if (item.image && fs.existsSync(item.image)) {

            return await sock.sendMessage(msg.key.remoteJid, {
                image: fs.readFileSync(item.image),
                caption: detailText
            }, { quoted: msg });

        }

        if (item.video && fs.existsSync(item.video)) {

            return await sock.sendMessage(msg.key.remoteJid, {
                video: fs.readFileSync(item.video),
                caption: detailText,
                gifPlayback: true
            }, { quoted: msg });

        }

        return await sock.sendMessage(msg.key.remoteJid, {
            text: detailText
        }, { quoted: msg });

    }

    // .inv — plain list
    const list = items
        .map((it, i) => `${i + 1}. ${it.name}${it.quantity ? ` (x${it.quantity})` : ""}`)
        .join("\n");

    return await sock.sendMessage(msg.key.remoteJid, {
        text: `🎒 *YOUR INVENTORY*\n\n${list}\n\nType .inv <number> to view a specific item.`
    }, { quoted: msg });

}


// ---------- .use lucky_charm ----------
// Consumes one Lucky Charm and starts a 60-second window during which the
// user's next .casino play is a guaranteed win (100%). Checks inventory.json
// first (where non-card items now live post-split), falls back to
// collection.json for any charm obtained before the split. If the window
// expires unused, the charm is silently returned by gamble.js — no message
// is sent for that.
async function useLuckyCharm(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;

    const args = text.replace(".use", "").trim().toLowerCase();

    if (args !== "lucky_charm") {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Usage:\n\n.use lucky_charm`
        }, { quoted: msg });
    }

    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have a Zorex profile.`
        }, { quoted: msg });
    }

    const inventory = loadInventory();
    const invItems = inventory[sender] || [];
    const invIndex = invItems.findIndex(it => it.id === "luckycharm");

    if (invIndex !== -1) {

        invItems.splice(invIndex, 1);
        inventory[sender] = invItems;
        saveInventory(inventory);

    } else {

        // Fallback for charms obtained before the collection/inventory split
        const collection = loadCollection();
        const colItems = collection[sender] || [];
        const colIndex = colItems.findIndex(it => it.id === "luckycharm");

        if (colIndex === -1) {
            return await sock.sendMessage(msg.key.remoteJid, {
                text: `❌ You don't have a Lucky Charm.`
            }, { quoted: msg });
        }

        colItems.splice(colIndex, 1);
        collection[sender] = colItems;
        saveCollection(collection);

    }

    // Start the 60-second guaranteed-win window
    users[sender].luckyCharmActive = { expiresAt: Date.now() + 60 * 1000 };
    saveUsers(users);

    return await sock.sendMessage(msg.key.remoteJid, {
        text: `🍀 *Lucky Charm Activated!*\n\nYour next .casino play within 60 seconds is a guaranteed win.`
    }, { quoted: msg });

}


// ---------- .auctionend — manually force-end the current auction early ----------
// Only owners can use this. Clears the pending 5-minute timer and immediately
// runs the same endAuction() logic that would've fired automatically.
async function forceEndAuction(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;

    if (!isOwner(sender)) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have permission to use this command.`
        }, { quoted: msg });
    }

    const auction = loadAuction();

    if (!auction.active) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ There is no active auction to end.`
        }, { quoted: msg });
    }

    if (auctionTimer) {
        clearTimeout(auctionTimer);
        auctionTimer = null;
    }

    await endAuction(sock);

}


module.exports = {
    importAuctionItem,
    startAuction,
    placeBid,
    endAuction,
    forceEndAuction,
    viewCollection,
    viewInventory,
    useLuckyCharm
};