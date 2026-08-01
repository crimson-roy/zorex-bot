const fs = require("fs");
const dataPath = require("../lib/dataPath");

// PERSISTENCE FIX: shop.js, invest.js, and card.js all depend on this
// module for their reads/writes to these two files — if either stayed on
// a bare relative path, purchases and card claims would silently vanish
// on every redeploy even though the files calling this module looked
// fixed. See lib/dataPath.js.
const COLLECTION_FILE = dataPath("collection.json");
const INVENTORY_FILE = dataPath("inventory.json");

function loadCollection() {
    if (!fs.existsSync(COLLECTION_FILE)) fs.writeFileSync(COLLECTION_FILE, "{}");
    return JSON.parse(fs.readFileSync(COLLECTION_FILE, "utf8"));
}

function loadInventory() {
    if (!fs.existsSync(INVENTORY_FILE)) fs.writeFileSync(INVENTORY_FILE, "{}");
    return JSON.parse(fs.readFileSync(INVENTORY_FILE, "utf8"));
}

function saveCollection(data) {
    fs.writeFileSync(COLLECTION_FILE, JSON.stringify(data, null, 4));
}

function saveInventory(data) {
    fs.writeFileSync(INVENTORY_FILE, JSON.stringify(data, null, 4));
}

// Routes an item to the right file based on its type.
// Cards -> collection.json. Everything else (collectible, mystery, etc.) -> inventory.json.
function addItem(userId, item) {

    if (item.type === "card") {

        const collection = loadCollection();
        if (!collection[userId]) collection[userId] = [];
        collection[userId].push(item);
        saveCollection(collection);
        return "collection";

    } else {

        const inventory = loadInventory();
        if (!inventory[userId]) inventory[userId] = [];
        inventory[userId].push(item);
        saveInventory(inventory);
        return "inventory";

    }

}

// Removes a single item by id from whichever file it's in (used for trading/using/selling items)
function removeItem(userId, itemId) {

    const collection = loadCollection();
    const inventory = loadInventory();

    const collectionItems = collection[userId] || [];
    const collectionIndex = collectionItems.findIndex(it => it.id === itemId);

    if (collectionIndex !== -1) {
        const [removed] = collectionItems.splice(collectionIndex, 1);
        collection[userId] = collectionItems;
        saveCollection(collection);
        return removed;
    }

    const inventoryItems = inventory[userId] || [];
    const inventoryIndex = inventoryItems.findIndex(it => it.id === itemId);

    if (inventoryIndex !== -1) {
        const [removed] = inventoryItems.splice(inventoryIndex, 1);
        inventory[userId] = inventoryItems;
        saveInventory(inventory);
        return removed;
    }

    return null;

}

module.exports = {
    loadCollection,
    loadInventory,
    saveCollection,
    saveInventory,
    addItem,
    removeItem
};