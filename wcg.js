const fs = require("fs");
const { isValidWord } = require("./words");

const WCG_FILE = "./wcg.json";

const JOIN_TIME_MS = 60000;  // time allowed to join before the game auto-starts
const TURN_TIME_MS = 20000;  // time allowed per turn

function loadWCG() {
    if (!fs.existsSync(WCG_FILE)) fs.writeFileSync(WCG_FILE, "{}");
    return JSON.parse(fs.readFileSync(WCG_FILE, "utf8"));
}

function saveWCG(data) {
    fs.writeFileSync(WCG_FILE, JSON.stringify(data, null, 4));
}

function randomLetter() {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    return letters[Math.floor(Math.random() * letters.length)];
}

// ---------- .wcg start ----------
async function startWCG(sock, msg) {

    if (!msg.key.remoteJid.endsWith("@g.us")) {
        return await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ World Chain Game can only be started inside a group.`
        }, { quoted: msg });
    }

    const userId = msg.key.participant || msg.key.remoteJid;
    const groupId = msg.key.remoteJid;
    const wcg = loadWCG();

    if (wcg[groupId] && (wcg[groupId].status === "waiting" || wcg[groupId].status === "active")) {
        return await sock.sendMessage(groupId, {
            text: `⚠️ A World Chain Game is already running.\n\nUse:\n\n.wcg join`
        }, { quoted: msg });
    }

    const group = await sock.groupMetadata(groupId);
    const everyone = group.participants.map(m => m.id);

    wcg[groupId] = {
        status: "waiting",
        host: userId,
        players: [userId],
        group: groupId,
        turn: null,
        lastLetter: null,
        usedWords: [],
        createdAt: Date.now(),
        joinDeadline: Date.now() + JOIN_TIME_MS,   // persisted so a restart can recover
        turnDeadline: null
    };

    saveWCG(wcg);

    await sock.sendMessage(groupId, {
        text: `🌍🎮 *ZOREX WORLD CHAIN GAME STARTED!*\n\n👑 Host:\n@${userId.split("@")[0]}\n\nEveryone is invited!\n\nType:\n\n.wcg join\n\nto participate.\n\n⏳ Joining closes in 60 seconds.`,
        mentions: everyone
    }, { quoted: msg });

    setTimeout(async () => {
        await beginRound(sock, groupId);
    }, JOIN_TIME_MS);
}

// ---------- .wcg join ----------
async function joinWCG(sock, msg) {

    const groupId = msg.key.remoteJid;
    const userId = msg.key.participant || msg.key.remoteJid;

    const wcg = loadWCG();
    const game = wcg[groupId];

    if (!game) {
        return await sock.sendMessage(groupId, {
            text: `⚠️ There is no active World Chain Game.\n\nUse:\n\n.wcg start\n\nto create one.`
        }, { quoted: msg });
    }

    if (game.status !== "waiting") {
        return await sock.sendMessage(groupId, {
            text: `⚠️ Joining has closed.\n\nThe World Chain Game has already started.`
        }, { quoted: msg });
    }

    if (game.players.includes(userId)) {
        return await sock.sendMessage(groupId, {
            text: `😂 You are already in the World Chain Game!`
        }, { quoted: msg });
    }

    game.players.push(userId);
    saveWCG(wcg);

    await sock.sendMessage(groupId, {
        text: `🌍🎮 *WORLD CHAIN GAME*\n\n👤 @${userId.split("@")[0]} joined the game!\n\nCurrent Players:\n\n${game.players.map((p, i) => `${i + 1}. @${p.split("@")[0]}`).join("\n")}\n\n⏳ Waiting for game start...`,
        mentions: game.players
    }, { quoted: msg });
}

// ---------- Fires automatically once the join window closes ----------
async function beginRound(sock, groupId) {

    const wcg = loadWCG();
    const game = wcg[groupId];

    if (!game || game.status !== "waiting") return;

    if (game.players.length < 2) {
        delete wcg[groupId];
        saveWCG(wcg);

        return await sock.sendMessage(groupId, {
            text: `⚠️ *World Chain Game cancelled.*\n\nNot enough players joined (need at least 2).`
        });
    }

    game.status = "active";
    game.turn = game.players[0];      // turn order = the order people joined in
    game.lastLetter = randomLetter();
    game.usedWords = [];
    game.joinDeadline = null;
    game.turnDeadline = Date.now() + TURN_TIME_MS;

    saveWCG(wcg);

    await sock.sendMessage(groupId, {
        text: `🎮 *WORLD CHAIN GAME — LET'S GO!*\n\nTurn order:\n${game.players.map((p, i) => `${i + 1}. @${p.split("@")[0]}`).join("\n")}\n\n🎯 @${game.turn.split("@")[0]}'s turn.\n\nSend a word starting with:\n\n*${game.lastLetter.toUpperCase()}*\n\n⏳ You have ${TURN_TIME_MS / 1000} seconds.`,
        mentions: game.players
    });

    startTurnTimer(sock, groupId, game.turn, TURN_TIME_MS);
}

// ---------- Per-turn timer ----------
// delayMs lets resumeWCG() re-arm with a shorter remaining window after a restart.
function startTurnTimer(sock, groupId, expectedPlayer, delayMs = TURN_TIME_MS) {

    setTimeout(async () => {

        const wcg = loadWCG();
        const game = wcg[groupId];

        if (!game || game.status !== "active") return;
        if (game.turn !== expectedPlayer) return; // they already answered in time

        // Capture rotation order BEFORE removing the eliminated player, otherwise
        // indexOf(game.turn) in advanceOrFinish would return -1 and reset turn
        // order back to player[0] instead of continuing the rotation.
        const oldPlayers = game.players;
        const eliminatedIndex = oldPlayers.indexOf(expectedPlayer);
        const eliminated = expectedPlayer;

        game.players = oldPlayers.filter(id => id !== eliminated);
        saveWCG(wcg);

        await sock.sendMessage(groupId, {
            text: `⏰ Time's up!\n\n@${eliminated.split("@")[0]} did not submit a word in time.\n\n❌ You have been eliminated.`,
            mentions: [eliminated]
        });

        await advanceOrFinish(sock, groupId, { previousIndex: eliminatedIndex, previousOrder: oldPlayers });

    }, delayMs);
}

