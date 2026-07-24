require("dotenv").config();
// Prevent bot from crashing on unexpected errors
process.on("uncaughtException", (err) => {
    console.error("💥 UNCAUGHT EXCEPTION:", err);
});

let restarting = false;

process.on("unhandledRejection", (reason) => {
    console.error("💥 UNHANDLED REJECTION:", reason);
});

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const readline = require("readline");
const fs = require("fs");

const {
    economyCommands
} = require("./commands/economy");

const { shopCommands } = require("./commands/shop");
const { inviteCommands } = require("./commands/invite");
const { minesCommands } = require("./commands/mines");
const { gambleCommands } = require("./commands/gamble");
const { groupCommands } = require("./commands/group");
const { cardCommands } = require("./commands/card");

const {
    moderationWatcher
} = require("./commands/moderation");

const {
    richCommand,
    openGroup,
    closeGroup,
    inviteCommand,
    myCooldownsCommand,
    myDailyLimitsCommand
} = require("./commands/misc");

const {
    importAuctionItem,
    startAuction,
    placeBid,
    endAuction,
    forceEndAuction,
    viewCollection,
    viewInventory,
    useLuckyCharm
} = require("./commands/auction");

const { crimeCommand } = require("./commands/crime");
const { robCommand } = require("./commands/rob");
const { begCommand } = require("./commands/beg");
const { fishCommand } = require("./commands/fish");
const { digCommand } = require("./commands/dig");
const { chloeCommand } = require("./commands/chloe");
const { memCommand } = require("./commands/mem");
const { relationCommand } = require("./commands/relation");

const {
    marryCommand,
    marryAcceptCommand,
    marryDeclineCommand,
    divorceCommand
} = require("./commands/marry");

const { dailyCommand } = require("./commands/daily");
const { workCommand } = require("./commands/work");

const {
    blackjackCommand,
    hitCommand,
    standCommand,
    doubleCommand
} = require("./commands/blackjack");

const { MAIN_OWNER } = require("./config");
const OWNERS_FILE = "./owners.json";

const {
    startWCG
} = require("./wcg");

const {
    startOwner
} = require("./commands/owner");

const {
    startVV
} = require("./vv");

const GAMES_FILE = "./games.json";
const WCG_FILE = "./wcg.json";

function loadWCG() {

    if (!fs.existsSync(WCG_FILE)) {
        fs.writeFileSync(WCG_FILE, "{}");
    }

    return JSON.parse(fs.readFileSync(WCG_FILE));

}


function saveWCG(wcg) {

    fs.writeFileSync(
        WCG_FILE,
        JSON.stringify(wcg, null, 4)
    );

}

function checkWinner(board) {

    const winningPatterns = [

        [0,1,2],
        [3,4,5],
        [6,7,8],

        [0,3,6],
        [1,4,7],
        [2,5,8],

        [0,4,8],
        [2,4,6]

    ];


    for (const pattern of winningPatterns) {

        const [a,b,c] = pattern;


        if (
            board[a] === board[b] &&
            board[a] === board[c] &&
            (board[a] === "❌" || board[a] === "⭕")
        ) {

            return board[a];

        }

    }


    return null;

}

function loadGames() {

    if (!fs.existsSync(GAMES_FILE)) {
        fs.writeFileSync(GAMES_FILE, "{}");
    }

    return JSON.parse(fs.readFileSync(GAMES_FILE));

}


function saveGames(games) {

    fs.writeFileSync(
        GAMES_FILE,
        JSON.stringify(games, null, 4)
    );

}
const axios = require("axios");
const { truncate } = require("fs/promises");
const USERS_FILE = "./users.json";
console.log("Using users file:", require("path").resolve(USERS_FILE));

function loadUsers() {

    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, "{}");
    }

    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));

}

function saveUsers(users) {

    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify(users, null, 4),
        "utf8"
    );

}

