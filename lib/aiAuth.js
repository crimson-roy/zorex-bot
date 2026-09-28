"use strict";

const {
    preferredDmJid,
    isGroupMessage,
    findRegisteredUser,
    ensureAiProfile,
    getAiProfile,
    hasPin,
    sessionActive,
    setPin,
    verifyPin,
    setPendingAuth
} = require("./aiUserStore");

function minutesUntil(timestamp) {
    const ms =
        Math.max(
            0,
            Number(timestamp || 0) -
            Date.now()
        );

    return Math.max(
        1,
        Math.ceil(
            ms /
            60000
        )
    );
}

async function sendSetupDm(
    sock,
    dmJid,
    name
) {
    return await sock.sendMessage(
        dmJid,
        {
            text:
`🤖 *Welcome to Zorex AI, ${name}*

Before you begin, create your private 4-digit AI PIN here in DM.

> Example: \`.ai 4827\`

*Important*
> Never send your PIN in a group.
> Zorex stores a cryptographic hash, not the readable PIN.
> Setting your PIN also signs you in for 24 hours.`
        }
    );
}

async function sendLoginDm(
    sock,
    dmJid,
    name
) {
    return await sock.sendMessage(
        dmJid,
        {
            text:
`🔐 *Zorex AI Verification*

Welcome back, ${name}.

Your 24-hour AI session has expired.

> Reply here with \`.ai YOUR_4_DIGIT_PIN\`

A successful verification signs you in for another 24 hours.`
        }
    );
}

async function authorizeAiRequest(
    sock,
    msg,
    body
) {
    const chatId =
        msg.key.remoteJid;

    const group =
        isGroupMessage(msg);

    const registration =
        findRegisteredUser(msg);

    if (
        !registration.userId ||
        !registration.user
    ) {
        await sock.sendMessage(
            chatId,
            {
                text:
`👤 *Zorex account required*

You need a registered Zorex account before using \`.ai\`.

> \`.register YOUR_NAME\``
            },
            {
                quoted: msg
            }
        );

        return {
            allowed: false,
            handled: true
        };
    }

    const name =
        registration.user.name ||
        msg.pushName ||
        "Zorex User";

    const {
        profileId
    } =
        ensureAiProfile(
            registration.userId,
            msg,
            name
        );

    const {
        profile
    } =
        getAiProfile(
            profileId
        );

    const enteredPin =
        /^\d{4}$/.test(
            String(body || "")
        );

    if (
        enteredPin &&
        group
    ) {
        await sock.sendMessage(
            chatId,
            {
                text:
`🔒 *Don't send your AI PIN in a group.*

I've ignored that PIN here.

> Open my private chat and send \`.ai YOUR_4_DIGIT_PIN\` there instead.`
            },
            {
                quoted: msg
            }
        );

        return {
            allowed: false,
            handled: true,
            profileId,
            name
        };
    }

    if (
        enteredPin &&
        !group
    ) {
        if (!hasPin(profile)) {
            const result =
                setPin(
                    profileId,
                    body
                );

            if (!result.ok) {
                await sock.sendMessage(
                    chatId,
                    {
                        text:
                            `❌ ${result.reason}`
                    },
                    {
                        quoted: msg
                    }
                );

                return {
                    allowed: false,
                    handled: true,
                    profileId,
                    name
                };
            }

            await sock.sendMessage(
                chatId,
                {
                    text:
`✅ *Zorex AI setup complete*

Good to see you, ${name}.

> Your 4-digit PIN has been created.
> You're signed in for the next 24 hours.

You can now use \`.ai\` normally in DM or return to your group.`
                },
                {
                    quoted: msg
                }
            );

            return {
                allowed: false,
                handled: true,
                profileId,
                name
            };
        }

        const result =
            verifyPin(
                profileId,
                body
            );

        if (!result.ok) {
            const text =
                result.locked
                    ? `🔒 Too many incorrect attempts. Try again in about ${minutesUntil(result.retryAt)} minute(s).`
                    : "❌ Incorrect AI PIN.";

            await sock.sendMessage(
                chatId,
                {
                    text
                },
                {
                    quoted: msg
                }
            );

            return {
                allowed: false,
                handled: true,
                profileId,
                name
            };
        }

        await sock.sendMessage(
            chatId,
            {
                text:
`✅ *Verified*

Welcome back, ${name}.

> Your Zorex AI session is active for the next 24 hours.`
            },
            {
                quoted: msg
            }
        );

        return {
            allowed: false,
            handled: true,
            profileId,
            name
        };
    }

    if (!hasPin(profile)) {
        setPendingAuth(
            profileId,
            "setup"
        );

        if (!group) {
            await sock.sendMessage(
                chatId,
                {
                    text:
`🤖 *First-time Zorex AI setup*

Good to see you, ${name}.

Create your private 4-digit AI PIN here.

> Example: \`.ai 4827\`

Your PIN must be exactly four digits.`
                },
                {
                    quoted: msg
                }
            );

            return {
                allowed: false,
                handled: true,
                profileId,
                name
            };
        }

        const dmJid =
            preferredDmJid(msg);

        let dmSent =
            false;

        if (dmJid) {
            try {
                await sendSetupDm(
                    sock,
                    dmJid,
                    name
                );

                dmSent =
                    true;
            } catch (err) {
                console.error(
                    "[AI auth] setup DM failed:",
                    err.message
                );
            }
        }

        await sock.sendMessage(
            chatId,
            {
                text:
                    dmSent
                        ? `👋 Good to see you, *${name}*.

I've sent you a private message to finish setting up Zorex AI.

> Create your 4-digit PIN in DM, then return here.`
                        : `👋 Good to see you, *${name}*.

I couldn't open the private setup chat automatically.

> Send me \`.ai\` in DM first, then create your 4-digit PIN there.`
            },
            {
                quoted: msg
            }
        );

        return {
            allowed: false,
            handled: true,
            profileId,
            name
        };
    }

    if (
        !sessionActive(profile)
    ) {
        setPendingAuth(
            profileId,
            "login"
        );

        if (!group) {
            await sock.sendMessage(
                chatId,
                {
                    text:
`🔐 *AI session expired*

Please verify your 4-digit PIN here in DM.

> \`.ai YOUR_4_DIGIT_PIN\``
                },
                {
                    quoted: msg
                }
            );

            return {
                allowed: false,
                handled: true,
                profileId,
                name
            };
        }

        const dmJid =
            preferredDmJid(msg);

        let dmSent =
            false;

        if (dmJid) {
            try {
                await sendLoginDm(
                    sock,
                    dmJid,
                    name
                );

                dmSent =
                    true;
            } catch (err) {
                console.error(
                    "[AI auth] login DM failed:",
                    err.message
                );
            }
        }

        await sock.sendMessage(
            chatId,
            {
                text:
                    dmSent
                        ? `🔐 *${name}*, your Zorex AI session has expired.

I've sent you a private verification message.

> Enter your 4-digit PIN in DM to unlock AI for another 24 hours.`
                        : `🔐 *${name}*, your Zorex AI session has expired.

> Open my DM and send \`.ai YOUR_4_DIGIT_PIN\` to verify.`
            },
            {
                quoted: msg
            }
        );

        return {
            allowed: false,
            handled: true,
            profileId,
            name
        };
    }

    return {
        allowed: true,
        handled: false,
        profileId,
        name,
        registeredUserId:
            registration.userId
    };
}

module.exports = {
    authorizeAiRequest
};