// ---------- Move to next player, or declare a winner ----------
// opts.previousIndex / opts.previousOrder are only passed by the timeout path,
// where game.turn has already been removed from game.players and can no longer
// be used to locate "next" via indexOf.
async function advanceOrFinish(sock, groupId, opts = {}) {

    const wcg = loadWCG();
    const game = wcg[groupId];

    if (!game) return;

    if (game.players.length === 0) {
        delete wcg[groupId];
        saveWCG(wcg);
        return await sock.sendMessage(groupId, {
            text: `🏁 *World Chain Game over.*\n\nNo players remaining.`
        });
    }

    if (game.players.length === 1) {
        const winner = game.players[0];
        delete wcg[groupId];
        saveWCG(wcg);

        return await sock.sendMessage(groupId, {
            text: `🏆 *WORLD CHAIN GAME OVER!*\n\n👑 Winner:\n\n@${winner.split("@")[0]}\n\nCongratulations 🎉`,
            mentions: [winner]
        });
    }

    let nextPlayer;

    if (opts.previousOrder) {
        // Timeout path: continue rotation from where the eliminated player sat.
        const nextIdxInOld = (opts.previousIndex + 1) % opts.previousOrder.length;
        nextPlayer = opts.previousOrder[nextIdxInOld];
    } else {
        // Correct-answer path: game.turn is still a member of game.players.
        const currentIndex = game.players.indexOf(game.turn);
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % game.players.length;
        nextPlayer = game.players[nextIndex];
    }

    game.turn = nextPlayer;
    game.turnDeadline = Date.now() + TURN_TIME_MS;
    saveWCG(wcg);

    await sock.sendMessage(groupId, {
        text: `🎮 Next up:\n\n@${game.turn.split("@")[0]}\n\nWord must start with:\n\n*${game.lastLetter.toUpperCase()}*\n\n⏳ You have ${TURN_TIME_MS / 1000} seconds.`,
        mentions: [game.turn]
    });

    startTurnTimer(sock, groupId, game.turn, TURN_TIME_MS);
}

