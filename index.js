require("dotenv").config();
// Prevent bot from crashing on unexpected errors
process.on("uncaughtException", (err) => {
    console.error("💥 UNCAUGHT EXCEPTION:", err);
});

let restarting = false;

process.on("unhandledRejection", (reason) => {
    console.error("💥 UNHANDLED REJECTION:", reason);
});

// Baileys 6.8+/7.x is ESM-only, so it can no longer be loaded with a plain
// require() from this CommonJS project. Instead we kick off a dynamic
// import() immediately below and populate these bindings once it resolves
// (see the bootstrap IIFE at the very bottom of this file, which awaits the
// import and only THEN calls startBot()). Everything else in this file is
// unchanged and still uses these as plain variables.
let makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser;

const qrcode = require("qrcode-terminal");
const readline = require("readline");
const fs = require("fs");
const { trackActivityAndMaybeSpawn } = require("./lib/activityTracker");

// PERSISTENCE FIX: routes owners.json / games.json / users.json through
// the same dataPath() helper used in commands/economy.js, so they persist
// on the attached Railway Volume instead of the container's ephemeral disk.
// See lib/dataPath.js.
const dataPath = require("./lib/dataPath");

const {
    economyCommands
} = require("./commands/economy");

const { shopCommands } = require("./commands/shop");
const { raffleCommand, startRaffleSweeper } = require("./commands/raffle");
const { inviteCommands } = require("./commands/invite");
const { minesCommands } = require("./commands/mines");
const { gambleCommands } = require("./commands/gamble");
const { groupCommands } = require("./commands/group");

const {
    moderationWatcher
} = require("./commands/moderation");

const {
    richCommand,
    openGroup,
    closeGroup,
    inviteCommand,
    myCooldownsCommand,
    myDailyLimitsCommand,
    isGroupAdmin
} = require("./commands/misc");

const {
    importAuctionItem,
    startAuction,
    placeBid,
    forceEndAuction,
    viewCollection,
    viewInventory,
    useLuckyCharm,
    auctionStatus,
    viewAuctionCards
} = require("./commands/auction");

const { crimeCommand } = require("./commands/crime");
const { robCommand } = require("./commands/rob");
const { begCommand } = require("./commands/beg");
const { fishCommand, sellCommand } = require("./commands/fish");
const { digCommand } = require("./commands/dig");

// .invest (buy/sell) / .assets — global market + personal portfolio
const {
    investCommand,
    assetsCommand,
    companyAssetsCommand
} = require("./commands/invest");

// Chloe (AI companion) — handleMessage decides on its own whether to reply.
// setBotJid lets us hand her the bot's real WhatsApp id once Baileys connects,
// since there is no reliable env var for it.
const { handleMessage: handleChloeMessage, setBotJid } = require("./commands/chloe");
const { memCommand } = require("./commands/mem");
const { relationCommand } = require("./commands/relation");

// School slide deck browser (.slides) and AI document summarizer (.teach) —
// both share course-folder lookup logic from lib/slidesHelper.js.
const { slidesCommand } = require("./commands/slides");
const { teachCommand } = require("./commands/teach");
const { deleteCommand } = require("./commands/delete");
const { antilinkCommand, setWarningsCommand, resetWarningsCommand, checkAntilink } = require("./commands/antilink");
const { hidetagCommand } = require("./commands/hidetag");

// Group-wide @everyone tag — doesn't require the bot to be an admin.
const { tagAllCommand } = require("./commands/tagall");

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

// Trivia game — triviaCommand starts/manages a round, triviaAnswer is fed
// EVERY incoming message (no prefix needed) so players can answer with a
// bare A / B / C / D. trivia.js owns its own per-group game state, so it is
// what actually prevents two rounds running at once in the same chat.
const { triviaCommand, triviaAnswer } = require("./commands/trivia");

// .restart — owners only. See commands/restart.js for why this must exit
// with a non-zero code for Railway's restart policy to bring it back up.
const { restartCommand } = require("./commands/restart");

// .commandoff / .commandon — owners/admins only, gates the whole command
// chain below (except itself). Permission checks live inside this module.
const { commandOffCommand, commandOnCommand, isCommandsOff } = require("./commands/commandoff");