async function startBot() {

    console.log("🚀 Starting Zorex WhatsApp connection...");

    // Anything timestamped before this moment is history, not a live command
    const startTime = Math.floor(Date.now() / 1000);

    const { state, saveCreds } =
        await useMultiFileAuthState("auth");


    const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    syncFullHistory: false
});


    sock.ev.on(
        "creds.update",
        saveCreds
    );


    sock.ev.on(
        "connection.update",
        ({
            connection,
            qr,
            lastDisconnect
        }) => {


            console.log(
                "Connection Update:",
                connection
            );


            if (lastDisconnect) {

                console.log(
                    "Disconnect Reason:",
                    lastDisconnect.error
                );

            }


            if (qr) {

                console.log(
                    "📱 Scan this QR Code:"
                );

                qrcode.generate(
                    qr,
                    {
                        small: true
                    }
                );

            }


            if (connection === "open") {

                console.log(
                    "✅ Zorex is connected to WhatsApp!"
                );

            }



            if (connection === "close") {


                const statusCode =
                    lastDisconnect
                    ?.error
                    ?.output
                    ?.statusCode;


                console.log(
                    "Status Code:",
                    statusCode
                );


                if (
                    statusCode ===
                    DisconnectReason.loggedOut
                ) {

                    console.log(
                        "❌ Logged out. Delete auth folder and scan QR again."
                    );

                    return;

                }


                if (!restarting) {

                    restarting = true;


                    console.log(
                        "🔄 Reconnecting in 5 seconds..."
                    );


                    setTimeout(() => {

                        restarting = false;

                        startBot();

                    }, 5000);

                }

            }

        }

    );


    // Listen for incoming messages
    sock.ev.on("messages.upsert", async ({ messages, type }) => {

        const msg = messages[0];

        if (!msg.message) return;

        // Ignore anything that isn't a live, real-time message —
        // history sync replays come through with a different type
        if (type !== "notify") return;

        // Extra safety net: ignore anything timestamped before the bot started
        if (msg.messageTimestamp && msg.messageTimestamp < startTime) return;

        await moderationWatcher(sock, msg);

        const context =
            msg.message?.extendedTextMessage?.contextInfo;

        const mentioned =
            context?.mentionedJid || [];

        console.log("Mentioned:", mentioned);
        console.log("Context:", context);

    const jealousReplies = [

`💙 Hey hey hey! 😠

Why are you calling my boyfriend?

Lord Crimson belongs to me, so hands off! 😌✨`,

`😤 Excuse me?

Why are you tagging MY Lord Crimson?

Find your own boyfriend. 💙`,

`🙄 Hmph!

Lord Crimson is already taken.

Try your luck somewhere else. 😌`,

`💙 Nope.

He's busy spending time with me.

Back off. 😤`,

`😒 I saw that tag.

Lord Crimson belongs to me.

Don't make me jealous. 💙`,

`😤 Hands off!

He's my boyfriend, not yours.

Go find your own. 💙`,

`💙 You called Lord Crimson?

Well... he's already occupied.

With me. 😌✨`,

`😒 I don't like seeing other people call my boyfriend.

Please behave yourself. 💙`

    ];

    const reply =
        jealousReplies[
            Math.floor(
                Math.random() * jealousReplies.length
            )
        ];

    const isCrimsonMentioned =
        mentioned.includes("164317513175043@lid");

    const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text;

    if (!text) return;

await handleMessage(sock, msg);

    console.log("Message:", text);

    if (
        msg.key.remoteJid.endsWith("@g.us") &&
        isCrimsonMentioned
    ) {

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: reply
            },
            {
                quoted: msg
            }
        );

    }

    if (text === ".ping") {

        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: "🏓 Pong!"
            },
            {
                quoted: msg
            }
        );

       } else if (text === ".help") {

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            image: fs.readFileSync("./zorex.jpg"),
            caption: `🤖 Yo, I'm *Zorex*.

What do you need help with?

📜 Type *.menu* to see my list of commands.

👑 Type *.owner* to contact *Lord Crimson*.

⚡ I'm ready when you are.`
        },
        {
            quoted: msg
        }
    );

        } else if (text === ".owner") {

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `👑 *Zorex Owner*

My Lord Crimson

📞 Number: 08036391250

🤖 Created with ❤️ by Crimson Roy`
        },
        {
            quoted: msg
        }
    );

            } else if (text === ".test") {

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: "⚡ Testing Zorex network..."
        },
        {
            quoted: msg
        }
    );

    try {

        const start = Date.now();

        await axios.get(
            "https://speed.cloudflare.com/__down?bytes=1000000",
            {
                responseType: "arraybuffer",
                timeout: 15000
            }
        );

        const end = Date.now();

        const seconds = (end - start) / 1000;
        const speed = (1 / seconds).toFixed(2);


        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚡ *ZOREX NETWORK TEST*

📡 Network Speed: ${speed} Mbps

✅ Zorex is working fine 🤖`
            },
            {
                quoted: msg
            }
        );


    } catch (error) {

        console.log(
            "TEST ERROR:",
            error.message
        );


        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ Network test failed.

🤖 Zorex is still running.`
            },
            {
                quoted: msg
            }
        );

    }

    } else if (text.startsWith(".register")) {

    const args = text.split(" ").slice(1);

    if (args.length === 0) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `⚠️ Registration Format

.register YOUR_NAME

Example:
.register Crimson Roy`
            },
            {
                quoted: msg
            }
        );

    }

    const users = loadUsers();

    const userId = msg.key.participant || msg.key.remoteJid;

    if (users[userId]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `⚠️ You are already registered.`
            },
            {
                quoted: msg
            }
        );

    }

    const username = args.join(" ");

    users[userId] = {

        name: username,
        age: "Not Set",
        bio: "No bio set.",
        role: "User",
        guild: "None",
        level: 1,
        rank: "Beginner",

        wallet: 500000,
        bank: 0,
        bankLimit: 100000,

        games: 0,
        wins: 0,
        losses: 0,

        partner: null,
        maritalStatus: "single",
        marriageCount: 0

    };

    saveUsers(users);

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
   🎉 𝗥𝗘𝗚𝗜𝗦𝗧𝗥𝗔𝗧𝗜𝗢𝗡 𝗦𝗨𝗖𝗖𝗘𝗦𝗦𝗙𝗨𝗟 🎉
