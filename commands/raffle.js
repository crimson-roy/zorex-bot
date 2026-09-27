'use strict';

const crypto = require('crypto');
const fs = require('fs');

const dataPath = require('../lib/dataPath');
const { loadInventory, saveInventory, loadCollection, saveCollection } = require('./inventory');
const { getRandomCardByTier } = require('../lib/spawnManager');

const USERS_FILE = dataPath('users.json');
const RAFFLES_FILE = dataPath('raffles.json');

const TICKET_ID = 'raffle_ticket';
const MAX_PLAYERS = 5;
const RAFFLE_DURATION_MS = 24 * 60 * 60 * 1000;

let sweeper = null;
let currentSock = null;

function loadJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, JSON.stringify(fallback, null, 4));
            return fallback;
        }

        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        return value ?? fallback;
    } catch (err) {
        console.error('[raffle] Failed reading', file, err);
        return fallback;
    }
}

function saveJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 4), 'utf8');
}

function loadUsers() {
    return loadJson(USERS_FILE, {});
}

function saveUsers(users) {
    saveJson(USERS_FILE, users);
}

function loadRaffles() {
    return loadJson(RAFFLES_FILE, {});
}

function saveRaffles(raffles) {
    saveJson(RAFFLES_FILE, raffles);
}

function displayTag(jid) {
    return '@' + String(jid || '').split('@')[0].split(':')[0];
}

function refundStarterTicket(raffle) {
    const inventory = loadInventory();
    if (!inventory[raffle.starter]) inventory[raffle.starter] = [];

    inventory[raffle.starter].push(
        raffle.ticket || {
            id: TICKET_ID,
            name: 'Raffle Ticket',
            type: 'collectible',
            obtainedFrom: 'raffle_refund',
            obtainedAt: Date.now()
        }
    );

    saveInventory(inventory);
}

async function expireRaffle(sock, groupId, raffle, raffles) {
    refundStarterTicket(raffle);
    delete raffles[groupId];
    saveRaffles(raffles);

    try {
        await sock.sendMessage(groupId, {
            text: `⌛ The raffle expired before reaching 5 players. ${displayTag(raffle.starter)} got the ticket back.`,
            mentions: [raffle.starter]
        });
    } catch (err) {
        console.error('[raffle] Expiry message failed:', err.message);
    }
}

async function clearExpiredForGroup(sock, groupId) {
    const raffles = loadRaffles();
    const raffle = raffles[groupId];

    if (!raffle) return null;

    if (Date.now() < Number(raffle.expiresAt || 0)) {
        return raffle;
    }

    await expireRaffle(sock, groupId, raffle, raffles);
    return null;
}

async function sweepExpired(sock) {
    if (!sock) return;

    const raffles = loadRaffles();
    const now = Date.now();

    for (const [groupId, raffle] of Object.entries(raffles)) {
        if (now >= Number(raffle.expiresAt || 0)) {
            await expireRaffle(sock, groupId, raffle, raffles);
        }
    }
}

function startRaffleSweeper(sock) {
    currentSock = sock;

    if (sweeper) return;

    sweepExpired(currentSock).catch(err => {
        console.error('[raffle] Initial expiry sweep failed:', err);
    });

    sweeper = setInterval(() => {
        sweepExpired(currentSock).catch(err => {
            console.error('[raffle] Expiry sweep failed:', err);
        });
    }, 60 * 1000);

    if (typeof sweeper.unref === 'function') sweeper.unref();
}

async function awardWinner(sock, msg, groupId, raffle) {
    const winner = raffle.participants[crypto.randomInt(0, raffle.participants.length)];
    let rewardType = crypto.randomInt(0, 2) === 0 ? 'cash' : 'card';

    const raffles = loadRaffles();

    if (rewardType === 'card') {
        const picked = getRandomCardByTier('C', false);

        // card.json should always have default C-rank cards, but if it ever
        // doesn't, fall back to the cash reward instead of killing the raffle.
        if (picked) {
            const [cardId, card] = picked;
            const collection = loadCollection();

            if (!collection[winner]) collection[winner] = [];

            collection[winner].push({
                id: cardId,
                name: card.name,
                type: card.type || 'card',
                tier: card.tier,
                series: card.series,
                image: card.image || null,
                video: card.video || null,
                obtainedFrom: 'raffle',
                obtainedAt: Date.now()
            });

            saveCollection(collection);
            delete raffles[groupId];
            saveRaffles(raffles);

            return await sock.sendMessage(
                groupId,
                {
                    text:
`🎉 *RAFFLE WINNER*

${displayTag(winner)} won the raffle!
🃏 ${card.name} [C]
🆔 #${cardId}`,
                    mentions: [winner]
                },
                { quoted: msg }
            );
        }

        rewardType = 'cash';
    }

    if (rewardType === 'cash') {
        const users = loadUsers();
        const amount = crypto.randomInt(5000000, 10000001);

        if (!users[winner]) {
            throw new Error('Selected raffle winner no longer has a registered profile.');
        }

        users[winner].wallet = Number(users[winner].wallet || 0) + amount;
        saveUsers(users);

        delete raffles[groupId];
        saveRaffles(raffles);

        return await sock.sendMessage(
            groupId,
            {
                text:
`🎉 *RAFFLE WINNER*

${displayTag(winner)} won the raffle!
💰 Prize: ${amount.toLocaleString()} Crescents 🌙`,
                mentions: [winner]
            },
            { quoted: msg }
        );
    }
}

