"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const dataPath = require("../lib/dataPath");

const USERS_FILE = dataPath("users.json");

const SOCIAL_MEDIA_ROOT =
    path.join(
        __dirname,
        "..",
        "media",
        "social"
    );

const lastClipByCategory =
    new Map();

const SOCIAL_SOURCE_BASE =
    "https://raw.githubusercontent.com/ZekaiDev/anime-reaction-gif/main";

const SOCIAL_SOURCE_MAP = {
    hug:      { folder: "hug",     count: 40 },
    kiss:     { folder: "kiss",    count: 36 },
    slap:     { folder: "slap",    count: 25 },
    pat:      { folder: "pat",     count: 28 },
    poke:     { folder: "poke",    count: 18 },
    cuddle:   { folder: "cuddle",  count: 30 },
    bite:     { folder: "bite",    count: 20 },
    highfive: { folder: "brofist", count: 9  },
    dance:    { folder: "dance",   count: 33 },
    kill:     { folder: "punch",   count: 15 }
};

const bootstrapPromises =
    new Map();

const TARGETED_ACTIONS = {
    hug: {
        emoji: "🫂",
        line: (actor, target) => `${actor} hugged ${target} tightly.`
    },
    kiss: {
        emoji: "💋",
        line: (actor, target) => `${actor} gave ${target} a kiss.`
    },
    slap: {
        emoji: "🫲",
        line: (actor, target) => `${actor} slapped ${target}. Ouch 😭`
    },
    pat: {
        emoji: "🫳",
        line: (actor, target) => `${actor} gave ${target} a gentle head pat.`
    },
    poke: {
        emoji: "👉",
        line: (actor, target) => `${actor} poked ${target}.`
    },
    cuddle: {
        emoji: "🤗",
        line: (actor, target) => `${actor} cuddled up with ${target}.`
    },
    bite: {
        emoji: "🦷",
        line: (actor, target) => `${actor} bit ${target}. CHOMP 😭`
    },
    highfive: {
        emoji: "🙌",
        line: (actor, target) => `${actor} gave ${target} a high five!`
    },
    kill: {
        emoji: "💀",
        line: (actor, target) => `${actor} dramatically eliminated ${target} from the timeline 😭`
    }
};

const TARGETLESS_ACTIONS = {
    dance: {
        emoji: "💃",
        line: actor => `${actor} started dancing like nobody was watching ✨`
    }
};

function ensureSocialDir(
    category
) {
    const folder =
        path.join(
            SOCIAL_MEDIA_ROOT,
            category
        );

    fs.mkdirSync(
        folder,
        {
            recursive:
                true
        }
    );

    return folder;
}

function runFfmpeg(
    inputPath,
    outputPath
) {
    return new Promise(
        (
            resolve,
            reject
        ) => {

            const proc =
                spawn(
                    "ffmpeg",
                    [
                        "-y",
                        "-i",
                        inputPath,
                        "-an",
                        "-vf",
                        "scale=ceil(iw/2)*2:ceil(ih/2)*2",
                        "-c:v",
                        "libx264",
                        "-preset",
                        "veryfast",
                        "-crf",
                        "24",
                        "-pix_fmt",
                        "yuv420p",
                        "-movflags",
                        "+faststart",
                        outputPath
                    ],
                    {
                        stdio:
                            [
                                "ignore",
                                "ignore",
                                "pipe"
                            ]
                    }
                );

            let stderr =
                "";

            proc.stderr.on(
                "data",
                chunk => {
                    stderr +=
                        chunk.toString();
                }
            );

            proc.on(
                "error",
                reject
            );

            proc.on(
                "close",
                code => {

                    if (
                        code ===
                        0
                    ) {
                        resolve();
                        return;
                    }

                    reject(
                        new Error(
                            `ffmpeg exited with code ${code}: ${stderr.slice(-1200)}`
                        )
                    );

                }
            );

        }
    );
}

async function bootstrapSocialClip(
    category
) {
    if (
        bootstrapPromises.has(
            category
        )
    ) {
        return await bootstrapPromises.get(
            category
        );
    }

    const job =
        (async () => {

            const source =
                SOCIAL_SOURCE_MAP[
                    category
                ];

            if (!source) {
                return null;
            }

            const folder =
                ensureSocialDir(
                    category
                );

            const existing =
                socialMediaFiles(
                    category
                );

            if (existing.length) {
                return existing[0];
            }

            const sourceNumber =
                1 +
                Math.floor(
                    Math.random() *
                    source.count
                );

            const sourceUrl =
                `${SOCIAL_SOURCE_BASE}/${encodeURIComponent(source.folder)}/${sourceNumber}.gif`;

            const gifPath =
                path.join(
                    folder,
                    ".bootstrap.gif"
                );

            const mp4Path =
                path.join(
                    folder,
                    "001.mp4"
                );

            const response =
                await fetch(
                    sourceUrl,
                    {
                        headers: {
                            "User-Agent":
                                "Zorex-Social/1.0"
                        }
                    }
                );

            if (!response.ok) {
                throw new Error(
                    `reaction download HTTP ${response.status}`
                );
            }

            fs.writeFileSync(
                gifPath,
                Buffer.from(
                    await response.arrayBuffer()
                )
            );

            try {

                await runFfmpeg(
                    gifPath,
                    mp4Path
                );

            } finally {

                fs.rmSync(
                    gifPath,
                    {
                        force:
                            true
                    }
                );

            }

            console.log(
                `[social] Bootstrapped ${category} clip:`,
                mp4Path
            );

            return mp4Path;

        })()
            .catch(
                err => {

                    console.warn(
                        `[social] Failed bootstrapping ${category} reaction:`,
                        err.message
                    );

                    return null;

                }
            )
            .finally(
                () => {

                    bootstrapPromises.delete(
                        category
                    );

                }
            );

    bootstrapPromises.set(
        category,
        job
    );

    return await job;
}