╰━━━━━━━━━━━━━━━━━━━━━━━╯
  » Name    : ${username}
  » Bonus   : 《500,000》🌙
━━━━━━━━━━━━━━━━━━━━━━━━━
✨ Welcome to Zorex!
Type .profile to view your account.`
        },
        {
            quoted: msg
        }
    );

    } else if (text.startsWith(".setage")) {

    const users = loadUsers();

    const userId = msg.key.participant || msg.key.remoteJid;

    if (!users[userId]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `⚠️ You are not registered.

Use:

.register YOUR_NAME`
            },
            {
                quoted: msg
            }
        );

    }

    const age = text.split(" ").slice(1).join(" ");

    if (!age) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `⚠️ Usage:

.setage YOUR_AGE

Example:
.setage 19`
            },
            {
                quoted: msg
            }
        );

    }

    users[userId].age = age;

    saveUsers(users);

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `✅ Age updated successfully!

🎂 New Age: ${age}`
        },
        {
            quoted: msg
        }
    );

    } else if (text.startsWith(".setbio")) {

    const users = loadUsers();

    const userId = msg.key.participant || msg.key.remoteJid;

    if (!users[userId]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `⚠️ You are not registered.

Use:

.register YOUR_NAME`
            },
            {
                quoted: msg
            }
        );

    }

    const bio = text.split(" ").slice(1).join(" ");

    if (!bio) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `⚠️ Usage:

.setbio YOUR_BIO

Example:
.setbio Future CEO of Roy Trading Group`
            },
            {
                quoted: msg
            }
        );

    }

    users[userId].bio = bio;

    saveUsers(users);

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `✅ Bio updated successfully!

📝 ${bio}`
        },
        {
            quoted: msg
        }
    );

    } else if (text === ".age") {

    const users = loadUsers();

    const userId = msg.key.participant || msg.key.remoteJid;

    if (!users[userId]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `⚠️ You are not registered.

Use:

.register YOUR_NAME`
            },
            {
                quoted: msg
            }
        );

    }

    const user = users[userId];

    if (user.age === "Not Set") {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `🤔 I don't know your age yet.

