// Stops libsignal (used by Baileys) from writing Signal session objects —
// including private ratchet keys — to the PM2 logs. libsignal logs these
// through console.info/console.warn with the full SessionEntry attached.
// Loaded first in index.js so it applies before Baileys is imported.

const DROP = [
    "Closing session:",
    "Opening session:",
    "Removing old closed session:",
    "Migrating session to:",
    "Closing open session in favor of incoming prekey bundle",
];
const STRIP_OBJECT = ["Session already closed", "Session already open"];

function wrap(method) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        const first = args[0];
        if (typeof first === "string") {
            if (DROP.some((p) => first.startsWith(p))) return;
            if (STRIP_OBJECT.some((p) => first.startsWith(p))) return original(first);
        }
        return original(...args);
    };
}

for (const m of ["info", "warn", "log"]) wrap(m);