// .trade / .tradeaccept / .tradedecline / .tradesell / .tradepay /
// .tradecancel / .tradeinfo — peer-to-peer escrow trading. tradeCommands()
// is the single router (see commands/trade.js), and startTradeSweeper()
// must be called exactly once after the socket connects so the 60s request
// timeout and 5-minute session-inactivity timeout get enforced in the
// background (see lib/tradeTimeouts.js).
const { aiCommand } = require("./commands/ai");
const { tradeCommands } = require("./commands/trade");
const { startTradeSweeper } = require("./lib/tradeTimeouts");

// .play / .yt / .ttk — media downloader commands. All Spotify/YouTube/
// TikTok specific logic lives in bet/providers/*.js; these command modules
// are pure orchestration + WhatsApp sending (see each file's header comment).
const { execute: playCommand } = require("./commands/play");
const { execute: ytCommand } = require("./commands/yt");
const { execute: spawnCommand } = require("./commands/spawn");
const { execute: claimCommand } = require("./commands/claim");
const { execute: cardToggleCommand } = require("./commands/cardoff");
const { giveCommand } = require("./commands/give");
const { addCardCommand } = require("./commands/addcard");
const { resetEconomyCommand } = require("./commands/reseteconomy");
const { removeCardCommand } = require("./commands/rcard");
// NOTE: this is the ONLY require("./commands/card") in the file — a
// duplicate of this line (a second, separate `const { cardCommands } =
// require("./commands/card")` further down) was what crashed the boot
// with "Identifier 'cardCommands' has already been declared". Do not
// re-add a second one.
const { cardCommands, cardLeaderboardCommand, seriesSearchCommand } = require("./commands/card");
const { cshopCommands } = require("./commands/cshop");
const { execute: ttkCommand } = require("./commands/ttk");
const { execute: mediaCommand } = require("./commands/media");
const { stickerCommands } = require("./commands/sticker");
const { afkCommand, handleAfkMessage } = require("./commands/afk");
const {
    setWelcomeCommand,
    setLeaveCommand,
    handleGroupParticipantsUpdate
} = require("./commands/greetings");
const { execute: hbCommand } = require("./commands/hb");
const { upscleCommands } = require("./commands/upscle");
const { graphicsCommands } = require("./commands/graphics");
const { broadcastCommand } = require("./commands/broadcast");
const { videoUpscaleCommands } = require('./commands/videoUpscale');
const {
    companyCommand,
    companyCreateCommand,
    companyUpgradeCommand,
    companyOfferCommand,
    companyOffersCommand,
    companyApproveCommand,
    companyHireCommand,
    companyEmployeesCommand,
    companyOverseeCommand,
    companyPromoteCommand
} = require("./commands/company");

const { portfolioCommand } =
    require("./commands/portfolio");

const {
    jobOffersCommand,
    jobApplyCommand,
    jobCommand,
    dutyCommand,
    jobInfoCommand,
    resumeMajorApplications,
    startMajorAttendanceMonitor,
    startJobResignationProcessor
} = require("./commands/jobs");

const {
    companyAdminCommand
} = require("./commands/companyAdmin");

const { MAIN_OWNER } = require("./config");
const OWNERS_FILE = dataPath("owners.json");

const {
    startWCG,
    joinWCG,
    handleWCGMessage,
    resumeWCG
} = require("./wcg");

const {
    startOwner
} = require("./commands/owner");

const {
    startVV
} = require("./vv");

const GAMES_FILE = dataPath("games.json");

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

// Owner list — MAIN_OWNER from config.js is always trusted; owners.json
// holds any additional owners added via .addowner (see commands/owner.js).
// Used to gate sensitive commands like .restart.
function loadOwners() {

    if (!fs.existsSync(OWNERS_FILE)) {
        fs.writeFileSync(OWNERS_FILE, "[]");
    }

    return JSON.parse(fs.readFileSync(OWNERS_FILE, "utf8"));

}

function isOwner(userId) {

    if (!userId) return false;

    const normalized = jidNormalizedUser(userId);

    if (MAIN_OWNER && normalized === jidNormalizedUser(MAIN_OWNER)) {
        return true;
    }

    const owners = loadOwners();

    return owners.some(owner => jidNormalizedUser(owner) === normalized);

}