Use:

.setage YOUR_AGE

Example:
.setage 19`
            },
            {
                quoted: msg
            }
        );

    }

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `😂 Of course I know your age.

🎂 You're *${user.age}* years old.

🤖 Did you really think I'd forget something as important as your age?`
        },
        {
            quoted: msg
        }
    );

} else if (text === ".vv") {

    await startVV(sock, msg);

    } else if (text === ".bio") {

    const users = loadUsers();

    const userId = msg.key.participant || msg.key.remoteJid;

    if (!users[userId]) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `⚠️ You are not registered.

Use:

.register YOUR_NAME`
            },
            {
                quoted: msg
            }
        );

    }

    const user = users[userId];

    if (user.bio === "No bio set.") {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `🤔 Your bio hasn't been set yet.

Use:

.setbio YOUR_BIO

Example:
.setbio Lord Crescent creator of the future`
            },
            {
                quoted: msg
            }
        );

    }

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `I know exactly who you are.
You're *${user.bio}*
🤖 That's the bio you trusted me to remember.`
        },
        {
            quoted: msg
        }
    );

} else if (text === ".profile") {

    const users = loadUsers();

    const userId = msg.key.participant || msg.key.remoteJid;

    if (!users[userId]) {

        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ You are not registered.

Use:

.register YOUR_NAME`
        });

    }

    const user = users[userId];

    // Try to fetch their real WhatsApp profile picture — falls back to the
    // default Zorex image if they don't have one set, it can't be fetched,
    // or the fetch hangs for more than 5 seconds
    let profileImage;

    try {

        const ppUrl = await Promise.race([
            sock.profilePictureUrl(userId, "image"),
            new Promise((_, reject) => setTimeout(() => reject(new Error("pp fetch timeout")), 5000))
        ]);

        profileImage = { url: ppUrl };

    } catch (err) {

        console.log("Profile picture fetch failed/timed out:", err.message);
        profileImage = fs.readFileSync("./zorex.jpg");

    }

    const statusLabel = user.partner
        ? (user.maritalStatus === "re-married" ? "Re-married" : "Married")
        : (user.maritalStatus === "divorced" ? "Divorced" : "Single");

    const partnerLine = user.partner
        ? `💍 Status  : ${statusLabel} to @${user.partner.split("@")[0]}`
        : `💍 Status  : ${statusLabel}`;

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            image: profileImage,
            caption: `╭━━━━━━━━━━━━━━━━━━━━━━━╮
             𝖹𝖮𝖱𝖤𝖷 𝖯𝖱𝖮𝖥𝖨𝖫𝖤
╰━━━━━━━━━━━━━━━━━━━━━━━╯
  » Name    : ${user.name}
  » Age     : ${user.age}
  » Role    : ${user.role}
  » Guild   : ${user.guild}
  » Level   : ${user.level}
  » Rank    : ${user.rank}
  » ${partnerLine}
  » Bio     : ${user.bio}
━━━━━━━━━━━━━━━━━━━━━━━━━
  » Wallet  : ${user.wallet.toLocaleString()} 🌙
━━━━━━━━━━━━━━━━━━━━━━━━━
  » Games   : ${user.games}
  » Wins    : ${user.wins}
  » Losses  : ${user.losses}
━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ Powered by Zorex AI`,
            mentions: user.partner ? [user.partner] : []
        },
        {
            quoted: msg
        }
    );

} else if (text.startsWith(".ttt")) {

    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;

    if (!mentioned || mentioned.length === 0) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ You need to challenge someone.

Example:

.ttt @user`
            },
            {
                quoted: msg
            }
        );

    }


    const challenger =
        msg.key.participant || msg.key.remoteJid;

    const opponent = mentioned[0];


    const games = loadGames();


    const gameId = Date.now().toString();


    games[gameId] = {

        type: "ttt",
        status: "pending",

        challenger: challenger,
        opponent: opponent,

        createdAt: Date.now()

    };


    saveGames(games);


    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🎮 *ZOREX TIC-TAC-TOE CHALLENGE*

👤 @${challenger.split("@")[0]} has challenged 👤 @${opponent.split("@")[0]}!