// ---------- Handles a plain-text message that might be a WCG move ----------
// Returns true if it consumed the message, false if it's none of its business.
async function handleWCGMessage(sock, msg, text) {

    const groupId = msg.key.remoteJid;
    if (!groupId.endsWith("@g.us")) return false;

    const wcg = loadWCG();
    const game = wcg[groupId];

    if (!game || game.status !== "active") return false;

    const userId = msg.key.participant || msg.key.remoteJid;

    if (!game.players.includes(userId)) return false; // not in this game — ignore silently

    if (game.turn !== userId) {
        await sock.sendMessage(groupId, {
            text: `⏳ Not your turn yet!\n\n🎮 It's currently @${game.turn.split("@")[0]}'s turn.`,
            mentions: [game.turn]
        }, { quoted: msg });
        return true;
    }

    const word = text.trim().toLowerCase();

    if (!/^[a-z]+$/.test(word)) {
        await sock.sendMessage(groupId, {
            text: `⚠️ That doesn't look like a single word. Letters only, no spaces or numbers.`
        }, { quoted: msg });
        return true;
    }

    if (!word.startsWith(game.lastLetter)) {
        await sock.sendMessage(groupId, {
            text: `❌ Your word must start with *${game.lastLetter.toUpperCase()}*.\n\nTry again!`
        }, { quoted: msg });
        return true;
    }

    if (game.usedWords.includes(word)) {
        await sock.sendMessage(groupId, {
            text: `♻️ "${word}" has already been used. Try a different word.`
        }, { quoted: msg });
        return true;
    }

    if (!isValidWord(word)) {
        await sock.sendMessage(groupId, {
            text: `❌ "${word}" isn't in the dictionary. Try again!`
        }, { quoted: msg });
        return true;
    }

    game.usedWords.push(word);
    game.lastLetter = word[word.length - 1];
    saveWCG(wcg);

    await sock.sendMessage(groupId, {
        text: `✅ @${userId.split("@")[0]} played *${word}*!\n\nNext word must start with *${game.lastLetter.toUpperCase()}*.`,
        mentions: [userId]
    }, { quoted: msg });

    await advanceOrFinish(sock, groupId);
    return true;
}

// ---------- Call once after your socket connects, e.g. in index.js on
// 'connection.update' -> connection === 'open'. Re-arms timers for any
// game that was mid-flight when the process last exited (crash, deploy,
// or .restart), instead of leaving that group permanently stuck. ----------
async function resumeWCG(sock) {

    const wcg = loadWCG();
    let changed = false;

    for (const groupId of Object.keys(wcg)) {
        const game = wcg[groupId];

        if (game.status === "waiting") {
            const remaining = (game.joinDeadline || 0) - Date.now();
            if (remaining <= 0) {
                await beginRound(sock, groupId); // join window already passed, resolve now
            } else {
                setTimeout(() => beginRound(sock, groupId), remaining);
            }
        } else if (game.status === "active") {
            const remaining = (game.turnDeadline || 0) - Date.now();
            if (remaining <= 0) {
                // Deadline already passed while the bot was down — eliminate now.
                startTurnTimer(sock, groupId, game.turn, 0);
            } else {
                startTurnTimer(sock, groupId, game.turn, remaining);
            }
        } else {
            // Unknown/stale status left over from an old version of the file — drop it.
            delete wcg[groupId];
            changed = true;
        }
    }

    if (changed) saveWCG(wcg);
}

module.exports = {
    loadWCG,
    saveWCG,
    startWCG,
    joinWCG,
    handleWCGMessage,
    resumeWCG
};