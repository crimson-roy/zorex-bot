const fs = require("fs");
const { checkCooldown, setCooldown } = require("./cooldown");

const USERS_FILE = "./users.json";
const BJ_FILE = "./blackjack.json";

const COOLDOWN_MS = 30000;

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 4));
}

function loadGames() {
    if (!fs.existsSync(BJ_FILE)) fs.writeFileSync(BJ_FILE, "{}");
    return JSON.parse(fs.readFileSync(BJ_FILE, "utf8"));
}

function saveGames(games) {
    fs.writeFileSync(BJ_FILE, JSON.stringify(games, null, 4));
}


// ---------- Deck helpers ----------

const SUITS = ["♠️", "♥️", "♦️", "♣️"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function newDeck() {

    const deck = [];

    for (const suit of SUITS) {
        for (const rank of RANKS) {
            deck.push({ rank, suit });
        }
    }

    // Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    return deck;

}

function cardValue(card) {

    if (card.rank === "A") return 11;
    if (["J", "Q", "K"].includes(card.rank)) return 10;

    return Number(card.rank);

}

// Returns total, downgrading Aces from 11 to 1 as needed to avoid busting
function handValue(hand) {

    let total = 0;
    let aces = 0;

    for (const card of hand) {

        total += cardValue(card);

        if (card.rank === "A") aces++;

    }

    while (total > 21 && aces > 0) {
        total -= 10;
        aces--;
    }

    return total;

}

function formatHand(hand) {
    return hand.map(c => `${c.rank}${c.suit}`).join(" ");
}


// ---------- Display builders — match the requested Zorex format ----------

// In-progress hand
function inProgressText(game) {

    const playerVal = handValue(game.playerHand);

    return `🃏 *ZOREX BLACKJACK*
Dealer: ${formatHand([game.dealerHand[0]])} ?
You: ${formatHand(game.playerHand)} (${playerVal})
💡 .hit | .stand | .double`;

}

// Game over — resultHeader is a short line like "🤝 Tie!" or "🎉 You win!"
function gameOverText(game, resultHeader) {

    const playerVal = handValue(game.playerHand);
    const dealerVal = handValue(game.dealerHand);

    return `${resultHeader}
🃏 *ZOREX BLACKJACK*
Dealer: ${formatHand(game.dealerHand)} (${dealerVal})
You: ${formatHand(game.playerHand)} (${playerVal})
🏁 Game Over`;

}


// ---------- .bj <amount> / .bj all ----------
async function blackjackCommand(sock, msg, text) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const users = loadUsers();

    if (!users[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have a Zorex profile.\n\nUse:\n.register YOUR_NAME`
        }, { quoted: msg });
    }

    const games = loadGames();

    if (games[sender]) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You already have a Blackjack game in progress.\n\nUse .hit, .stand, or .double to continue.`
        }, { quoted: msg });
    }

    const remaining = checkCooldown(sender, "bj", COOLDOWN_MS);

    if (remaining) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⏳ Slow down! Try again in ${Math.ceil(remaining / 1000)}s.`
        }, { quoted: msg });
    }

    const input = text.replace(".bj", "").trim();

    let bet;

    if (input.toLowerCase() === "all") {
        bet = users[sender].wallet;
    } else {
        bet = Number(input.replace(/,/g, ""));
    }

    if (!bet || isNaN(bet) || bet <= 0) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `🃏 Zorex Blackjack\n\nUsage:\n\n.bj 5000\n.bj all`
        }, { quoted: msg });
    }

    if (bet > users[sender].wallet) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have that much in your wallet.\n\nWallet: ${users[sender].wallet.toLocaleString()} 🌙`
        }, { quoted: msg });
    }

    // Take the bet upfront
    users[sender].wallet -= bet;
    saveUsers(users);

    setCooldown(sender, "bj");

    const deck = newDeck();

    const playerHand = [deck.pop(), deck.pop()];
    const dealerHand = [deck.pop(), deck.pop()];

    const game = {
        deck,
        playerHand,
        dealerHand,
        bet,
        canDouble: true,
        startedAt: Date.now()
    };

    // Check for natural blackjacks right away
    const playerBJ = handValue(playerHand) === 21;
    const dealerBJ = handValue(dealerHand) === 21;

    if (playerBJ || dealerBJ) {

        let header;
        let payout = 0;

        if (playerBJ && dealerBJ) {
            header = `🤝 Push! Both have Blackjack.`;
            payout = bet;
        } else if (playerBJ) {
            payout = Math.floor(bet * 2.5); // 3:2 payout, includes original bet
            header = `🎉 Blackjack! You win 3:2!`;
        } else {
            header = `💀 Dealer Blackjack! You lose.`;
            payout = 0;
        }

        if (payout > 0) {
            users[sender].wallet += payout;
            saveUsers(users);
        }

        return await sock.sendMessage(msg.key.remoteJid, {
            text: gameOverText(game, header)
        }, { quoted: msg });

    }

    games[sender] = game;
    saveGames(games);

    return await sock.sendMessage(msg.key.remoteJid, {
        text: inProgressText(game)
    }, { quoted: msg });

}


