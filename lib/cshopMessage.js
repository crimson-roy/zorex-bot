"use strict";

function getLagosDateKey(now = Date.now()) {
    const date = new Date(Number(now) + 60 * 60 * 1000);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function getNextLagosMidnight(now = Date.now()) {
    const date = new Date(Number(now) + 60 * 60 * 1000);
    return Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate() + 1,
        0, 0, 0
    ) - 60 * 60 * 1000;
}

function remainingTime(expiresAt, now = Date.now()) {
    const left = Math.max(0, Number(expiresAt) - Number(now));
    const hours = Math.floor(left / (60 * 60 * 1000));
    const minutes = Math.floor((left % (60 * 60 * 1000)) / (60 * 1000));
    return `${hours}h ${minutes}m`;
}

function buildCshopMessage(state, cards, tierIcons, now = Date.now()) {
    const slots = Array.isArray(state?.slots) ? state.slots : [];
    const catalog = cards && typeof cards === "object" ? cards : {};
    const icons = tierIcons && typeof tierIcons === "object" ? tierIcons : {};
    const lines = [
        "╭ *WELCOME TO ZOREX CARD SHOP* 🎴 ╮",
        "Choose from today's featured cards.",
        "🌙 New cards reset every day at 12:00 AM WAT.",
        "",
        "🎴 ━━━━━ *TODAY'S CARDS* ━━━━━ 🎴"
    ];

    if (!slots.length) {
        lines.push("", "🚫 No cards remain in today's shop.", "Check back after midnight WAT.");
    }

    for (const slot of slots) {
        const card = catalog[slot.cardId];
        if (!card) continue;

        const icon = icons[slot.tier] || "⚪";
        lines.push(
            "",
            `${icon} *[ ${slot.slot} ] ${card.name}*`,
            `├─ 🏷️ Tier: ${slot.tier}`,
            `├─ 📚 Series: ${card.series || "Unknown"}`,
            `├─ 🆔 ID: #${slot.cardId}`,
            `└─ 💰 Price: ${Number(slot.price || 0).toLocaleString()} 🌙`
        );
    }

    lines.push(
        "",
        "🛒 ━━━━━━ *HOW TO BUY* ━━━━━━ 🛒",
        "📥 .cshop buy <slot>",
        "👉 Example: .cshop buy 3",
        `⏳ Next reset: ${remainingTime(state?.expiresAt, now)}`,
        "╰──── 🤖 Powered by Zorex AI ────╯"
    );

    return lines.join("\n");
}

module.exports = {
    getLagosDateKey,
    getNextLagosMidnight,
    remainingTime,
    buildCshopMessage
};
