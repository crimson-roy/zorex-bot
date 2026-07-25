// Baileys 7.x is ESM-only, so it can't be require()'d from this CommonJS
// file. We kick off a dynamic import() once here (cached by Node — every
// await below after the first resolves instantly) and pull
// downloadMediaMessage out of it inside startVV().
const baileysImport = import("@whiskeysockets/baileys");

async function startVV(sock, msg) {

    const { downloadMediaMessage } = await baileysImport;

    const chatId = msg.key.remoteJid;

    try {

        const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

        if (!quoted) {

            return await sock.sendMessage(
                chatId,
                {
                    text:
`❌ Reply to a view-once image or video.`
                },
                {
                    quoted: msg
                }
            );

        }

        // Unwrap view once
        const inner =
            quoted.viewOnceMessage?.message ||
            quoted.viewOnceMessageV2?.message ||
            quoted.viewOnceMessageV2Extension?.message ||
            quoted;

        const type = Object.keys(inner || {})[0];

        if (
            !["imageMessage", "videoMessage"].includes(type)
        ) {

            return await sock.sendMessage(
                chatId,
                {
                    text:
`❌ That isn't a view-once image or video.`
                },
                {
                    quoted: msg
                }
            );

        }

        const buffer = await downloadMediaMessage(
            { message: inner },
            "buffer",
            {},
            {
                logger: console,
                // Recommended in Baileys 7 so a failed/expired media fetch can
                // be retried via a fresh re-upload request instead of just
                // failing outright. Purely additive — doesn't change behavior
                // on the normal success path.
                reuploadRequest: sock.updateMediaMessage
            }
        );

        const captions = [

`🌚 You wanted to see it?

Fine... but don't tell anyone I helped you. 🤫

👀 Enjoy.

— Zorex 🤖`,

`😂 Omo...

You really wanted to see this, eh?

Fine.

But if the owner catches you...

I know nothing. 🌚`,

`👀 Curiosity wins again...

Here's your media.

🤫 Keep this between us.`,

`😏 View Once?

Not anymore.

Zorex always finds a way. 🤖`,

`🌚 I shouldn't be doing this...

But you're lucky today.

Enjoy. 👀`,

`😂 You people don't like respecting "View Once" at all.

Anyway...

Here you go. 🌚`,

`🤖 Access Granted.

Decrypting...
██████████ 100%

Media unlocked successfully. 😎`,

`🌚 This conversation never happened.

I was never here.

You never saw this.

Deal? 🤝`,

`👀 Mission Complete.

View Once defeated.

Enjoy your evidence. 😂`,

`😹 You're lucky Lord Crimson created me.

Otherwise this would've stayed hidden forever.`
        ];

        await sock.sendMessage(
            chatId,
            {
                [type === "imageMessage"
                    ? "image"
                    : "video"]: buffer,

                caption:
                    captions[
                        Math.floor(
                            Math.random() * captions.length
                        )
                    ]
            },
            {
                quoted: msg
            }
        );

    } catch (err) {

        console.error("VV ERROR:", err);

        await sock.sendMessage(
            chatId,
            {
                text:
`❌ Failed to retrieve the view-once media.`
            },
            {
                quoted: msg
            }
        );

    }

}

module.exports = {
    startVV
};