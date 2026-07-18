const fs = require("fs");

const USERS_FILE = "./users.json";


function loadUsers() {

    if (!fs.existsSync(USERS_FILE)) {

        fs.writeFileSync(
            USERS_FILE,
            "{}"
        );

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

async function gambleCommands(sock, msg, text) {

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;


    const users = loadUsers();

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

🎰 Casino
.casino <amount>

🪙 Coin Flip
.cf heads/tails <amount>

🎡 Roulette
.roulette red/black <amount>

🎲 Dice
.dice <number/odd/even> <amount>

🎰 Slots
.slots <amount>

🃏 Blackjack
.bj <amount>
.bj all

🎴 Poker
.poker <amount>

💣 Mines
.mines <amount>

💰 Bet
.bet

✈️ Aviator
.aviator <amount>


🌙 Money Commands

.bal
.dep
.wd


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
                {
                    text:
`❌ You don't have a Zorex profile yet.

Use:
.register`
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


        let result;

if (chance(50)) {

    result = "heads";

} else {

    result = "tails";

}


        if (result === choice) {


            creditWallet(
                users,
                sender,
                bet * 2
            );


            return await sock.sendMessage(
                msg.key.remoteJid,
                {
                    text:
`🪙 *Zorex Coin Flip*

🎯 Choice:
${choice.toUpperCase()}

🪙 Result:
${result.toUpperCase()}


🎉 YOU WON!

💰 Prize:
+${(bet * 2).toLocaleString()} 🌙

Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
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
`🪙 *Zorex Coin Flip*

🎯 Choice:
${choice.toUpperCase()}

🪙 Result:
${result.toUpperCase()}


💀 YOU LOST!

💸 Lost:
${bet.toLocaleString()} 🌙

Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
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
            {
                text:
`❌ You don't have a Zorex profile yet.

Use:
.register`
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


    // 70% win chance
    const win =
        Math.random() * 100 < 70;


    if (win) {


        creditWallet(
            users,
            sender,
            bet * 2
        );


        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🎰 *Zorex Casino*

💰 Bet:
${bet.toLocaleString()} 🌙


🎲 Result:
WIN 🎉


🏆 Prize:
+${(bet * 2).toLocaleString()} 🌙


💳 Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
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
`🎰 *Zorex Casino*

💰 Bet:
${bet.toLocaleString()} 🌙


🎲 Result:
LOSS ❌


💸 Lost:
${bet.toLocaleString()} 🌙


💳 Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
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
            {
                text:
`❌ You don't have a Zorex profile yet.

Use:
.register`
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


    // 50/50 chance
    let result;

    if (chance(50)) {

        result = "red";

    } else {

        result = "black";

    }


    if (result === choice) {


        creditWallet(
            users,
            sender,
            bet * 2
        );


        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`🎡 *Zorex Roulette*

🎯 Choice:
${choice.toUpperCase()}

🎡 Result:
${result.toUpperCase()}


🎉 YOU WON!


💰 Prize:
+${(bet * 2).toLocaleString()} 🌙


💳 Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
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
`🎡 *Zorex Roulette*

🎯 Choice:
${choice.toUpperCase()}

🎡 Result:
${result.toUpperCase()}


💀 YOU LOST!


💸 Lost:
${bet.toLocaleString()} 🌙


💳 Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
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
            {
                text:
`❌ You don't have a Zorex profile yet.

Use:
.register`
            },
            {
                quoted: msg
            }
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
`🎲 *Zorex Dice*

🎲 Dice:
${dice1} + ${dice2}

🎯 Result:
${result}


🎉 YOU WON!

💰 Prize:
+${payout.toLocaleString()} 🌙


💳 Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
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
`🎲 *Zorex Dice*

🎲 Dice:
${dice1} + ${dice2}

🎯 Result:
${result}


💀 YOU LOST!

💸 Lost:
${bet.toLocaleString()} 🌙


💳 Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
            },
            {
                quoted: msg
            }
        );

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

• Double or nothing
• 70% win chance
• 2x payout


🪙 *Coin Flip*

.cf heads/tails <amount>

• 50/50 chance
• 2x payout


🎡 *Roulette*

.roulette red/black <amount>

• Predict red or black
• 50/50 chance
• 2x payout


🎲 *Dice*

.dice <number/odd/even> <amount>

• Roll two dice
• Higher risk = higher reward


🎰 *Slots*

.slots <amount>

• Match symbols to win
• 2x - 7x payouts


🃏 *Blackjack*

.bj <amount>
.bj all

• Challenge the dealer
• Get closer to 21 without busting
• Use .hit, .stand, or .double
• Beat the dealer to win


🎴 *Poker*

.poker <amount>

• Video poker with card holds
• Hold your best cards and redraw
• Royal Flush pays the biggest rewards


💣 *Mines*

.mines <amount>

• Pick safe tiles
• Avoid hidden mines
• Higher risk = higher rewards


💰 *Betting*

.bet

• Coming soon


✈️ *Aviator*

.aviator <amount>

• Crash game
• Cash out before it crashes


🌙 *Money Commands*

.bal
.dep <amount>
.wd <amount>


Powered by Zorex AI 🤖`
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
            {
                text:
`❌ You don't have a Zorex profile yet.

Use:
.register`
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


    if (roll < 30) {

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


    else if (roll < 70) {


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


    else if (roll < 95) {


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
`🎰 *Zorex Slots*

${slotResult}

🎉 YOU WON!

💰 Prize:
+${prize.toLocaleString()} 🌙

💳 Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
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
`🎰 *Zorex Slots*

${slotResult}

💀 YOU LOST!

💸 Lost:
${bet.toLocaleString()} 🌙

💳 Wallet:
${users[sender].wallet.toLocaleString()} 🌙`
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