❌ Challenger VS ⭕ Opponent

@${opponent.split("@")[0]} has 1 minute to accept.

Type:

.accept

to start the game.

⌛ Challenge expires in 60 seconds.`,
            mentions: [
                challenger,
                opponent
            ]
        },
        {
            quoted: msg
        }
    );


    setTimeout(async () => {

    const updatedGames = loadGames();

    if (updatedGames[gameId] &&
        updatedGames[gameId].status === "pending") {


        const expiredGame = updatedGames[gameId];

        delete updatedGames[gameId];

        saveGames(updatedGames);


        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⌛ *TIC-TAC-TOE CHALLENGE EXPIRED*

@${expiredGame.opponent.split("@")[0]} did not accept the challenge on time.

❌ Match has been voided.

Better luck next time! 🎮`,
                mentions: [
                    expiredGame.challenger,
                    expiredGame.opponent
                ]
            }
        );

    }

}, 60000);

} else if (text === ".accept") {

    const userId = msg.key.participant || msg.key.remoteJid;

    const games = loadGames();

    let foundGame = null;
    let gameId = null;


    for (const id in games) {

        if (
            games[id].type === "ttt" &&
            games[id].status === "pending" &&
            games[id].opponent === userId
        ) {

            foundGame = games[id];
            gameId = id;
            break;

        }

    }


    if (!foundGame) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ You don't have any pending Tic-Tac-Toe challenges.`
            },
            {
                quoted: msg
            }
        );

    }



    games[gameId].status = "active";


    games[gameId].board = [
        "1️⃣",
        "2️⃣",
        "3️⃣",
        "4️⃣",
        "5️⃣",
        "6️⃣",
        "7️⃣",
        "8️⃣",
        "9️⃣"
    ];


    games[gameId].turn = foundGame.challenger;


    saveGames(games);



    const board =
`╔═══╦═══╦═══╗
║ ${games[gameId].board[0]} ║ ${games[gameId].board[1]} ║ ${games[gameId].board[2]} ║
╠═══╬═══╬═══╣
║ ${games[gameId].board[3]} ║ ${games[gameId].board[4]} ║ ${games[gameId].board[5]} ║
╠═══╬═══╬═══╣
║ ${games[gameId].board[6]} ║ ${games[gameId].board[7]} ║ ${games[gameId].board[8]} ║
╚═══╩═══╩═══╝`;



    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🎮 *ZOREX TIC-TAC-TOE STARTED!*

❌ @${foundGame.challenger.split("@")[0]}
VS
⭕ @${foundGame.opponent.split("@")[0]}


❌ @${foundGame.challenger.split("@")[0]}'s turn


${board}


Type the number of the box you want to choose.`,
            
            mentions:[
                foundGame.challenger,
                foundGame.opponent
            ]
        },
        {
            quoted: msg
        }
    );

    } else if (/^[1-9]$/.test(text)) {

    const userId = msg.key.participant || msg.key.remoteJid;

    const games = loadGames();


    let activeGame = null;
    let gameId = null;


    for (const id in games) {

        if (
            games[id].type === "ttt" &&
            games[id].status === "active" &&
            (
                games[id].challenger === userId ||
                games[id].opponent === userId
            )
        ) {

            activeGame = games[id];
            gameId = id;
            break;

        }

    }


    if (!activeGame) {
        return;
    }



    // Check turn

    if (activeGame.turn !== userId) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⏳ Wait!

It is not your turn.

🎮 It is currently @${activeGame.turn.split("@")[0]}'s turn.`,
                
                mentions:[
                    activeGame.turn
                ]
            },
            {
                quoted: msg
            }
        );

    }



    const move = Number(text) - 1;



    // Check selected box

    if (
        activeGame.board[move] === "❌" ||
        activeGame.board[move] === "⭕"
    ) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`❌ That position has already been chosen.

Pick another number.`
            },
            {
                quoted: msg
            }
        );

    }



    // Place move

    if (userId === activeGame.challenger) {

        activeGame.board[move] = "❌";

    } else {

        activeGame.board[move] = "⭕";

    }



    const board =
