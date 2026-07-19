const fs = require("fs");
const path = require("path");

// ======================================
// ZOREX MINES CONFIG
// ======================================

const BOARD_SIZE = 5;
const TOTAL_TILES = 25;

const MIN_MINES = 1;
const MAX_MINES = 24;

const MIN_BET = 100;
const MAX_BET = 1000000;

const HIDDEN = "⬜";
const SAFE = "🟩";
const MINE = "💣";
const BOOM = "💥";

// ======================================
// FILE PATHS
// ======================================

const USERS_FILE = "./users.json";
const MINES_FILE = "./mines.json";

// ======================================
// JSON HELPERS
// ======================================

function ensureJSON(file) {

    if (!fs.existsSync(file)) {

        fs.writeFileSync(
            file,
            "{}"
        );

    }

}

ensureJSON(USERS_FILE);
ensureJSON(MINES_FILE);

function loadUsers() {

    return JSON.parse(
        fs.readFileSync(
            USERS_FILE,
            "utf8"
        )
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

function loadMines() {

    return JSON.parse(
        fs.readFileSync(
            MINES_FILE,
            "utf8"
        )
    );

}

function saveMines(data) {

    fs.writeFileSync(
        MINES_FILE,
        JSON.stringify(
            data,
            null,
            4
        )
    );

}

// ======================================
// FINAL MULTIPLIERS
// ======================================

const FINAL_MULTIPLIERS = {

    1: 10,
    2: 14,
    3: 18,
    4: 22,
    5: 26.67,
    6: 30,
    7: 34,
    8: 38,
    9: 42,
    10: 46,
    11: 50,
    12: 54,
    13: 58,
    14: 62,
    15: 66,
    16: 70,
    17: 74,
    18: 78,
    19: 82,
    20: 86,
    21: 90,
    22: 94,
    23: 97,
    24: 100

};

// ======================================
// TILE HELPERS
// ======================================

const LETTERS = [

    "A",
    "B",
    "C",
    "D",
    "E"

];

function tileToPosition(tile) {

    tile = tile.trim().toUpperCase();

    if (!/^[A-E][1-5]$/.test(tile)) {

        return null;

    }

    const row =
        LETTERS.indexOf(
            tile[0]
        );

    const col =
        Number(
            tile[1]
        ) - 1;

    return {

        row,
        col

    };

}

// ======================================
// BOARD GENERATION
// ======================================

function createBoard() {

    return Array.from(
        {
            length: BOARD_SIZE
        },
        () =>
            Array.from(
                {
                    length: BOARD_SIZE
                },
                () => ({
                    mine: false,
                    revealed: false,
                    adjacent: 0
                })
            )
    );

}

function randomPosition() {

    return {

        row: Math.floor(
            Math.random() * BOARD_SIZE
        ),

        col: Math.floor(
            Math.random() * BOARD_SIZE
        )

    };

}

function placeMines(board, mineCount) {

    let placed = 0;

    while (placed < mineCount) {

        const {

            row,
            col

        } = randomPosition();

        if (board[row][col].mine)
            continue;

        board[row][col].mine = true;

        placed++;

    }

}

function calculateAdjacents(board) {

    for (

        let row = 0;

        row < BOARD_SIZE;

        row++

    ) {

        for (

            let col = 0;

            col < BOARD_SIZE;

            col++

        ) {

            if (

                board[row][col].mine

            ) continue;

            let mines = 0;

            for (

                let r = row - 1;

                r <= row + 1;

                r++

            ) {

                for (

                    let c = col - 1;

                    c <= col + 1;

                    c++

                ) {

                    if (

                        r < 0 ||

                        r >= BOARD_SIZE ||

                        c < 0 ||

                        c >= BOARD_SIZE

                    ) continue;

                    if (

                        r === row &&

                        c === col

                    ) continue;

                    if (

                        board[r][c].mine

                    ) {

                        mines++;

                    }

                }

            }

            board[row][col].adjacent = mines;

        }

    }

}

function generateBoard(mineCount) {

    const board = createBoard();

    placeMines(
        board,
        mineCount
    );

    calculateAdjacents(board);

    return board;

}

// ======================================
// GAME HELPERS
// ======================================

function revealedSafeTiles(board) {

    let total = 0;

    for (const row of board) {

        for (const tile of row) {

            if (

                tile.revealed &&

                !tile.mine

            ) {

                total++;

            }

        }

    }

    return total;

}

function totalSafeTiles(board) {

    let total = 0;

    for (const row of board) {

        for (const tile of row) {

            if (!tile.mine) {

                total++;

            }

        }

    }

    return total;

}

function playerWon(board) {

    return (

        revealedSafeTiles(board) ===

        totalSafeTiles(board)

    );

}

// ======================================
// MULTIPLIER ENGINE
// ======================================

function getMultiplier(mines, safeOpened) {

    if (safeOpened <= 0) {

        return 1;

    }

    const safeTiles =
        TOTAL_TILES - mines;

    const finalMultiplier =
        FINAL_MULTIPLIERS[mines];

    const step =
        Math.pow(
            finalMultiplier,
            1 / safeTiles
        );

    const multiplier =
        Math.pow(
            step,
            safeOpened
        );

    return Number(
        multiplier.toFixed(2)
    );

}

// ======================================
// BOARD RENDERER
// ======================================

const NUMBER_EMOJIS = [

    SAFE,

    "1️⃣",
    "2️⃣",
    "3️⃣",
    "4️⃣",
    "5️⃣",
    "6️⃣",
    "7️⃣",
    "8️⃣"

];

function renderBoard(
    board,
    revealAll = false,
    exploded = null
) {

    let output = "";

    for (

        let row = 0;

        row < BOARD_SIZE;

        row++

    ) {

        for (

            let col = 0;

            col < BOARD_SIZE;

            col++

        ) {

            const tile =
                board[row][col];

            // Exploded mine
            if (

                exploded &&

                exploded.row === row &&

                exploded.col === col

            ) {

                output += BOOM + " ";

                continue;

            }

            // Reveal entire board
            if (revealAll) {

                if (tile.mine) {

                    output += MINE + " ";

                }

                else {

                    output +=
                        NUMBER_EMOJIS[
                            tile.adjacent
                        ] + " ";

                }

                continue;

            }

            // Hidden tile
            if (!tile.revealed) {

                output += HIDDEN + " ";

                continue;

            }

            // Revealed safe tile
            output +=
                NUMBER_EMOJIS[
                    tile.adjacent
                ] + " ";

        }

        output += "\n";

    }

    return output.trim();

}

// ======================================
// GAME OBJECT
// ======================================

function createGame(
    userId,
    bet,
    mines
) {

    const board =
        generateBoard(
            mines
        );


    const mineLocations = [];


    for (

        let row = 0;

        row < BOARD_SIZE;

        row++

    ) {

        for (

            let col = 0;

            col < BOARD_SIZE;

            col++

        ) {

            if (

                board[row][col].mine

            ) {

                mineLocations.push({

                    row,

                    col

                });

            }

        }

    }


    return {

        // Player
        userId,


        // Bet information
        bet,

        mines,


        // Board data
        board,


        // Mine tracking
        mineLocations,


        // Progress
        safeOpened: 0,

        safeRemaining:
            TOTAL_TILES - mines,


        // Reward
        multiplier: 1,


        // Time
        startedAt:
            Date.now()

    };

}

// ======================================
// SESSION HELPERS
// ======================================

function updateMultiplier(game) {

    game.multiplier =
        getMultiplier(

            game.mines,

            game.safeOpened

        );

}

// ======================================
// CASHOUT CALCULATION
// ======================================

function currentCashout(game) {

    const amount =
        game.bet *
        game.multiplier;


    return Math.floor(amount);

}

// ======================================
// .MINES
// ======================================

async function minesCommand(sock, msg, text) {

    const from = msg.key.remoteJid;
    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const users = loadUsers();
    const sessions = loadMines();

    // ==========================
    // HELP MENU
    // ==========================

    if (text.trim() === ".mines") {

        return await sock.sendMessage(
            from,
            {
                text:
`💣 *WELCOME TO ZOREX MINES*

*Risk Everything. Cash Out Anytime.*

Uncover safe tiles, avoid hidden mines, and cash out before you hit a mine.

━━━━━━━━━━━━━━

🎮 *Start a Game*

Use:
.mines <mines> <bet>

Example:
.mines 5 10000

━━━━━━━━━━━━━━

⛏️ *Reveal a Tile*

Use:
.shovel <tile_ID>

📍 *Available Tiles*

A1  A2  A3  A4  A5
B1  B2  B3  B4  B5
C1  C2  C3  C4  C5
D1  D2  D3  D4  D5
E1  E2  E3  E4  E5

━━━━━━━━━━━━━━

💰 *Cash Out*

Use:
.cashout

Cash out anytime to secure your winnings before uncovering a mine.

🍀 Good luck!`
            },
            {
                quoted: msg
            }
        );

    }

    // ==========================
    // ACTIVE GAME CHECK
    // ==========================

    if (sessions[sender]) {

        return await sock.sendMessage(
            from,
            {
                text:
`❌ You already have an active Mines game.

Use:

.shovel <tile_ID>

or

.cashout`
            },
            {
                quoted: msg
            }
        );

    }

    // ==========================
    // ARGUMENTS
    // ==========================

    const args =
        text
        .trim()
        .split(/\s+/);

    const mineCount = Number(args[1]);
    const bet = Number(args[2]);

    // ======================================
    // MINES WELCOME PAGE
    // ======================================

    if (args.length === 1) {

        return await sock.sendMessage(
            from,
            {
                text:
`💣 *ZOREX MINES*

Welcome to Zorex Mines.

Use:

.mines <mines> <bet>

Example:

.mines 5 10000


After joining:

Use:

.shovel <tile_ID>

to uncover a tile.


Available Tiles:

A1 A2 A3 A4 A5
B1 B2 B3 B4 B5
C1 C2 C3 C4 C5
D1 D2 D3 D4 D5
E1 E2 E3 E4 E5


.cashout to cashout your winnings.`
            },
            {
                quoted: msg
            }
        );

    }


    // ======================================
    // INVALID FORMAT
    // ======================================

    if (args.length !== 3) {

        return await sock.sendMessage(
            from,
            {
                text:
`❌ Invalid format.

Use:

.mines <mines> <bet>

Example:

.mines 5 10000`
            },
            {
                quoted: msg
            }
        );

    }

    // ==========================
    // PROFILE CHECK
    // ==========================

    if (!users[sender]) {

        return await sock.sendMessage(
            from,
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

    // ==========================
    // VALIDATE MINES
    // ==========================

    if (

        isNaN(mineCount) ||

        mineCount < MIN_MINES ||

        mineCount > MAX_MINES

    ) {

        return await sock.sendMessage(
            from,
            {
                text:
`❌ Mine count must be between ${MIN_MINES} and ${MAX_MINES}.`
            },
            {
                quoted: msg
            }
        );

    }

    // ==========================
    // VALIDATE BET
    // ==========================

    if (

        isNaN(bet) ||

        bet < MIN_BET ||

        bet > MAX_BET

    ) {

        return await sock.sendMessage(
            from,
            {
                text:
`❌ Bet amount must be between

${MIN_BET.toLocaleString()}
and
${MAX_BET.toLocaleString()} 🌙`
            },
            {
                quoted: msg
            }
        );

    }

    // ==========================
    // WALLET CHECK
    // ==========================

    if (

        users[sender].wallet < bet

    ) {

        return await sock.sendMessage(
            from,
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

    // ==========================
    // DEDUCT BET
    // ==========================

    users[sender].wallet -= bet;

    saveUsers(users);

    // ==========================
    // CREATE GAME
    // ==========================

    const game =
        createGame(
            sender,
            bet,
            mineCount
        );

    sessions[sender] = game;

    saveMines(sessions);

    // ==========================
    // SEND BOARD
    // ==========================

    return await sock.sendMessage(
        from,
        {
            text:
`💣 *ZOREX MINES*

${renderBoard(game.board)}

💰 Bet: ${bet.toLocaleString()} 🌙
💣 Mines: ${mineCount}
📈 Multiplier: x1.00
💵 Cashout: ${bet.toLocaleString()} 🌙

🎯 Choose a tile.

Use:
.shovel <tile_ID>

or
.cashout to cash out your winnings`
        },
        {
            quoted: msg
        }
    );

}

// ======================================
// .SHOVEL
// ======================================

async function shovelCommand(sock, msg, text) {

    const from = msg.key.remoteJid;
    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const sessions = loadMines();
    const users = loadUsers();

    if (!sessions[sender]) {

        return await sock.sendMessage(
            from,
            {
                text:
`❌ You don't have an active Mines game.

Start one with:

.mines`
            },
            {
                quoted: msg
            }
        );

    }

    const args =
        text
        .trim()
        .split(/\s+/);

    if (args.length !== 2) {

        return await sock.sendMessage(
            from,
            {
                text:
`❌ Usage

.shovel <tile_ID>

Use .mines to see available tiles.`
            },
            {
                quoted: msg
            }
        );

    }

    const tile =
        args[1]
            .trim()
            .toUpperCase();

    const position =
        tileToPosition(tile);

    if (!position) {

        return await sock.sendMessage(
            from,
            {
                text:
`❌ Invalid tile.

Use .mines to see available tiles.`
            },
            {
                quoted: msg
            }
        );

    }

    const game =
        sessions[sender];

    const board =
        game.board;

    const row =
        position.row;

    const col =
        position.col;

    if (board[row][col].revealed) {

        return await sock.sendMessage(
            from,
            {
                text:
`⚠️ That tile has already been revealed.

Choose another tile.`
            },
            {
                quoted: msg
            }
        );

    }


    // ==========================
    // PLAYER HIT A MINE
    // ==========================

    if (board[row][col].mine) {

        delete sessions[sender];

        saveMines(sessions);

        return await sock.sendMessage(
            from,
            {
                text:
`💥 *BOOM!*

${renderBoard(
    board,
    true,
    {
        row,
        col
    }
)}

💣 Mine Triggered

${tile}

💸 Bet Lost

${game.bet.toLocaleString()} 🌙

📈 Multiplier Lost

x${game.multiplier.toFixed(2)}

Better luck next time!`
            },
            {
                quoted: msg
            }
        );

    }


    // ==========================
    // SAFE TILE REVEAL
    // ==========================

    board[row][col].revealed = true;

    // ==========================
    // SAFE TILE
    // ==========================

    game.safeOpened++;

    game.safeRemaining--;

    updateMultiplier(game);

    sessions[sender] = game;

    saveMines(sessions);

    const cashout =
        currentCashout(game);

    // ==========================
    // PERFECT CLEAR
    // ==========================

    if (playerWon(board)) {

        users[sender].wallet += cashout;

        saveUsers(users);

        delete sessions[sender];

        saveMines(sessions);

        return await sock.sendMessage(
            from,
            {
                text:
`🏆 *PERFECT CLEAR!*

${renderBoard(
    board,
    true
)}

You found every safe tile!

📈 Final Multiplier

x${game.multiplier.toFixed(2)}

💰 Reward

${cashout.toLocaleString()} 🌙

Wallet Updated Successfully.`
            },
            {
                quoted: msg
            }
        );

    }

    // ==========================
    // CONTINUE GAME
    // ==========================

    return await sock.sendMessage(
        from,
        {
            text:
`💣 *ZOREX MINES*

${renderBoard(board)}

📈 Current Multiplier

x${game.multiplier.toFixed(2)}

💰 Potential Cashout

${cashout.toLocaleString()} 🌙

Choose another tile.

Use:

.shovel <tile_ID>

or

.cashout`
        },
        {
            quoted: msg
        }
    );

}

// ======================================
// .CASHOUT
// ======================================

async function cashoutCommand(sock, msg) {

    const from =
        msg.key.remoteJid;

    const sender =
        msg.key.participant ||
        msg.key.remoteJid;

    const sessions =
        loadMines();

    const users =
        loadUsers();

    if (!sessions[sender]) {

        return await sock.sendMessage(
            from,
            {
                text:
`❌ You don't have an active Mines game.

Start one with:

.mines`
            },
            {
                quoted: msg
            }
        );

    }

    const game =
        sessions[sender];

    const winnings =
        currentCashout(game);

    users[sender].wallet += winnings;

    saveUsers(users);

    delete sessions[sender];

    saveMines(sessions);

    return await sock.sendMessage(
        from,
        {
            text:
`💰 *MINES CASHOUT SUCCESS*

${renderBoard(
    game.board,
    true
)}

💰 Bet

${game.bet.toLocaleString()} 🌙

📈 Final Multiplier

x${game.multiplier.toFixed(2)}

🏆 Won

${winnings.toLocaleString()} 🌙

👛 Wallet

${users[sender].wallet.toLocaleString()} 🌙

🎉 Tactical Extraction Complete!`
        },
        {
            quoted: msg
        }
    );

}

// ======================================
// COMMAND ROUTER
// ======================================

async function minesCommands(
    sock,
    msg,
    text
) {

    if (
        text.startsWith(".mines")
    ) {

        return await minesCommand(
            sock,
            msg,
            text
        );

    }

    if (
        text.startsWith(".shovel")
    ) {

        return await shovelCommand(
            sock,
            msg,
            text
        );

    }

    if (
        text === ".cashout"
    ) {

        return await cashoutCommand(
            sock,
            msg
        );

    }

}

// ======================================
// EXPORTS
// ======================================

module.exports = {

    minesCommands

};