async function startRaffle(sock, msg) {
    const groupId = msg.key.remoteJid;
    const starter = msg.key.participant || groupId;

    if (!groupId?.endsWith('@g.us')) {
        return sock.sendMessage(groupId, { text: '❌ Raffles can only be started in groups.' }, { quoted: msg });
    }

    const users = loadUsers();
    if (!users[starter]) {
        return sock.sendMessage(groupId, { text: '❌ Register first with *.register*.' }, { quoted: msg });
    }

    const active = await clearExpiredForGroup(sock, groupId);
    if (active) {
        return sock.sendMessage(
            groupId,
            { text: `🎟️ A raffle is already open. Players: ${active.participants.length}/${MAX_PLAYERS}\nUse *.raffle join*.` },
            { quoted: msg }
        );
    }

    const inventory = loadInventory();
    const items = inventory[starter] || [];
    const ticketIndex = items.findIndex(item => item.id === TICKET_ID);

    if (ticketIndex === -1) {
        return sock.sendMessage(
            groupId,
            { text: '🎟️ You need a Raffle Ticket. Buy one with *.shop buy raffle_ticket*.' },
            { quoted: msg }
        );
    }

    const [ticket] = items.splice(ticketIndex, 1);
    inventory[starter] = items;
    saveInventory(inventory);

    const now = Date.now();
    const raffles = loadRaffles();

    raffles[groupId] = {
        starter,
        participants: [starter],
        ticket,
        startedAt: now,
        expiresAt: now + RAFFLE_DURATION_MS
    };

    saveRaffles(raffles);

    return sock.sendMessage(
        groupId,
        {
            text:
`🎟️ *RAFFLE STARTED*
${displayTag(starter)} started a raffle!
👥 1/5
Use *.raffle join* to participate.`,
            mentions: [starter]
        },
        { quoted: msg }
    );
}

async function joinRaffle(sock, msg) {
    const groupId = msg.key.remoteJid;
    const sender = msg.key.participant || groupId;

    if (!groupId?.endsWith('@g.us')) {
        return sock.sendMessage(groupId, { text: '❌ Raffles only work in groups.' }, { quoted: msg });
    }

    const users = loadUsers();
    if (!users[sender]) {
        return sock.sendMessage(groupId, { text: '❌ Register first with *.register*.' }, { quoted: msg });
    }

    const active = await clearExpiredForGroup(sock, groupId);
    if (!active) {
        return sock.sendMessage(groupId, { text: '⚠️ There is no open raffle. Use *.raffle start*.' }, { quoted: msg });
    }

    if (active.participants.includes(sender)) {
        return sock.sendMessage(groupId, { text: '⚠️ You are already in this raffle.' }, { quoted: msg });
    }

    if (active.participants.length >= MAX_PLAYERS) {
        return sock.sendMessage(groupId, { text: '⚠️ This raffle is already full.' }, { quoted: msg });
    }

    active.participants.push(sender);

    const raffles = loadRaffles();
    raffles[groupId] = active;
    saveRaffles(raffles);

    if (active.participants.length < MAX_PLAYERS) {
        return sock.sendMessage(
            groupId,
            {
                text: `🎟️ ${displayTag(sender)} joined the raffle! 👥 ${active.participants.length}/${MAX_PLAYERS}`,
                mentions: [sender]
            },
            { quoted: msg }
        );
    }

    await sock.sendMessage(
        groupId,
        {
            text: '🎟️ *RAFFLE FULL*\n🎲 Drawing the winner...',
            mentions: active.participants
        },
        { quoted: msg }
    );

    return awardWinner(sock, msg, groupId, active);
}

async function raffleCommand(sock, msg, text) {
    const action = text.trim().split(/\s+/)[1]?.toLowerCase();

    if (action === 'start') return startRaffle(sock, msg);
    if (action === 'join') return joinRaffle(sock, msg);

    return sock.sendMessage(
        msg.key.remoteJid,
        { text: '🎟️ Usage: *.raffle start* or *.raffle join*' },
        { quoted: msg }
    );
}

module.exports = {
    raffleCommand,
    startRaffleSweeper
};