`╔═══╦═══╦═══╗
║ ${activeGame.board[0]} ║ ${activeGame.board[1]} ║ ${activeGame.board[2]} ║
╠═══╬═══╬═══╣
║ ${activeGame.board[3]} ║ ${activeGame.board[4]} ║ ${activeGame.board[5]} ║
╠═══╬═══╬═══╣
║ ${activeGame.board[6]} ║ ${activeGame.board[7]} ║ ${activeGame.board[8]} ║
╚═══╩═══╩═══╝`;



    // Check winner

    const winner = checkWinner(activeGame.board);



    const draw = activeGame.board.every(
        box =>
        box === "❌" ||
        box === "⭕"
    );



    if (winner || draw) {


        let result;


        if (winner === "❌") {

            result =
`🏆 *GAME OVER*

❌ @${activeGame.challenger.split("@")[0]} wins! 🎉`;

        }


        else if (winner === "⭕") {

            result =
`🏆 *GAME OVER*

⭕ @${activeGame.opponent.split("@")[0]} wins! 🎉`;

        }


        else {

            result =
`🤝 *GAME OVER*

The match ended in a draw.`;

        }



        await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`${result}


${board}`,

                mentions:[
                    activeGame.challenger,
                    activeGame.opponent
                ]
            },
            {
                quoted: msg
            }
        );



        delete games[gameId];

        saveGames(games);

        return;

    }



    // Switch turn

    if (activeGame.turn === activeGame.challenger) {

        activeGame.turn = activeGame.opponent;

    } else {

        activeGame.turn = activeGame.challenger;

    }



    saveGames(games);



    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text:
