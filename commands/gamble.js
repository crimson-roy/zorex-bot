const fs = require("fs");
const { checkCooldown, setCooldown } = require("./cooldown");
const { checkDailyLimit, incrementDailyPlay } = require("./dailylimit");

const USERS_FILE = "./users.json";
const MINES_FILE = "./mines.json";
const COLLECTION_FILE = "./collection.json";
const activeMinesGames = {};

const COOLDOWN_MS = 30000; // 30 seconds

function loadMines() {

    if (!fs.existsSync(MINES_FILE)) {
        fs.writeFileSync(MINES_FILE, "{}");
    }

    return JSON.parse(
        fs.readFileSync(
            MINES_FILE,
            "utf8"
        )
    );

}

function saveMines(mines) {

    fs.writeFileSync(
        MINES_FILE,
        JSON.stringify(
            mines,
            null,
            4
        )
    );

}

function loadUsers() {

    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, "{}");
    }

    return JSON.parse(
        fs.readFileSync(USERS_FILE, "utf8")
    );

}


function saveUsers(users) {

    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify(
            users,
            null,
            4
        )
    );

}

// ---------- Lucky Charm collection helpers ----------
function loadCollection() {

    if (!fs.existsSync(COLLECTION_FILE)) {
        fs.writeFileSync(COLLECTION_FILE, "{}");
    }

    return JSON.parse(
        fs.readFileSync(COLLECTION_FILE, "utf8")
    );

}

function saveCollection(data) {

    fs.writeFileSync(
        COLLECTION_FILE,
        JSON.stringify(
            data,
            null,
            4
        )
    );

}


function creditWallet(users, userId, amount) {

    users[userId].wallet += amount;

    saveUsers(users);

}


function debitWallet(users, userId, amount) {

    users[userId].wallet -= amount;

    saveUsers(users);

}

function chance(percent) {

    return Math.random() * 100 < percent;

}

const DIVIDER = "▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️▪️";

// Shared not-registered message, same style as economy.js
function notRegisteredMessage() {
    return `╭━━━━ ⚠️ 𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗔𝗧𝗜𝗢𝗡 ━━━━╮
👤 Please register your account. ✨
────── 📝 𝗙𝗢𝗥𝗠𝗔𝗧 ──────
⌨️ .register YOUR_NAME
────── 💡 𝗘𝗫𝗔𝗠𝗣𝗟𝗘 ──────
🔥 .register Crimson Roy
╰━━━━━━━━━━━━━━━━━━━━━━━╯`;
}

async function gambleCommands(sock, msg, text) {

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;


    const users = loadUsers();

    // Lucky Charm expiry — if the 60s window passed with no .casino play,
    // silently return the charm to their collection. No message sent.
    if (
        users[sender]?.luckyCharmActive &&
        Date.now() >= users[sender].luckyCharmActive.expiresAt
    ) {

        delete users[sender].luckyCharmActive;

        const collection = loadCollection();

        if (!collection[sender]) collection[sender] = [];

        collection[sender].push({
            id: "luckycharm",
            name: "Lucky Charm",
            type: "luck",
            obtainedFrom: "auction",
            obtainedAt: Date.now()
        });

        saveCollection(collection);
        saveUsers(users);

    }

    // GAMBLING HUB
if (text === ".gamble") {

    const user =
        users[sender] || {
            wallet: 0,
            bank: 0
        };


    return await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🎰 *ZOREX GAMBLING HUB* 🎰

💰 Wallet:
${user.wallet.toLocaleString()} 🌙

🏦 Bank:
${user.bank.toLocaleString()} 🌙


🎮 *AVAILABLE GAMES*


🎰 *Casino*

.casino <amount>

- Double or nothing
- 60% win chance
- 2x payout


🪙 *Coin Flip*

.cf heads/tails <amount>

- 50/50 chance
- 1.85x payout


🎡 *Roulette*

.roulette red/black <amount>

- Predict red or black
- 50/50 chance
- 2x payout


🎲 *Dice*

.dice <number/odd/even> <amount>

- Roll two dice
- Higher risk = higher reward


🎰 *Slots*

.slots <amount>

- Match symbols to win
- 2x - 7x payouts


🃏 *Blackjack*

.bj <amount>
.bj all

- Challenge the dealer
- Get closer to 21 without busting
- Use .hit, .stand, or .double
- Beat the dealer to win


🎴 *Poker*

.poker <amount>

- Video poker with card holds
- Hold your best cards and redraw
- Royal Flush pays the biggest rewards


💣 *Mines*

.mines <amount>

- Pick safe tiles
- Avoid hidden mines
- Higher risk = higher rewards


💰 *Betting*

.bet

- Coming soon


✈️ *Aviator*

.aviator <amount>

- Crash game
- Cash out before it crashes


🌙 *Money Commands*

.bal
.dep <amount>
.wd <amount>


⏳ All games share a 30s cooldown between plays.


Powered by Zorex AI 🤖`
        },
        {
            quoted: msg
        }
    );

}


// COIN FLIP
else if (text.startsWith(".cf")) {


        if (!users[sender]) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                { text: notRegisteredMessage() },
                { quoted: msg }
            );

        }


        const cfRemaining = checkCooldown(sender, "cf", COOLDOWN_MS);

        if (cfRemaining) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`⏳ Slow down! Try again in ${Math.ceil(cfRemaining / 1000)}s.`
                },
                {
                    quoted: msg
                }
            );

        }


        const cfLimit = checkDailyLimit(sender, "cf");

        if (cfLimit) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`📅 Daily limit reached for Coin Flip.

Used: ${cfLimit.used}/${cfLimit.limit}

Come back tomorrow!`
                },
                {
                    quoted: msg
                }
            );

        }


        let args =
            text
            .replace(".cf", "")
            .trim()
            .split(/\s+/);


        const choice = args[0]?.toLowerCase();

        const bet = Number(args[1]);


        if (
            choice !== "heads" &&
            choice !== "tails"
        ) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`🪙 Zorex Coin Flip

Usage:

.cf heads 1000
.cf tails 1000`
                },
                {
                    quoted: msg
                }
            );

        }


        if (
            isNaN(bet) ||
            bet <= 0
        ) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`⚠️ Enter a valid bet amount.`
                },
                {
                    quoted: msg
                }
            );

        }


        if (
            users[sender].wallet < bet
        ) {

            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`❌ You don't have enough Crescents.

Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
                },
                {
                    quoted: msg
                }
            );

        }


        debitWallet(
            users,
            sender,
            bet
        );

        setCooldown(sender, "cf");
        incrementDailyPlay(sender, "cf");


        let result;