// Owner always passes; otherwise the sender must be a real WhatsApp
// admin/superadmin of the group the command was sent in. Used to gate
// .commandon / .commandoff / .tagall. In a DM (no group) only the owner
// check applies, since there's no group admin concept there.
async function isOwnerOrAdmin(sock, msg) {

    const sender = msg.key.participant || msg.key.remoteJid;

    if (isOwner(sender)) return true;

    const groupId = msg.key.remoteJid;

    if (!groupId.endsWith("@g.us")) return false;

    return await isGroupAdmin(sock, groupId, sender);

}

const axios = require("axios");
const USERS_FILE = dataPath("users.json");
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


    // printQRInTerminal was removed in Baileys 7 (it's been a no-op/deprecated
    // for a while before that too). QR codes now only arrive via the `qr`
    // field on the "connection.update" event below, which we already handle
    // manually with qrcode-terminal, so no behavior is lost here.
    const sock = makeWASocket({
    auth: state,
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

                // Hand Chloe the bot's real JID(s) now that we're connected,
                // instead of relying on a BOT_JID env var that doesn't exist.
                // WhatsApp's LID system means @mentions and reply-participant
                // fields can come back in either the phone-number JID format
                // or the LID JID format — Chloe needs to recognize both.
                try {

                    const botJid = jidNormalizedUser(sock.user.id);
                    const botLid = sock.user.lid ? jidNormalizedUser(sock.user.lid) : null;

                    setBotJid([botJid, botLid]);

                    console.log("🤖 Chloe BOT_JIDs set to:", botJid, botLid);

                } catch (err) {

                    console.error("⚠️ Failed to set Chloe BOT_JID:", err.message);

                }

                // Start the trading system's timeout sweeper now that the
                // socket is live — it needs `sock` to send expiry/timeout
                // notices, and it must only ever be started once (guarded
                // internally in lib/tradeTimeouts.js against duplicate
                // calls, which matters here since "open" can theoretically
                // fire again after a reconnect).
                try {

                    startTradeSweeper(sock);

                    console.log("🔁 Trade timeout sweeper started.");

                    startRaffleSweeper(sock);

                    console.log("🎟️ Raffle expiry sweeper started.");

                } catch (err) {

                    console.error("⚠️ Failed to start trade sweeper:", err.message);

                }

                try {

    resumeMajorApplications(sock);
startMajorAttendanceMonitor(sock);
startJobResignationProcessor(sock);

    console.log("🏢 Major employment systems resumed.");

} catch (err) {

    console.error(
        "⚠️ Failed to start Major employment systems:",
        err.message
    );

}

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


    // Welcome / leave messages are driven by Baileys' participant-update
    // event, separate from normal chat messages.
    sock.ev.on("group-participants.update", async (update) => {
        try {
            await handleGroupParticipantsUpdate(sock, update);
        } catch (err) {
            console.error("⚠️ Group greeting error:", err.message);
        }
    });


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

        // Chloe gets first look at every live, non-history message — before any
        // prefix-command routing. handleMessage decides internally whether she
        // should actually reply (chaton/chatoff state, name mention, tag, reply,
        // or explicit ".chloe <msg>"), so this is always safe to call.
        // Chloe should never block command processing.
handleChloeMessage(sock, msg).catch(err => {
    console.error("⚠️ Chloe error:", err.message);
});

        await trackActivityAndMaybeSpawn(sock, msg);   // add this line

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

    console.log("Message:", text);

    // AFK is checked for every normal message so returning users are
    // automatically marked back, and tags/replies to AFK users get a notice.
    await handleAfkMessage(sock, msg, text);

    // Antilink watcher — must run after `text` exists. Deletes the message
    // and handles the warn/kick flow internally when a non-allowlisted
    // link is posted; returns true if it acted, so routing stops here.
    if (await checkAntilink(sock, msg, text)) return;

    // Trivia gets first shot at every message — before the command toggle
    // gate and before the big if/else chain — so players can answer with a
    // bare A / B / C / D and don't need the "." prefix. triviaAnswer() is a
    // no-op if there's no active round in this chat, so this is safe to call
    // unconditionally.
    await triviaAnswer(sock, msg, text);

    // Same idea for World Chain Game word submissions — a bare word, no
    // prefix. handleWCGMessage() is a no-op (returns false) if there's no
    // active WCG round in this chat, or if the sender isn't a player in it.
    // If it DID handle the message (a real turn attempt), stop here so the
    // word doesn't fall through into command routing below.
    if (await handleWCGMessage(sock, msg, text)) return;

    const chatId = msg.key.remoteJid;

    // While disabled, every prefixed command is ignored except the one
    // command that turns them back on.
    if (isCommandsOff(chatId) && text.startsWith(".") && text !== ".commandon") {
        return;
    }


    if (text === ".afk" || text.startsWith(".afk ")) {

        await afkCommand(sock, msg, text);

    } else if (text === ".setwelcome" || text.startsWith(".setwelcome ")) {

        await setWelcomeCommand(sock, msg, text);

    } else if (text === ".setleave" || text.startsWith(".setleave ")) {

        await setLeaveCommand(sock, msg, text);

    } else if (text === ".ping") {

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

    } else if (text === ".restart") {

    await restartCommand(sock, msg);

    } else if (text === ".commandoff") {

    await commandOffCommand(sock, msg);

    } else if (text === ".commandon") {

    await commandOnCommand(sock, msg);

    } else if (text.startsWith(".trivia")) {

    await triviaCommand(sock, msg, text);

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
╰━━━━━━━━━━━━━━━━━━━━━━━╮
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
╰━━━━━━━━━━━━━━━━━━━━━━━╮
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

    } else if (text.startsWith(".tagall")) {

    if (!(await isOwnerOrAdmin(sock, msg))) {

        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text: `❌ Only the owner or group admins can use this command.`
            },
            {
                quoted: msg
            }
        );

    }

    const tagallArgs = text.trim().split(/\s+/).slice(1);

    await tagAllCommand(sock, msg, tagallArgs);

    } else if (text === ".wcg start") {

    await startWCG(sock, msg);

} else if (text === ".wcg join") {

    await joinWCG(sock, msg);

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

} else if (text.startsWith(".hb")) {

    const args = text.split(" ").slice(1);

    await hbCommand(sock, msg, args);

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

} else if (text.startsWith(".ai")) {

    await aiCommand(sock, msg, text);

} else if (
    text === ".inviteowner" ||
    /^\d{4}$/.test(text)
) {

    await inviteCommands(
        sock,
        msg,
        text
    );

} else if (text === ".d") {

    await deleteCommand(sock, msg);

} else if (text.startsWith(".antilink")) {

    await antilinkCommand(sock, msg, text);

} else if (text.startsWith(".setwarnings")) {

    await setWarningsCommand(sock, msg, text);

} else if (text.startsWith(".resetwarnings")) {

    await resetWarningsCommand(sock, msg, text);

} else if (text.startsWith(".hidetag")) {

    await hidetagCommand(sock, msg, text);

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

} else if (text.startsWith(".broadcast")) {

    await broadcastCommand(sock, msg, text);

} else if (text === ".cardoff" || text === ".cardon") {

    const cardToggleArgs = text === ".cardon" ? ["on"] : [];
    await cardToggleCommand(sock, msg, cardToggleArgs);

} else if (text === ".cardlb") {

    await cardLeaderboardCommand(sock, msg);

    } else if (text.startsWith(".ss")) {

    await seriesSearchCommand(sock, msg, text);


} else if (text.startsWith(".trade")) {

    // Covers .trade, .tradeaccept, .tradedecline, .tradesell,
    // .tradepay, .tradecancel, .tradeinfo — see commands/trade.js
    // for the internal sub-command routing.
    await tradeCommands(
        sock,
        msg,
        text
    );

} else if (

    text.startsWith(".gamble") ||
    text.startsWith(".cf") ||
    text.startsWith(".casino") ||
    text.startsWith(".dice") ||
    text.startsWith(".aviator") ||
    text.startsWith(".slots") ||
    text.startsWith(".roulette") ||
    text.startsWith(".poker")

    // Note: ".mines" was previously listed here too, duplicating the mines
    // block above (that earlier branch always won, so this was dead code).
    // Removed to avoid the duplicate route.

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

} else if (text === ".raffle" || text.startsWith(".raffle ")) {

    await raffleCommand(sock, msg, text);

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

} else if (text.startsWith(".companycreate")) {

    await companyCreateCommand(sock, msg, text);

} else if (text.startsWith(".companyupgrade")) {

    await companyUpgradeCommand(sock, msg);

} else if (text.startsWith(".companyoffers")) {

    await companyOffersCommand(sock, msg);

} else if (text.startsWith(".companyoffer")) {

    await companyOfferCommand(sock, msg, text);

} else if (text.startsWith(".companyapprove")) {

    await companyApproveCommand(sock, msg, text);

} else if (text.startsWith(".hire")) {

    await companyHireCommand(sock, msg, text);

} else if (text.startsWith(".employees")) {

    await companyEmployeesCommand(sock, msg, text);

} else if (text.startsWith(".oversee")) {

    await companyOverseeCommand(sock, msg, text);

} else if (text.startsWith(".companypromote")) {

    await companyPromoteCommand(sock, msg, text);

// FIX: .company was previously only reachable from INSIDE the
// .auction/.col/.inv block below, whose own outer `else if` condition
// never tested for ".company" — so typing .company never even entered
// that block, and the inner "if (text === '.company' ...)" check inside
// it was dead code. Moved here as its own clean top-level branch,
// alongside the other .company* commands, and removed from inside the
// auction block (see the comment there).
} else if (text === ".company" || text.startsWith(".company ")) {

    await companyCommand(sock, msg, text);

    } else if (
    text === ".portfolio" ||
    text.startsWith(".portfolio ")
) {

    await portfolioCommand(sock, msg);

    } else if (text === ".duty") {

    await dutyCommand(sock, msg);

} else if (text === ".joboffers") {

    await jobOffersCommand(sock, msg);

} else if (text.startsWith(".jobapply")) {

    await jobApplyCommand(sock, msg, text);

} else if (
    text === ".job" ||
    text.startsWith(".job ")
) {
    await jobCommand(sock, msg, text);

} else if (
    text === ".jobinfo" ||
    text.startsWith(".jobinfo ")
) {

    await jobInfoCommand(sock, msg, text);

   } else if (text === ".enhance" || text === ".fix" || text === ".fixquality") {

    await upscleCommands(sock, msg, text);

} else if (text.startsWith(".fix ") || text.startsWith(".graph") || text === ".silhouette") {

    await graphicsCommands(sock, msg, text);

} else if (text.startsWith('.upscale') || text.startsWith('.fps') || text.startsWith('.bitrate')) {
    return await videoUpscaleCommands(sock, msg, text);

} else if (
    text === ".fire" ||
    text.startsWith(".fire ")
) {

    await companyAdminCommand(
        sock,
        msg,
        text
    );

} else if (
    text === ".fixcompany" ||
    text.startsWith(".fixcompany ")
) {

    await companyAdminCommand(
        sock,
        msg,
        text
    );


} else if (text.startsWith(".reseteconomy")) {

    await resetEconomyCommand(sock, msg, text);

} else if (
    text === ".yes" ||
    text === ".no"
) {

    const handled =
        await companyAdminCommand(
            sock,
            msg,
            text
        );

    if (!handled) {
        await resetEconomyCommand(
            sock,
            msg,
            text
        );
    }

} else if (text.startsWith(".sell")) {

    await sellCommand(sock, msg, text);

// Checked here, before the ".inv" auction/inventory block below, since
// ".invest" also starts with ".inv" and would otherwise be swallowed by
// that check first.
} else if (text === ".invest" || text.startsWith(".invest ")) {

    await investCommand(sock, msg, text);

} else if (text === ".assets") {

    await assetsCommand(sock, msg);

} else if (text === ".companyassets") {

    await companyAssetsCommand(sock, msg);

} else if (

    text === ".auction" ||
    text.startsWith(".auctioncards") ||
    text.startsWith(".importauction") ||
    text.startsWith(".auctionstart") ||
    text.startsWith(".auctionbid") ||
    text === ".auctionend" ||
    text.startsWith(".col") ||
    text.startsWith(".inv")

) {

    if (text === ".auction") {

        await auctionStatus(sock, msg);

    // FIX: the ".company" branch that used to live here has been removed.
    // Its outer `else if` above (the block this comment sits inside) never
    // tested for ".company"/".company ", so this inner check could never
    // actually be reached — see the new top-level ".company" branch added
    // earlier in the chain, right after .companypromote, which is now the
    // real route for .company.

    } else if (text.startsWith(".auctioncards")) {

        await viewAuctionCards(sock, msg);

    } else if (text.startsWith(".importauction")) {

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

} else if (text.startsWith(".addcard")) {

    await addCardCommand(sock, msg, text);

} else if (text.startsWith(".rcard")) {

    await removeCardCommand(sock, msg, text);

} else if (
    text === ".cshop" ||
    text.startsWith(".cshop ")
) {

    await cshopCommands(sock, msg, text);

} else if (
    text === ".cs" ||
    text.startsWith(".cs ")
) {

    await cardCommands(sock, msg, text);

} else if (text.startsWith(".teach")) {

    await teachCommand(sock, msg, text);

} else if (text.startsWith(".slides")) {

    await slidesCommand(sock, msg, text);

} else if (text === ".crime") {

    await crimeCommand(sock, msg);

} else if (text.startsWith(".rob")) {

    await robCommand(sock, msg);

} else if (text.startsWith(".spawn")) {

    const args = text.trim().split(/\s+/).slice(1);
    await spawnCommand(sock, msg, args);

} else if (text.startsWith(".claim")) {

    const args = text.trim().split(/\s+/).slice(1);
    await claimCommand(sock, msg, args);

} else if (text.startsWith(".give")) {

    await giveCommand(sock, msg, text);

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

} else if (text.startsWith(".play")) {

    const playArgs = text.split(" ").slice(1);
    await playCommand(sock, msg, playArgs);

} else if (text.startsWith(".yt")) {

    const ytArgs = text.split(" ").slice(1);
    await ytCommand(sock, msg, ytArgs);

} else if (text.startsWith(".ttk")) {

    const ttkArgs = text.split(" ").slice(1);
    await ttkCommand(sock, msg, ttkArgs);

} else if (text === ".media" || text.startsWith(".media ")) {

    const mediaArgs = text.split(" ").slice(1);
    await mediaCommand(sock, msg, mediaArgs);

} else if (
    text === ".sticker" ||
    text === ".toimage" ||
    text === ".toimg" ||
    text === ".tovid"
) {

    await stickerCommands(sock, msg, text);

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

📚 Full command menu below ↓
👑 Owner only
🔱 Main owner only
`
        },
        {
            quoted: msg
        }
    );

    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: `📚 *ZOREX COMMAND MENU*

╭─═🤖 AI & CHLOE 🤖═─╮
│ ✦ .ai
│ ✦ .relation
│ ✦ .mem
╰────────────────────╯

╭─═🎮 GAMES 🎮═─╮
│ ✦ .wcg start
│ ✦ .wcg join
│ ✦ .trivia
│ ✦ .ttt @user
╰────────────────────╯

╭─═💰 ECONOMY 💰═─╮
│ ✦ .register
│ ✦ .profile
│ ✦ .bal
│ ✦ .dep
│ ✦ .wd
│ ✦ .donate
│ ✦ .daily
│ ✦ .work
│ ✦ .shop
│ ✦ .crime
│ ✦ .rob
│ ✦ .beg
│ ✦ .fish
│ ✦ .sell
│ ✦ .dig
│ ✦ .rich
╰────────────────────╯

╭─═👤 PROFILE 👤═─╮
│ ✦ .age
│ ✦ .bio
│ ✦ .setage
│ ✦ .setbio
╰────────────────────╯

╭─═📈 INVESTMENTS 📈═─╮
│ ✦ .invest
│ ✦ .portfolio
│ ✦ .assets
╰────────────────────╯

╭─═🏢 COMPANY 🏢═─╮
│ ✦ .company
│ ✦ .companycreate
│ ✦ .companyupgrade
│ ✦ .company deposit
│ ✦ .company distribute
│ ✦ .company assign
│ ✦ .company promote
│ ✦ .companyoffers
│ ✦ .companyoffer
│ ✦ .companyapprove
│ ✦ .company disapprove
│ ✦ .hire
│ ✦ .employees
│ ✦ .oversee
│ ✦ .fire
│ ✦ .companyassets
╰────────────────────╯

╭─═💼 JOBS 💼═─╮
│ ✦ .joboffers
│ ✦ .jobapply
│ ✦ .job
│ ✦ .jobinfo
│ ✦ .duty
╰────────────────────╯

╭─═🎴 CARDS 🎴═─╮
│ ✦ .ss
│ ✦ .cshop
│ ✦ .cs
│ ✦ .col
│ ✦ .inv
│ ✦ .claim
│ ✦ .give
│ ✦ .cardlb
│ ✦ .use
╰────────────────────╯

╭─═🔨 AUCTION 🔨═─╮
│ ✦ .auction
│ ✦ .auctionbid
│ ✦ .auctioncards
│ 👑 .importauction
│ 👑 .auctionstart
│ 👑 .auctionend
╰────────────────────╯

╭─═🎰 CASINO 🎰═─╮
│ ✦ .gamble
│ ✦ .cf
│ ✦ .dice
│ ✦ .aviator
│ ✦ .slots
│ ✦ .roulette
│ ✦ .poker
│ ✦ .bj
│ ✦ .hit
│ ✦ .stand
│ ✦ .double
│ ✦ .mines
│ ✦ .shovel
│ ✦ .cashout
│ ✦ .raffle
╰────────────────────╯

╭─═📥 DOWNLOADER 📥═─╮
│ ✦ .play
│ ✦ .yt
│ ✦ .vv
│ ✦ .ttk
│ ✦ .media
╰────────────────────╯

╭─═🖼️ MEDIA TOOLS 🖼️═─╮
│ ✦ .enhance
│ ✦ .fix
│ ✦ .fix brightness
│ ✦ .fix saturation
│ ✦ .fix denoise
│ ✦ .graph
│ ✦ .silhouette
│ ✦ .upscale
│ ✦ .fps
│ ✦ .bitrate
│ ✦ .sticker
│ ✦ .toimage / .toimg
│ ✦ .tovid
╰────────────────────╯

╭─═👥 GROUP TOOLS 👥═─╮
│ ✦ .afk
│ ✦ .tagall
│ ✦ .hidetag
│ ✦ .antilink
│ ✦ .setwarnings
│ ✦ .resetwarnings
│ ✦ .mute
│ ✦ .unmute
│ ✦ .promote
│ ✦ .demote
│ ✦ .kick
│ ✦ .open
│ ✦ .close
│ ✦ .setwelcome
│ ✦ .setleave
│ ✦ .invite
╰────────────────────╯

╭─═💍 SOCIAL 💍═─╮
│ ✦ .marry
│ ✦ .marryaccept
│ ✦ .marrydecline
│ ✦ .divorce
╰────────────────────╯

╭─═📖 SCHOOL 📖═─╮
│ ✦ .slides
│ ✦ .teach
╰────────────────────╯

╭─═🛠 UTILITIES 🛠═─╮
│ ✦ .ping
│ ✦ .test
│ ✦ .owner
│ ✦ .mycds
│ ✦ .mydls
│ ✦ .d
╰────────────────────╯

╭─═👑 OWNER COMMANDS 👑═─╮
│ 👑 .restart
│ 👑 .commandoff
│ 👑 .commandon
│ 👑 .cardoff
│ 👑 .cardon
│ 👑 .setrole
│ 👑 .addcrescent
│ 👑 .spawn
│ 👑 .addcard
│ 👑 .rcard
│ 👑 .fixcompany
╰────────────────────╯

╭─═🔱 MAIN OWNER 🔱═─╮
│ 🔱 .broadcast
│ 🔱 .removecrescent
│ 🔱 .addowner
│ 🔱 .removeowner
│ 🔱 .resetcd
│ 🔱 .resetdl
│ 🔱 .resetbal
│ 🔱 .reseteconomy
│ 🔱 .hb
╰────────────────────╯

⚡ ZOREX AI
© ROY TRADING GROUP`
        },
        {
            quoted: msg
        }
    );

    }

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

    });

}

// Bootstrap: Baileys 7.x ships as ESM-only, so it can't be require()'d from
// this CommonJS project. We dynamic-import() it once here, populate the
// module-scoped bindings declared at the top of this file, and only then
// start the bot. This is the officially recommended way to consume an
// ESM-only package from CommonJS without converting the whole project.
(async () => {

    ({
        default: makeWASocket,
        useMultiFileAuthState,
        DisconnectReason,
        jidNormalizedUser
    } = await import("@whiskeysockets/baileys"));

    startBot();

})();