`🎮 *ZOREX TIC-TAC-TOE*

${board}


🎯 @${activeGame.turn.split("@")[0]}'s turn.`,

            mentions:[
                activeGame.turn
            ]
        },
        {
            quoted: msg
        }
    );

    } else if (text === ".wcg start") {

    await startWCG(sock, msg);

} else if (text === ".wcg join") {


    const userId =
    msg.key.participant || msg.key.remoteJid;


    const groupId = msg.key.remoteJid;


    const wcg = loadWCG();


    const game = wcg[groupId];


    if (!game) {

        return await sock.sendMessage(
            groupId,
            {
                text:
`⚠️ There is no active World Chain Game.

Use:

.wcg start

to create one.`
            },
            {
                quoted: msg
            }
        );

    }


    if (game.status !== "waiting") {

        return await sock.sendMessage(
            groupId,
            {
                text:
`⚠️ Joining has closed.

The World Chain Game has already started.`
            },
            {
                quoted: msg
            }
        );

    }


    if (game.players.includes(userId)) {

        return await sock.sendMessage(
            groupId,
            {
                text:
`😂 You are already in the World Chain Game!`
            },
            {
                quoted: msg
            }
        );

    }


    game.players.push(userId);


    saveWCG(wcg);


    await sock.sendMessage(
        groupId,
        {
            text:
`🌍🎮 *WORLD CHAIN GAME*

👤 @${userId.split("@")[0]} joined the game!


Current Players:

${game.players.map(
(player,index)=>
`${index + 1}. @${player.split("@")[0]}`
).join("\n")}


⏳ Waiting for game start...`,

            mentions: game.players

        },
        {
            quoted: msg
        }
    );
    function wcgTurnTimer(sock, groupId) {

    setTimeout(async () => {

        const wcg = loadWCG();

        const game = wcg[groupId];


        if (!game) return;


        if (game.status !== "active") return;


        const player = game.turn;


        // check if still their turn
        if (game.turn !== player) return;



        // remove player

        game.players = game.players.filter(
            id => id !== player
        );



        saveWCG(wcg);



        await sock.sendMessage(
            groupId,
            {
                text:
`⏰ Time's up!

@${player.split("@")[0]} did not submit a word.

❌ You have been eliminated.`,

                mentions:[
                    player
                ]
            }
        );



        checkWCGWinner(sock, groupId);


    },7000);

}

async function checkWCGWinner(sock, groupId){

    const wcg = loadWCG();

    const game = wcg[groupId];


    if(!game) return;



    if(game.players.length === 1){


        const winner = game.players[0];


        await sock.sendMessage(
            groupId,
            {
                text:
`🏆 *WORLD CHAIN GAME OVER!*


👑 Winner:

@${winner.split("@")[0]}

Congratulations 🎉`,

                mentions:[
                    winner
                ]
            }
        );


        delete wcg[groupId];

        saveWCG(wcg);

        return;

    }



    // next player

    const currentIndex =
    game.players.indexOf(game.turn);


    const nextIndex =
    (currentIndex + 1) % game.players.length;


    game.turn =
    game.players[nextIndex];


    saveWCG(wcg);



    await sock.sendMessage(
        groupId,
        {
            text:
`🎮 Next Player:

@${game.turn.split("@")[0]}


Start with:

${game.lastLetter}

⏳ You have 7 seconds.`,

            mentions:[
                game.turn
            ]
        }
    );


    wcgTurnTimer(sock, groupId);


}

} else if (
    text.startsWith(".setrole") ||
    text.startsWith(".addowner") ||
    text.startsWith(".removeowner") ||
    text.startsWith(".resetcd") ||
    text.startsWith(".resetdl") ||
    text.startsWith(".resetbal")
) {

    await startOwner(sock, msg, text);

} else if (

    text.startsWith(".mute") ||
    text.startsWith(".unmute") ||
    text.startsWith(".promote") ||
    text.startsWith(".kick") ||
    text.startsWith(".demote")

) {

        await groupCommands(
        sock,
        msg,
        text
    );

} else if (
    text.startsWith(".mines") ||
    text.startsWith(".shovel") ||
    text === ".cashout"
) {

    console.log("➡️ Routing to mines.js");

    await minesCommands(
        sock,
        msg,
        text
    );

} else if (
    text === ".inviteowner" ||
    /^\d{4}$/.test(text)
) {

    await inviteCommands(
        sock,
        msg,
        text
    );

} else if (

    text === ".bal" ||
    text.startsWith(".addcrescent") ||
    text.startsWith(".removecrescent") ||
    text.startsWith(".dep") ||
    text.startsWith(".wd") ||
    text.startsWith(".donate")

) {

    await economyCommands(
        sock,
        msg,
        text
    );

} else if (

    text.startsWith(".gamble") ||
    text.startsWith(".cf") ||
    text.startsWith(".casino") ||
    text.startsWith(".dice") ||
    text.startsWith(".mines") ||
    text.startsWith(".aviator") ||
    text.startsWith(".slots") ||
    text.startsWith(".roulette") ||
    text.startsWith(".poker")

) {

    await gambleCommands(
        sock,
        msg,
        text
    );

   } else if (text.startsWith(".relation")) {
    await relationCommand(sock, msg);
}