if (chance(50)) {

    result = "heads";

} else {

    result = "tails";

}


        if (result === choice) {

            // 1.85x payout instead of a flat 2x
            const prize = Math.floor(bet * 1.85);

            creditWallet(
                users,
                sender,
                prize
            );


            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`🪙 *ZOREX COIN FLIP*
${DIVIDER}
🎯 Choice: 《${choice.toUpperCase()}》
🪙 Result: 《${result.toUpperCase()}》
🎉 WIN — 《+${prize.toLocaleString()}》🌙
${DIVIDER}`
                },
                {
                    quoted: msg
                }
            );


        } else {


            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`🪙 *ZOREX COIN FLIP*
${DIVIDER}
🎯 Choice: 《${choice.toUpperCase()}》
🪙 Result: 《${result.toUpperCase()}》
💀 LOSS — 《-${bet.toLocaleString()}》🌙
${DIVIDER}`
                },
                {
                    quoted: msg
                }
            );
      }

// CASINO
}else if (text.startsWith(".casino")) {


    if (!users[sender]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: notRegisteredMessage() },
            { quoted: msg }
        );

    }


    const casinoRemaining = checkCooldown(sender, "casino", COOLDOWN_MS);

    if (casinoRemaining) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⏳ Slow down! Try again in ${Math.ceil(casinoRemaining / 1000)}s.`
            },
            {
                quoted: msg
            }
        );

    }


    const casinoLimit = checkDailyLimit(sender, "casino");

    if (casinoLimit) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`📅 Daily limit reached for Casino.

Used: ${casinoLimit.used}/${casinoLimit.limit}