function socialMediaFiles(
    category
) {

    const folder =
        path.join(
            SOCIAL_MEDIA_ROOT,
            category
        );

    if (!fs.existsSync(folder)) {
        return [];
    }

    try {

        return fs.readdirSync(
            folder
        )
            .filter(
                name =>
                    /\.mp4$/i.test(
                        name
                    )
            )
            .sort()
            .map(
                name =>
                    path.join(
                        folder,
                        name
                    )
            );

    } catch (err) {

        console.warn(
            `[social] Failed reading ${category} media folder:`,
            err.message
        );

        return [];

    }

}

function randomSocialClip(
    category
) {

    const files =
        socialMediaFiles(
            category
        );

    if (!files.length) {
        return null;
    }

    if (files.length === 1) {
        lastClipByCategory.set(
            category,
            files[0]
        );

        return files[0];
    }

    const previous =
        lastClipByCategory.get(
            category
        );

    let candidates =
        files.filter(
            file =>
                file !==
                previous
        );

    if (!candidates.length) {
        candidates =
            files;
    }

    const selected =
        candidates[
            Math.floor(
                Math.random() *
                candidates.length
            )
        ];

    lastClipByCategory.set(
        category,
        selected
    );

    return selected;
}

async function sendSocialReaction(
    sock,
    msg,
    {
        actionName,
        caption,
        mentions = []
    }
) {

    const chatId =
        msg.key.remoteJid;

    let clip =
        randomSocialClip(
            actionName
        );

    if (!clip) {

        clip =
            await bootstrapSocialClip(
                actionName
            );

    }

    if (clip) {

        try {

            console.log(
                `[social] Sending local ${actionName} clip:`,
                clip
            );

            return await sock.sendMessage(
                chatId,
                {
                    video: {
                        url:
                            clip
                    },
                    gifPlayback:
                        true,
                    caption,
                    mentions
                },
                {
                    quoted:
                        msg
                }
            );

        } catch (err) {

            console.warn(
                `[social] Failed sending local ${actionName} clip; falling back to text:`,
                err.message
            );

        }

    } else {

        console.warn(
            `[social] No local clips found for "${actionName}" under ${path.join(SOCIAL_MEDIA_ROOT, actionName)}`
        );

    }

    return await sock.sendMessage(
        chatId,
        {
            text:
                caption,
            mentions
        },
        {
            quoted:
                msg
        }
    );

}

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) return {};

    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    } catch (_) {
        return {};
    }
}

function getSenderJid(msg) {
    return msg.key.participant || msg.key.remoteJid;
}

function getTargetJid(msg) {
    const context = msg.message?.extendedTextMessage?.contextInfo;
    const mentioned = context?.mentionedJid;

    if (Array.isArray(mentioned) && mentioned.length > 0) {
        return mentioned[0];
    }

    if (context?.participant) {
        return context.participant;
    }

    return null;
}

function displayName(jid, users, fallback) {
    if (jid && users[jid]?.name) return users[jid].name;
    if (fallback) return fallback;
    if (jid) return `@${jid.split("@")[0]}`;
    return "Someone";
}

function commandName(text) {
    const match = String(text || "").trim().match(/^\.([a-z]+)/i);
    return match ? match[1].toLowerCase() : "";
}

async function socialCommand(sock, msg, text) {
    const actionName = commandName(text);
    const users = loadUsers();
    const sender = getSenderJid(msg);
    const actorName = displayName(sender, users, msg.pushName || "Someone");

    if (TARGETLESS_ACTIONS[actionName]) {
        const action = TARGETLESS_ACTIONS[actionName];

        return await sendSocialReaction(
            sock,
            msg,
            {
                actionName,
                caption:
                    `${action.emoji} ${action.line(actorName)}`
            }
        );
    }

    const action = TARGETED_ACTIONS[actionName];
    if (!action) return;

    const target = getTargetJid(msg);

    if (!target) {
        return await sock.sendMessage(
            msg.key.remoteJid,
            {
                text:
`⚠️ *.${actionName}* needs someone to target.\n\n> Mention someone\n\`.${actionName} @user\`\n\n> Or reply to their message with\n\`.${actionName}\``
            },
            { quoted: msg }
        );
    }

    if (actionName === "kill" && target === sender) {
        return await sendSocialReaction(
            sock,
            msg,
            {
                actionName,
                caption:
                    `💀 ${actorName} committed seppuku 😭`
            }
        );
    }

    const targetName = displayName(target, users);

    return await sendSocialReaction(
        sock,
        msg,
        {
            actionName,
            caption:
                `${action.emoji} ${action.line(actorName, targetName)}`,
            mentions:
                [target]
        }
    );
}

module.exports = {
    socialCommand,
    TARGETED_ACTIONS,
    TARGETLESS_ACTIONS
};
