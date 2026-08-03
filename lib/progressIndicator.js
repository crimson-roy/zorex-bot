// lib/progressIndicator.js
//
// Shared progress-indicator pattern for long-running commands (.play, .yt,
// .ttk today, .ai later): react ⌛ on the triggering message immediately,
// send ONE status message and edit it in place as stages complete (rather
// than spamming a new bubble per stage), then on completion swap the
// reaction to ✅/❌ and edit the status message to a final
// "✅ Task Completed" / "❌ Task Failed" line.
//
// Usage:
//   const progress = await startProgress(sock, msg, "🔎 Searching...");
//   await progress.update("⬇️ Downloading...");
//   ... do the actual work ...
//   await progress.succeed();   // or await progress.fail();
//
// Every step here is best-effort: a failed reaction or a failed message
// edit is logged and swallowed rather than thrown, since a UI hiccup on
// the progress indicator itself should never be what makes a command
// actually fail.

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg - the triggering command message
 * @param {string} initialText - first status line shown
 * @returns {Promise<{update: (text: string) => Promise<void>, succeed: () => Promise<void>, fail: () => Promise<void>}>}
 */
async function startProgress(sock, msg, initialText) {

    const chatId = msg.key.remoteJid;

    // React immediately — this is the very first feedback the user sees,
    // even before the status message itself has finished sending.
    try {

        await sock.sendMessage(chatId, {
            react: { text: "⌛", key: msg.key }
        });

    } catch (err) {

        console.error("[progress] failed to set initial reaction:", err.message);

    }

    let statusKey = null;

    try {

        const sent = await sock.sendMessage(chatId, { text: initialText }, { quoted: msg });
        statusKey = sent.key;

    } catch (err) {

        console.error("[progress] failed to send initial status message:", err.message);

    }

    /**
     * Edits the single status message in place. A no-op if the initial
     * status message failed to send in the first place — there's nothing
     * to edit, and this should never throw and interrupt the caller's
     * actual work.
     *
     * @param {string} text
     * @returns {Promise<void>}
     */
    async function update(text) {

        if (!statusKey) return;

        try {

            await sock.sendMessage(chatId, { text, edit: statusKey });

        } catch (err) {

            console.error("[progress] failed to edit status message:", err.message);

        }

    }

    /**
     * @param {boolean} success
     * @returns {Promise<void>}
     */
    async function finish(success) {

        try {

            await sock.sendMessage(chatId, {
                react: { text: success ? "✅" : "❌", key: msg.key }
            });

        } catch (err) {

            console.error("[progress] failed to set final reaction:", err.message);

        }

        await update(success ? "✅ Task Completed" : "❌ Task Failed");

    }

    return {
        update,
        succeed: () => finish(true),
        fail: () => finish(false)
    };

}

module.exports = { startProgress };