Come back tomorrow!`
            },
            {
                quoted: msg
            }
        );

    }


    const input =
        text.replace(".casino", "").trim();


    const bet =
        Number(
            input.replace(/,/g, "")
        );


    if (isNaN(bet) || bet <= 0) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🎰 Zorex Casino

Usage:

.casino 5000`
            },
            {
                quoted: msg
            }
        );

    }


    if (users[sender].wallet < bet) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`❌ You don't have enough Crescents.

Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
            },
            {
                quoted: msg
            }
        );

    }


    // Remove bet
    debitWallet(
        users,
        sender,
        bet
    );

    setCooldown(sender, "casino");
    incrementDailyPlay(sender, "casino");


    // Lucky Charm = guaranteed win for this one play, otherwise flat 60%
    let win;
    let charmUsed = false;

    if (
        users[sender].luckyCharmActive &&
        Date.now() < users[sender].luckyCharmActive.expiresAt
    ) {

        win = true;
        charmUsed = true;

        delete users[sender].luckyCharmActive;
        saveUsers(users);

    } else {

        win = Math.random() * 100 < 60;

    }


    if (win) {

        const prize = bet * 2;

        creditWallet(
            users,
            sender,
            prize
        );


        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🎰 *ZOREX CASINO*
${DIVIDER}
🎲 Result: WIN 🎉${charmUsed ? " 🍀" : ""}
🏆 Prize: 《+${prize.toLocaleString()}》🌙
${DIVIDER}`
            },
            {
                quoted: msg
            }
        );


    } else {


        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🎰 *ZOREX CASINO*
${DIVIDER}
🎲 Result: LOSS ❌
💸 Lost: 《-${bet.toLocaleString()}》🌙
${DIVIDER}`
            },
            {
    quoted: msg
}
        );

    }

// ROULETTE

} else if (text.startsWith(".roulette")) {

    if (!users[sender]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: notRegisteredMessage() },
            { quoted: msg }
        );

    }


    const rouletteRemaining = checkCooldown(sender, "roulette", COOLDOWN_MS);

    if (rouletteRemaining) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⏳ Slow down! Try again in ${Math.ceil(rouletteRemaining / 1000)}s.`
            },
            {
                quoted: msg
            }
        );

    }


    const rouletteLimit = checkDailyLimit(sender, "roulette");

    if (rouletteLimit) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`📅 Daily limit reached for Roulette.

Used: ${rouletteLimit.used}/${rouletteLimit.limit}

Come back tomorrow!`
            },
            {
                quoted: msg
            }
        );

    }


    let args =
        text
        .replace(".roulette", "")
        .trim()
        .split(/\s+/);


    const choice =
        args[0]?.toLowerCase();


    const bet =
        Number(
            args[1]
        );


    if (
        choice !== "red" &&
        choice !== "black"
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🎡 Zorex Roulette

Usage:

.roulette red 1000
.roulette black 1000`
            },
            {
                quoted: msg
            }
        );

    }


    if (
        isNaN(bet) ||
        bet <= 0
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ Enter a valid bet amount.`
            },
            {
                quoted: msg
            }
        );

    }


    if (
        users[sender].wallet < bet
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`❌ You don't have enough Crescents.

Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
            },
            {
                quoted: msg
            }
        );

    }


    // Remove bet
    debitWallet(
        users,
        sender,
        bet
    );

    setCooldown(sender, "roulette");
    incrementDailyPlay(sender, "roulette");


    // 50/50 chance
    let result;

    if (chance(50)) {

        result = "red";

    } else {

        result = "black";

    }


    if (result === choice) {

        const prize = bet * 2;

        creditWallet(
            users,
            sender,
            prize
        );


        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🎡 *ZOREX ROULETTE*
${DIVIDER}
🎯 Choice: 《${choice.toUpperCase()}》
🎡 Result: 《${result.toUpperCase()}》
🎉 WIN — 《+${prize.toLocaleString()}》🌙
${DIVIDER}`
            },
            {
                quoted: msg
            }
        );


    } else {


        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🎡 *ZOREX ROULETTE*
${DIVIDER}
🎯 Choice: 《${choice.toUpperCase()}》
🎡 Result: 《${result.toUpperCase()}》
💀 LOSS — 《-${bet.toLocaleString()}》🌙
${DIVIDER}`
            },
            {
                quoted: msg
            }
        );

    }

    // DICE
}else if (text.startsWith(".dice")) {


    if (!users[sender]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: notRegisteredMessage() },
            { quoted: msg }
        );

    }


    const args =
        text
        .replace(".dice", "")
        .trim()
        .split(/\s+/);


    const choice =
        args[0]?.toLowerCase();


    const bet =
        Number(args[1]);


    if (!choice || isNaN(bet) || bet <= 0) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🎲 Zorex Dice

Usage:

.dice 7 1000
.dice odd 1000
.dice even 1000`
            },
            {
                quoted: msg
            }
        );

    }


    if (
        users[sender].wallet < bet
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`❌ You don't have enough Crescents.

Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
            },
            {
                quoted: msg
            }
        );

    }


    // Validate choice

    const numberChoice =
        Number(choice);


    if (
        isNaN(numberChoice) &&
        choice !== "odd" &&
        choice !== "even"
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ Choose a number between 2-12 or odd/even.`
            },
            {
                quoted: msg
            }
        );

    }


    if (
        !isNaN(numberChoice) &&
        (numberChoice < 2 || numberChoice > 12)
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ Dice numbers are only 2-12.`
            },
            {
                quoted: msg
            }
        );

    }


    debitWallet(
        users,
        sender,
        bet
    );


    // Roll two dice

    const dice1 =
        Math.floor(Math.random() * 6) + 1;

    const dice2 =
        Math.floor(Math.random() * 6) + 1;


    const result =
        dice1 + dice2;


    let won = false;
    let payout = 0;


    // Exact number prediction

    if (!isNaN(numberChoice)) {


        if (result === numberChoice) {

            const payouts = {
                2: 24,
                3: 12,
                4: 8,
                5: 6,
                6: 5,
                7: 4,
                8: 5,
                9: 6,
                10: 8,
                11: 12,
                12: 24
            };


            payout =
                bet * payouts[result];


            won = true;

        }


    }


    // Odd even prediction

    else {


        const type =
            result % 2 === 0
            ? "even"
            : "odd";


        if (choice === type) {

            payout =
                bet * 2;

            won = true;

        }

    }


    if (won) {


        creditWallet(
            users,
            sender,
            payout
        );


        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🎲 *ZOREX DICE*
${DIVIDER}
🎲 Roll: 《${dice1} + ${dice2} = ${result}》
🎉 WIN — 《+${payout.toLocaleString()}》🌙
${DIVIDER}`
            },
            {
                quoted: msg
            }
        );


    } else {


        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🎲 *ZOREX DICE*
${DIVIDER}
🎲 Roll: 《${dice1} + ${dice2} = ${result}》
💀 LOSS — 《-${bet.toLocaleString()}》🌙
${DIVIDER}`
            },
            {
                quoted: msg
            }
        );

    }

    // SLOTS
} else if (text.startsWith(".slots")) {


    if (!users[sender]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            { text: notRegisteredMessage() },
            { quoted: msg }
        );

    }


    const slotsRemaining = checkCooldown(sender, "slots", COOLDOWN_MS);

    if (slotsRemaining) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⏳ Slow down! Try again in ${Math.ceil(slotsRemaining / 1000)}s.`
            },
            {
                quoted: msg
            }
        );

    }


    const slotsLimit = checkDailyLimit(sender, "slots");

    if (slotsLimit) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`📅 Daily limit reached for Slots.

Used: ${slotsLimit.used}/${slotsLimit.limit}

Come back tomorrow!`
            },
            {
                quoted: msg
            }
        );

    }


    const bet =
        Number(
            text.replace(".slots", "")
            .trim()
        );


    if (
        isNaN(bet) ||
        bet <= 0
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🎰 Zorex Slots

Usage:

.slots 1000`
            },
            {
                quoted: msg
            }
        );

    }


    if (
        users[sender].wallet < bet
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`❌ You don't have enough Crescents.

Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
            },
            {
                quoted: msg
            }
        );

    }


    debitWallet(
        users,
        sender,
        bet
    );

    setCooldown(sender, "slots");
    incrementDailyPlay(sender, "slots");


    const symbols = [
        "🍒",
        "🍋",
        "🔔",
        "💎"
    ];


    const roll =
        Math.random() * 100;


    let slotResult;
    let multiplier = 0;


    // 40% chance: total loss
    if (roll < 40) {

        let a =
            symbols[
                Math.floor(
                    Math.random() * symbols.length
                )
            ];

        let b =
            symbols[
                Math.floor(
                    Math.random() * symbols.length
                )
            ];

        let c =
            symbols[
                Math.floor(
                    Math.random() * symbols.length
                )
            ];


        while (
            a === b ||
            a === c ||
            b === c
        ) {

            b =
            symbols[
                Math.floor(
                    Math.random() * symbols.length
                )
            ];

            c =
            symbols[
                Math.floor(
                    Math.random() * symbols.length
                )
            ];

        }


        slotResult =
        `${a} | ${b} | ${c}`;

    }


    // 42% chance: double (2x)
    else if (roll < 82) {


        const symbol =
            symbols[
                Math.floor(
                    Math.random() * symbols.length
                )
            ];


        let other =
            symbols[
                Math.floor(
                    Math.random() * symbols.length
                )
            ];


        while (other === symbol) {

            other =
            symbols[
                Math.floor(
                    Math.random() * symbols.length
                )
            ];

        }


        slotResult =
        `${symbol} | ${symbol} | ${other}`;

        multiplier = 2;

    }


    // 16% chance: triple (3x)
    else if (roll < 98) {


        const symbol =
            symbols[
                Math.floor(
                    Math.random() * symbols.length
                )
            ];


        slotResult =
        `${symbol} | ${symbol} | ${symbol}`;

        multiplier = 3;

    }


    // 2% chance: jackpot (7x)
    else {


        slotResult =
        `7️⃣ | 7️⃣ | 7️⃣`;

        multiplier = 7;

    }



        if (multiplier > 0) {


        const prize =
            bet * multiplier;


        creditWallet(
            users,
            sender,
            prize
        );


        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🎰 *ZOREX SLOTS*
${DIVIDER}
${slotResult}
🎉 WIN — 《+${prize.toLocaleString()}》🌙
${DIVIDER}`
            },
            {
                quoted: msg
            }
        );


    } else {


        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🎰 *ZOREX SLOTS*
${DIVIDER}
${slotResult}
💀 LOSS — 《-${bet.toLocaleString()}》🌙
${DIVIDER}`
            },
            {
                quoted: msg
            }
        );


       }


}


}

module.exports = {
    gambleCommands
};