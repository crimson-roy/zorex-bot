'use strict';

const crypto = require('crypto');
const fs = require('fs');

const dataPath = require('../lib/dataPath');
const { loadInventory, saveInventory } = require('./inventory');

const USERS_FILE = dataPath('users.json');
const TICKET_ID = 'lottery_ticket';

// Ticket price is 10,000 Crescents in shop.json.
// The table is intentionally slightly house-favoured overall.
const PRIZES = [
    { maxRoll: 5000, amount: 0,        label: 'No win' },
    { maxRoll: 8000, amount: 5000,     label: 'Small Win' },
    { maxRoll: 9200, amount: 15000,    label: 'Lucky Win' },
    { maxRoll: 9800, amount: 30000,    label: 'Big Win' },
    { maxRoll: 9980, amount: 100000,   label: 'Huge Win' },
    { maxRoll: 10000, amount: 1000000, label: 'JACKPOT' }
];

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, '{}');
    }

    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 4), 'utf8');
}

function drawPrize() {
    const roll = crypto.randomInt(1, 10001);
    return PRIZES.find(prize => roll <= prize.maxRoll) || PRIZES[PRIZES.length - 1];
}

async function lotteryCommand(sock, msg) {
    const jid = msg.key.remoteJid;
    const sender = msg.key.participant || jid;

    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(
            jid,
            { text: '❌ You do not have a Zorex profile. Use *.register* first.' },
            { quoted: msg }
        );
    }

    const inventory = loadInventory();
    const items = inventory[sender] || [];
    const ticketIndex = items.findIndex(item => item.id === TICKET_ID);

    if (ticketIndex === -1) {
        return await sock.sendMessage(
            jid,
            {
                text:
`🎟️ *NO LOTTERY TICKET*

You need a Lottery Ticket before you can play.

🛒 Buy one:
.shop buy lottery_ticket

📦 Or buy several:
.shop buy lottery_ticket 5`
            },
            { quoted: msg }
        );
    }

    // One .lottery command consumes exactly one ticket.
    items.splice(ticketIndex, 1);
    inventory[sender] = items;

    const prize = drawPrize();

    if (prize.amount > 0) {
        users[sender].wallet = Number(users[sender].wallet || 0) + prize.amount;
    }

    saveInventory(inventory);
    saveUsers(users);

    const ticketsLeft = items.filter(item => item.id === TICKET_ID).length;

    if (prize.amount === 0) {
        return await sock.sendMessage(
            jid,
            {
                text:
`🎰 *ZOREX LOTTERY*

🎟️ Ticket scratched...
💨 No win this time.

🎫 Tickets Left: ${ticketsLeft}

Try again with *.lottery* if you have another ticket.`
            },
            { quoted: msg }
        );
    }

    const jackpotLine = prize.label === 'JACKPOT'
        ? '🏆 *JACKPOT!!!* 🏆\n\n'
        : '';

    return await sock.sendMessage(
        jid,
        {
            text:
`🎰 *ZOREX LOTTERY*

${jackpotLine}✨ *${prize.label}*
🌙 You won *${prize.amount.toLocaleString()} Crescents!*

💰 Wallet: ${users[sender].wallet.toLocaleString()} 🌙
🎫 Tickets Left: ${ticketsLeft}`
        },
        { quoted: msg }
    );
}

module.exports = {
    lotteryCommand
};