// ---------- .hit ----------
async function hitCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const games = loadGames();
    const game = games[sender];

    if (!game) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You don't have an active Blackjack game.\n\nUse .bj <amount> to start one.`
        }, { quoted: msg });
    }

    game.playerHand.push(game.deck.pop());
    game.canDouble = false; // can only double on your first decision

    const playerVal = handValue(game.playerHand);

    if (playerVal > 21) {

        delete games[sender];
        saveGames(games);

        return await sock.sendMessage(msg.key.remoteJid, {
            text: gameOverText(game, `💀 Bust! You lose.`)
        }, { quoted: msg });

    }

    if (playerVal === 21) {
        return await standCommand(sock, msg); // auto-stand on exactly 21
    }

    saveGames(games);

    return await sock.sendMessage(msg.key.remoteJid, {
        text: inProgressText(game)
    }, { quoted: msg });

}


// ---------- .stand ----------
async function standCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const games = loadGames();
    const game = games[sender];

    if (!game) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You don't have an active Blackjack game.\n\nUse .bj <amount> to start one.`
        }, { quoted: msg });
    }

    // Dealer draws until 17+
    while (handValue(game.dealerHand) < 17) {
        game.dealerHand.push(game.deck.pop());
    }

    const playerVal = handValue(game.playerHand);
    const dealerVal = handValue(game.dealerHand);

    const users = loadUsers();

    let header;
    let payout = 0;

    if (dealerVal > 21) {
        payout = game.bet * 2;
        header = `🎉 Dealer busts! You win!`;
    } else if (playerVal > dealerVal) {
        payout = game.bet * 2;
        header = `🎉 You win!`;
    } else if (playerVal === dealerVal) {
        payout = game.bet;
        header = `🤝 Tie!`;
    } else {
        header = `💀 You lose.`;
    }

    if (payout > 0) {
        users[sender].wallet += payout;
        saveUsers(users);
    }

    delete games[sender];
    saveGames(games);

    return await sock.sendMessage(msg.key.remoteJid, {
        text: gameOverText(game, header)
    }, { quoted: msg });

}


// ---------- .double ----------
async function doubleCommand(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;
    const games = loadGames();
    const game = games[sender];

    if (!game) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You don't have an active Blackjack game.\n\nUse .bj <amount> to start one.`
        }, { quoted: msg });
    }

    if (!game.canDouble) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You can only double on your first move.`
        }, { quoted: msg });
    }

    const users = loadUsers();

    if (game.bet > users[sender].wallet) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ You don't have enough to double your bet.\n\nWallet: ${users[sender].wallet.toLocaleString()} 🌙`
        }, { quoted: msg });
    }

    // Take the extra matching bet
    users[sender].wallet -= game.bet;
    game.bet *= 2;
    saveUsers(users);

    // Draw exactly one card, then forced stand
    game.playerHand.push(game.deck.pop());
    game.canDouble = false;

    const playerVal = handValue(game.playerHand);

    if (playerVal > 21) {

        delete games[sender];
        saveGames(games);

        return await sock.sendMessage(msg.key.remoteJid, {
            text: gameOverText(game, `💀 Bust! You lose.`)
        }, { quoted: msg });

    }

    saveGames(games);

    return await standCommand(sock, msg);

}


module.exports = {
    blackjackCommand,
    hitCommand,
    standCommand,
    doubleCommand
};