else if (text.startsWith(".mem")) {
    await memCommand(sock, msg);

} else if (

    text === ".shop" ||
    text.startsWith(".shop buy")

) {

    await shopCommands(sock, msg, text);

} else if (text === ".invite") {

    await inviteCommand(sock, msg);

} else if (text === ".daily") {

    await dailyCommand(sock, msg);

} else if (text.startsWith(".work")) {

    await workCommand(sock, msg, text);

} else if (text.startsWith(".bj")) {

    await blackjackCommand(sock, msg, text);

} else if (text === ".hit") {

    await hitCommand(sock, msg);

} else if (text === ".stand") {

    await standCommand(sock, msg);

} else if (text === ".double") {

    await doubleCommand(sock, msg);

} else if (

    text.startsWith(".importauction") ||
    text.startsWith(".auctionstart") ||
    text.startsWith(".auctionbid") ||
    text === ".auctionend" ||
    text.startsWith(".col") ||
    text.startsWith(".inv")

) {

    if (text.startsWith(".importauction")) {

        await importAuctionItem(sock, msg, text);

    } else if (text.startsWith(".auctionstart")) {

        await startAuction(sock, msg, text);

    } else if (text.startsWith(".auctionbid")) {

        await placeBid(sock, msg, text);

    } else if (text === ".auctionend") {

        await forceEndAuction(sock, msg);

    } else if (text.startsWith(".col")) {

        await viewCollection(sock, msg, text);

    } else if (text.startsWith(".inv")) {

        await viewInventory(sock, msg, text);

    }

} else if (text.startsWith(".use")) {

    await useLuckyCharm(sock, msg, text);

} else if (text.startsWith(".cs")) {

    await cardCommands(sock, msg, text);

} else if (text === ".crime") {

    await crimeCommand(sock, msg);

} else if (text.startsWith(".rob")) {

    await robCommand(sock, msg);

} else if (text === ".beg") {

    await begCommand(sock, msg);

} else if (text === ".fish") {

    await fishCommand(sock, msg);

} else if (text === ".dig") {

    await digCommand(sock, msg);

} else if (text === ".marryaccept") {

    await marryAcceptCommand(sock, msg);

} else if (text === ".marrydecline") {

    await marryDeclineCommand(sock, msg);

} else if (text === ".divorce") {

    await divorceCommand(sock, msg);

} else if (text.startsWith(".marry")) {

    await marryCommand(sock, msg);

} else if (text === ".rich") {

    await richCommand(sock, msg);

} else if (text === ".open") {

    await openGroup(sock, msg);

} else if (text === ".close") {

    await closeGroup(sock, msg);

} else if (text === ".mycds") {

    await myCooldownsCommand(sock, msg);

} else if (text === ".mydls") {

    await myDailyLimitsCommand(sock, msg);

} else if (text === ".menu") {

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            image: fs.readFileSync("./zorex.jpg"),
            caption: `
╔═⭓═══⭓═══⭓═╗
    ZOREX
ROY AI SYSTEM
╚═⭓═══⭓═══⭓═╝

𖤓 Prefix: .
𖤓 Owner: Lord Crimson
𖤓 Heir to Roy Trading Group

╭─═🤖 AI FEATURES 🤖═─╮
│ ✦ .ai
│ ✦ .ask
│ ✦ .chat
│ ✦ .image
╰────────────────────╯

╭─═🎮 GAMES 🎮═─╮
│ ✦ .wcg
│ ✦ .trivia
│ ✦ .ttt
╰────────────────────╯

╭─═💰 ECONOMY 💰═─╮
│ ✦ .register
│ ✦ .profile
│ ✦ .balance
│ ✦ .daily
│ ✦ .work
│ ✦ .shop
│ ✦ .crime
│ ✦ .rob
│ ✦ .beg
│ ✦ .fish
╰────────────────────╯

╭─═🏢 ROY EMPIRE 🏢═─╮
│ ✦ .company
│ ✦ .market
│ ✦ .stocks
│ ✦ .invest
│ ✦ .portfolio
│ ✦ .land
│ ✦ .assets
╰────────────────────╯

╭─═🎰 CASINO 🎰═─╮
│ ✦ .roulette
│ ✦ .slots
│ ✦ .coinflip
│ ✦ .blackjack
│ ✦ .aviator
╰────────────────────╯

╭─═📥 DOWNLOADER 📥═─╮
│ ✦ .yt
│ ✦ .vv
│ ✦ .ttk
│ ✦ .media
╰────────────────────╯

╭─═🛠 TOOLS 🛠═─╮
│ ✦ .sticker
│ ✦ .toimg
│ ✦ .tovid
│ ✦ .ping
│ ✦ .test
╰────────────────────╯

╭─═👤 PROFILE 👤═─╮
│ ✦ .profile
│ ✦ .age
│ ✦ .bio
│ ✦ .setage
│ ✦ .setbio
│ ✦ .rank
│ ✦ .leaderboard
╰────────────────────╯

╭─═📦 COLLECTION 📦═─╮
│ ✦ .col
│ ✦ .inv
│ ✦ .cs
╰────────────────────╯

╭─═👑 OWNER 👑═─╮
│ ✦ .owner
│ ✦ .restart
│ ✦ .broadcast
╰────────────────────╯

⚡ ZOREX AI
© ROY TRADING GROUP
`
        },
        {
            quoted: msg
        }
    );

    }

    });

}

startBot();