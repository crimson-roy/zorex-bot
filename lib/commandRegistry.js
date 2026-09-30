"use strict";

// Public Zorex knowledge registry.
// Racing Life content here is intentionally limited to the shareable
// Friends & Testers overview. Never place confidential GDD material here.

const CATEGORY_SUMMARIES = {
    ai: "AI, image generation, memory/relationship features and Zorex help.",
    games: "Chat and multiplayer mini-games.",
    economy: "Registration, profiles, money, rewards, shopping and economy activities.",
    profile: "Profile details such as age and bio.",
    investments: "Investment, portfolio and asset-related commands.",
    company: "Create, grow and manage companies, jobs, employees and company assets.",
    jobs: "Browse jobs, apply, inspect employment and perform duties.",
    cards: "Search, collect, claim and manage Zorex cards.",
    auction: "Card auction viewing, bidding and owner auction-management tools.",
    casino: "Casino and chance-based Zorex games.",
    downloader: "Supported online media download tools.",
    media: "Image, video and sticker tools.",
    group: "Group administration and group utilities.",
    social: "Fun social interactions and relationship commands.",
    school: "School/document learning tools.",
    utilities: "General Zorex utilities.",
    owner: "Restricted owner administration.",
    "main-owner": "Commands reserved for the main owner."
};

const MENU_COMMANDS = {
    ai: ["ask", "ai", "ai history", "image", "video", "relation", "mem"],
    games: ["wcg start", "wcg join", "trivia", "ttt"],
    economy: ["register", "profile", "bal", "dep", "wd", "donate", "daily", "work", "shop", "crime", "rob", "beg", "fish", "sell", "dig", "rich"],
    profile: ["age", "bio", "setage", "setbio", "namechange", "changename"],
    investments: ["invest", "portfolio", "assets"],
    company: ["company", "companycreate", "companyupgrade", "company deposit", "company distribute", "company assign", "company promote", "companyoffers", "companyoffer", "companyapprove", "company disapprove", "hire", "employees", "oversee", "fire", "companyassets"],
    jobs: ["joboffers", "jobapply", "job", "jobinfo", "duty"],
    cards: ["ss", "cshop", "cs", "col", "inv", "claim", "give", "cardlb", "use"],
    auction: ["auction", "auctionbid", "auctioncards", "importauction", "auctionstart", "auctionend"],
    casino: ["gamble", "cf", "dice", "aviator", "slots", "roulette", "poker", "bj", "hit", "stand", "double", "mines", "shovel", "cashout", "raffle"],
    downloader: ["play", "yt", "vv", "ttk", "media"],
    media: ["enhance", "fix", "fix brightness", "fix saturation", "fix denoise", "graph", "silhouette", "upscale", "fps", "bitrate", "queue", "sticker", "s", "toimage", "toimg", "tovid"],
    group: ["afk", "tagall", "hidetag", "antilink", "setwarnings", "resetwarnings", "mute", "unmute", "promote", "demote", "kick", "open", "close", "setwelcome", "setleave", "invite", "inviteowner"],
    social: ["hug", "kiss", "slap", "pat", "poke", "cuddle", "bite", "highfive", "kill", "dance", "marry", "marryaccept", "marrydecline", "divorce"],
    school: ["slides", "teach"],
    utilities: ["ping", "test", "owner", "mycds", "mydls", "d", "menu"],
    owner: ["restart", "commandoff", "commandon", "cardoff", "cardon", "setrole", "addcrescent", "spawn", "addcard", "rcard", "fixcompany"],
    "main-owner": ["broadcast", "removecrescent", "addowner", "removeowner", "resetcd", "resetdl", "resetbal", "reseteconomy", "hb"]
};

const DETAILS = {
    ask: {
        usage: ".ask <question>",
        description: "Explains Zorex commands, systems and approved public project information."
    },
    ai: {
        usage: ".ai <question or request>",
        description: "General Zorex AI assistant for questions, quoted-message analysis, documents, images and supported AI tasks. It can read replied WhatsApp text, analyze attached/replied images with Azure multimodal vision, extract image text with Azure OCR, and read PDF, DOCX, XLSX, PPTX, HTML plus plain text/CSV/JSON/XML documents. Recent AI conversation history is reused for follow-up context. Registered users set a private 4-digit AI PIN in DM; successful verification unlocks AI for 24 hours. Authenticated AI can execute an allowlisted set of Zorex actions: show balance/profile/company/inventory/collection, search cards/series, deposit or withdraw wallet/bank funds, claim daily rewards, work, upgrade a company, transfer Crescents to a genuinely mentioned/replied user, buy shop/CShop items, set the current group's welcome/leave message, open/close the current group, add-owner/promote/demote through the real permission-checked handlers, and run group moderation including mute, unmute, kick, mute-all and unmute-all. A request such as 'mute @user and kick them if they keep spamming' can arm a per-group escalation rule that kicks after repeated messages while muted. Group/owner actions always use the real WhatsApp permission checks; add-owner remains MAIN_OWNER-only. The 5,000,000 Crescent confirmation threshold applies only to aggregate financial exposure, not to moderation or privilege actions."
    },
    "ai history": {
        usage: ".ai history [count]",
        description: "Shows your recent saved Zorex AI history. History is tied to your authenticated AI profile, and recent conversational entries are also reused as context for follow-up .ai questions."
    },
    image: {
        usage: ".image <prompt>",
        description: "Generates a new image from a text prompt."
    },
    video: {
        usage: ".video [2s-10s] [portrait|landscape] <prompt>",
        description: "Generates an AI video. With no source image it performs text-to-video. Reply to an image, or send an image with the .video caption, to animate it with image-to-video. Default duration is 5 seconds and text-to-video defaults to portrait.",
        examples: [".video a neon sports car drifting at night", ".video 8s landscape waves crashing against cliffs"]
    },
    register: {
        usage: ".register YOUR_NAME",
        description: "Creates a Zorex account/profile.",
        examples: [".register Crimson Roy"]
    },
    profile: {
        usage: ".profile",
        description: "Shows your registered Zorex profile."
    },
    namechange: {
        usage: ".namechange NEW_NAME",
        description: "Changes the name on your registered Zorex profile without changing the rest of your account data."
    },
    changename: {
        usage: ".changename NEW_NAME",
        description: "Alias of .namechange."
    },
    bal: {
        usage: ".bal",
        description: "Shows your Zorex money balance."
    },
    dep: {
        usage: ".dep <amount|all>",
        description: "Moves Crescents from your wallet into your bank, respecting bank capacity."
    },
    wd: {
        usage: ".wd <amount|all>",
        description: "Moves Crescents from your bank back into your wallet."
    },
    donate: {
        usage: ".donate <amount> @user",
        description: "Transfers Crescents to another registered user. Reply to or mention the recipient. The normal donation tax rules still apply."
    },
    daily: {
        usage: ".daily",
        description: "Claims the daily reward when the 24-hour cooldown has finished and updates the daily streak."
    },
    work: {
        usage: ".work <1|2|3>",
        description: "Performs a work tier. Higher tiers have larger earning ranges and longer cooldowns."
    },
    shop: {
        usage: ".shop buy <item_ID> [quantity]",
        description: "Buys an item from the normal Zorex shop using the catalog's real current price. Unique utilities can only be owned once; supported bank upgrades and raffle tickets can use quantities."
    },
    cshop: {
        usage: ".cshop buy <slot>",
        description: "Buys the live card currently occupying a CShop slot. CShop cards rotate, are single-copy, and use the slot's real current price."
    },
    inv: {
        usage: ".inv [number]",
        description: "Shows your inventory or details for one inventory item."
    },
    col: {
        usage: ".col [number]",
        description: "Shows your card collection or details for one collection item."
    },
    company: {
        usage: ".company",
        description: "Shows your company status, progress and company-wallet information."
    },
    companycreate: {
        usage: ".companycreate <company name> <industry>",
        description: "Creates a company when registration, industry and wallet requirements are satisfied.",
        examples: [".companycreate Roy Trading Group animation"]
    },
    companyupgrade: {
        usage: ".companyupgrade",
        description: "Upgrades your company level when the current requirements are met."
    },
    "company deposit": {
        usage: ".company deposit <asset type> <amount>",
        description: "Moves supported personal currency/assets into company holdings.",
        examples: [".company deposit crescent 50000", ".company deposit gold 2"]
    },
    companyoffer: {
        usage: ".companyoffer <position>",
        description: "Opens a valid job position at your company when staffing rules allow it."
    },
    companyoffers: {
        usage: ".companyoffers",
        description: "Shows open company offers, applicants and filled positions."
    },
    companyapprove: {
        usage: ".companyapprove <position> @user",
        description: "Approves a specific pending applicant for an open company position."
    },
    hire: {
        usage: ".hire <offer #>",
        description: "Runs the company hiring action for a selected offer."
    },
    companyassets: {
        usage: ".companyassets",
        description: "Shows assets held by your company."
    },
    joboffers: {
        usage: ".joboffers",
        description: "Shows available player-company job offers."
    },
    jobapply: {
        usage: ".jobapply ...",
        description: "Applies to an available job offer. The live command provides exact arguments when needed."
    },
    cs: {
        usage: ".cs <card name> [tier]",
        description: "Searches the Zorex card database by name, optionally narrowed by tier.",
        examples: [".cs Rem SSR"]
    },
    ss: {
        usage: ".ss <series>",
        description: "Searches/browses Zorex cards by series."
    },
    casino: {
        usage: ".casino <amount>",
        description: "Plays one Zorex Casino round with the specified wager, subject to wallet, cooldown and daily-limit rules.",
        examples: [".casino 5000"]
    },
    slots: {
        usage: ".slots <amount>",
        description: "Plays one Zorex Slots round with the specified wager, subject to wallet, cooldown and daily-limit rules.",
        examples: [".slots 1000"]
    },
    mines: {
        usage: ".mines <mine count> <bet>",
        description: "Starts Zorex Mines: choose the mine count and wager, uncover safe tiles and cash out before hitting a mine.",
        examples: [".mines 5 10000"]
    },
    shovel: {
        usage: ".shovel <tile>",
        description: "Opens a selected tile during an active Mines game."
    },
    cashout: {
        usage: ".cashout",
        description: "Cashes out the current active Mines game when allowed."
    },
    graph: {
        usage: ".graph <color|inverse|white|depth|depthvideo>",
        description: "Image/video graph and effect command. Named colors or hex values tint a replied image; inverse flips colors; white makes grayscale; depth generates an AI depth map from a replied image; depthvideo processes a replied video into a grayscale depth video.",
        examples: [".graph red", ".graph #ff8800", ".graph inverse", ".graph white", ".graph depth", ".graph depthvideo"]
    },
    upscale: {
        usage: ".upscale <2|4|8> [fps] [bitrate] [quality|max|hq]",
        description: "Queues an AI video-resolution upscale for a replied WhatsApp video. Scale 2, 4 or 8 is a multiplier of the source resolution, not a fixed target such as 1080p. The source video is saved persistently before the job is queued, so a Zorex/PM2 restart does not discard the pending edit. Compatible Real-ESRGAN workers process the job; faster higher-priority workers are preferred and slower fallback workers are used only when needed. Optional fps and bitrate values control the final encode. Adding quality, max or hq requests the slower maximum-quality final encode. Use .queue to inspect the job after it is created. Zorex AI can execute this action when the user replies to a real video and asks to upscale it.",
        examples: [".upscale 2", ".upscale 4 60", ".upscale 4 60 6000", ".upscale 4 quality", ".upscale 8 60 8000 max"]
    },
    queue: {
        usage: ".queue | .queue <ZRX-job-id> | .queue cancel <ZRX-job-id>",
        description: "Shows and manages persistent Zorex Editor jobs. Bare .queue lists your recent edit jobs and their progress. .queue ZRX-... shows one job and sends its result if it has completed. .queue cancel ZRX-... cancels one of your jobs. Zorex AI can also list, inspect or cancel your editor jobs through natural-language .ai requests.",
        examples: [".queue", ".queue ZRX-ABC123", ".queue cancel ZRX-ABC123"]
    },
    "fix brightness": {
        usage: ".fix brightness <percentage>",
        description: "Changes brightness on a replied image. 100 keeps the original brightness; values above or below 100 brighten or darken it."
    },
    "fix saturation": {
        usage: ".fix saturation <percentage>",
        description: "Changes saturation on a replied image. 100 keeps the original saturation."
    },
    "fix denoise": {
        usage: ".fix denoise",
        description: "Applies the local denoise/smoothing edit to a replied image."
    },
    fps: {
        usage: ".fps <number>",
        description: "Locally re-encodes a replied video at the requested frame rate. This is an FFmpeg operation and does not require an AI GPU worker."
    },
    bitrate: {
        usage: ".bitrate <kbps>",
        description: "Locally re-encodes a replied video at the requested video bitrate in kbps. This is an FFmpeg operation and does not require an AI GPU worker."
    },
    sticker: {
        usage: ".sticker [text] [(author)]",
        description: "Creates a square WhatsApp sticker from replied media. .s is an alias. Text before parentheses is drawn on the sticker; final parenthesized text becomes the sticker author label.",
        examples: [".s Legend", ".s (Made by Zorex)", ".s Legend (Made by Zorex)"]
    },
    s: {
        usage: ".s [text] [(author)]",
        description: "Alias of .sticker."
    },
    toimage: {
        usage: ".toimage",
        description: "Converts a replied sticker into an image."
    },
    toimg: {
        usage: ".toimg",
        description: "Alias of .toimage."
    },
    tovid: {
        usage: ".tovid",
        description: "Converts a replied sticker into a video."
    },
    mute: {
        usage: ".mute @user [duration] | .mute all",
        description: "Group-admin moderation command. Normal .mute targets one mentioned/replied member. .mute all enables persistent deletion mode: every new message from non-admin members is automatically deleted while group admins remain exempt. This is different from .close because members can still attempt to send; Zorex deletes their messages after they arrive.",
        access: "group-admin"
    },
    unmute: {
        usage: ".unmute @user | .unmute all",
        description: "Group-admin moderation command. Normal .unmute removes one member's mute. .unmute all disables the persistent group-wide auto-delete mode so non-admin messages are allowed normally again.",
        access: "group-admin"
    },
    setwelcome: {
        usage: ".setwelcome <message> | .setwelcome on | .setwelcome off",
        description: "Group-admin-only command that configures the welcome message for the current group only. Each group keeps its own template. When a member joins, Zorex always visibly tags that member and then sends the configured welcome text. Optional placeholders: @user, {group}, {count}.",
        access: "group-admin"
    },
    setleave: {
        usage: ".setleave <message> | .setleave on | .setleave off",
        description: "Group-admin-only command that configures the leave message for the current group only. Each group keeps its own template. When a member leaves, Zorex always visibly tags that member and then sends the configured leave text. Optional placeholders: @user, {group}, {count}.",
        access: "group-admin"
    },
    open: {
        usage: ".open",
        description: "Opens the current WhatsApp group so all members can send messages. Restricted to Zorex owners or actual group admins.",
        access: "admin-or-owner"
    },
    close: {
        usage: ".close",
        description: "Closes the current WhatsApp group so only admins can send messages. Restricted to Zorex owners or actual group admins.",
        access: "admin-or-owner"
    },
    promote: {
        usage: ".promote @user",
        description: "Promotes a mentioned/replied member to group admin when the sender passes the real group admin/owner permission rules.",
        access: "group-admin"
    },
    demote: {
        usage: ".demote @user",
        description: "Demotes a mentioned/replied group admin when the sender passes the real group admin/owner permission rules.",
        access: "group-admin"
    },
    addowner: {
        usage: ".addowner @user",
        description: "Adds a Zorex owner. This is restricted to MAIN_OWNER (Lord Crimson); AI execution cannot bypass that check.",
        access: "main-owner"
    },
    inviteowner: {
        usage: ".inviteowner",
        description: "Group-admin/owner command that privately sends the main owner the current group's invite link; the owner decides whether to join.",
        access: "admin-or-owner"
    },
    tagall: {
        usage: ".tagall",
        description: "Mentions group members. Restricted to the owner or group admins.",
        access: "admin-or-owner"
    },
    menu: {
        usage: ".menu",
        description: "Shows the current Zorex command menu."
    },
    owner: {
        usage: ".owner",
        description: "Shows the bot's public owner/contact information."
    }
};

const SOCIAL_DESCRIPTIONS = {
    hug: "Sends a random local anime hug reaction clip to a mentioned user or the author of a replied message.",
    kiss: "Sends a random local anime kiss reaction clip.",
    slap: "Sends a random local anime slap reaction clip.",
    pat: "Sends a random local anime head-pat reaction clip.",
    poke: "Sends a random local anime poke reaction clip.",
    cuddle: "Sends a random local anime cuddle reaction clip.",
    bite: "Sends a random local anime bite reaction clip.",
    highfive: "Sends a random local anime high-five/brofist reaction clip.",
    kill: "Sends a random fictional/playful anime elimination reaction clip.",
    dance: "Sends a random local anime dance reaction clip."
};

for (const [name, description] of Object.entries(SOCIAL_DESCRIPTIONS)) {
    DETAILS[name] = {
        usage: name === "dance" ? ".dance" : `.${name} @user`,
        description
    };
}

const COMMANDS = [];

for (const [category, names] of Object.entries(MENU_COMMANDS)) {
    for (const name of names) {
        const detail = DETAILS[name] || {};
        COMMANDS.push({
            name,
            aliases:
                name === "sticker"
                    ? ["s"]
                    : name === "toimage"
                        ? ["toimg"]
                        : [],
            category,
            usage: detail.usage || `.${name}`,
            description:
                detail.description ||
                "This command exists in Zorex, but detailed public help for its arguments/rules has not yet been added to the registry. Do not invent missing details.",
            examples: detail.examples || [],
            access:
                detail.access ||
                (category === "main-owner"
                    ? "main-owner"
                    : category === "owner"
                        ? "owner"
                        : "public")
        });
    }
}

const AI_EXECUTABLE_CAPABILITIES = [
    ".bal",
    ".profile",
    ".company",
    ".inv",
    ".col",
    ".dep",
    ".wd",
    ".daily",
    ".work",
    ".companyupgrade",
    ".donate / transfer to a real mentioned or replied user",
    ".shop buy",
    ".cshop buy",
    ".setwelcome",
    ".setleave",
    ".open",
    ".close",
    ".addowner (MAIN_OWNER permission still required)",
    ".promote",
    ".demote",
    ".mute",
    ".unmute",
    ".kick",
    ".mute all",
    ".unmute all",
    ".cs card search",
    ".ss series search",
    ".casino",
    ".slots",
    ".graph depthvideo / video depth with optional mist",
    ".upscale on a replied video",
    ".queue list/show/cancel editor jobs"
];

function buildAiCapabilityList() {
    return AI_EXECUTABLE_CAPABILITIES
        .map(value => `- ${value}`)
        .join("\n");
}

const CATEGORY_MENU_META = {
    ai: ["🤖", "AI & CHLOE"],
    games: ["🎮", "GAMES"],
    economy: ["💰", "ECONOMY"],
    profile: ["👤", "PROFILE"],
    investments: ["📈", "INVESTMENTS"],
    company: ["🏢", "COMPANY"],
    jobs: ["💼", "JOBS"],
    cards: ["🎴", "CARDS"],
    auction: ["🔨", "AUCTION"],
    casino: ["🎰", "CASINO"],
    downloader: ["📥", "DOWNLOADER"],
    media: ["🖼️", "MEDIA TOOLS"],
    group: ["👥", "GROUP TOOLS"],
    social: ["💍", "SOCIAL"],
    school: ["📖", "SCHOOL"],
    utilities: ["🛠", "UTILITIES"],
    owner: ["👑", "OWNER COMMANDS"],
    "main-owner": ["🔱", "MAIN OWNER"]
};

function menuMarker(category, commandName) {
    if (category === "main-owner") return "🔱";
    if (category === "owner") return "👑";

    const detail = DETAILS[commandName] || {};
    if (detail.access === "main-owner") return "🔱";
    if (detail.access === "owner") return "👑";
    return "✦";
}

function buildMenuText() {
    const blocks = ["📚 *ZOREX COMMAND MENU*"];

    for (const [category, names] of Object.entries(MENU_COMMANDS)) {
        const [emoji, label] =
            CATEGORY_MENU_META[category] ||
            ["•", category.toUpperCase()];

        const lines = names.map(name =>
            `│ ${menuMarker(category, name)} .${name}`
        );

        blocks.push(
            `╭─═${emoji} ${label} ${emoji}═─╮\n` +
            lines.join("\n") +
            "\n╰────────────────────╯"
        );
    }

    blocks.push("⚡ ZOREX AI\n© ROY TRADING GROUP");
    return blocks.join("\n\n");
}

const ZOREX_PUBLIC_INFO = `
Zorex is a WhatsApp bot ecosystem with AI, economy, companies, jobs, cards,
casino games, media tools, group utilities, social commands and school tools.
The command prefix is ".".
The public owner identity shown by the bot is Lord Crimson. Lord Crimson is a girl; "Lord" is simply the alias/title she likes using.
.ask is the Zorex help/knowledge assistant.
.ai is the broader Zorex AI assistant.
`.trim();

const RACING_LIFE_PUBLIC_KNOWLEDGE = `
RACING LIFE — PUBLIC / FRIENDS & TESTERS KNOWLEDGE ONLY

Racing Life is a persistent racing career, multiplayer life world and long-term
social simulation. The player is intended to live a racing life rather than merely
select races. Racing stays central while the larger world is planned to support
careers, family, fame, crime/law, property, social media, travel, creator culture
and long-term consequences.

Public development status:
- A working 2D racing prototype includes car controls, multiple track themes, AI
  racers, laps, collisions, finish order and race-result updates.
- Career UI tracks racer name, team, manager trust, reputation, money, season/week
  and recent race history.
- Profile setup includes player name, age, appearance options and local saving.
- Development is transitioning toward Three.js 3D racing/home/free-roam scenes with
  imported glTF/GLB environments and tracks.
- The next public milestone is a 3D circuit with a drivable car, then reconnecting
  the career systems around 3D races.

Public structure:
- Career/local progression: personal career, managers, AI professional events,
  story beats and local competition.
- Multiplayer free roam: an online-only shared living layer for travel, work,
  social life, crime, family, creator activity and economy.
- Online professional competition: qualified real-player factions in structured
  5v5 racing.
- Special story experiences: tighter scripted modes for licensed collaborations/events.

Public world/career direction:
- Planned locations include cities, lower-income/slum districts, homes, businesses,
  race venues, airports, police facilities, hospitals and social spaces.
- Players can drive/walk/travel, buy property, meet other players, join jobs/events,
  commit crimes or follow lawful careers.
- Public profession examples include professional racer, driver, pilot, police
  officer, criminal path, lawyer, footballer and artist/creator.
- A faction is the larger racer organization/pool; a team is the racers selected
  for a particular professional matchup.
- The current public 5v5 concept uses separate 1v1 races, with the first faction
  to three wins taking the matchup and the fifth race deciding a 2-2 score.
- Local championships/World Cup are AI-driven career events; online versions are
  intended for qualified real-player factions.

Public life systems:
- Economy/property/status can involve racing income, contracts, cars, homes,
  businesses, wealth rankings, trophies and titles.
- An in-world social network can support profiles, followers, gameplay posts,
  comments, reposts, trends and fame.
- Artist/creator paths can release original music and build an audience.
- Family systems can include spouse/children, home routines, relationship changes,
  aging and legacy continuation.
- Crime has persistent consequences such as fines, records, prison or career loss.
- Serious prison terms may use personal time skips instead of forcing literal waiting.
- True death is intended to be rare and can lead to legacy/new-life continuation.
- HOME is a planned in-world support organization for bug reports, harassment/
  bullying reports, suspicious behavior, moderation/account appeals and player support.

Public development priorities:
Build the 3D racing foundation first, reconnect career systems, add faction/local
championship flow, create a small 3D home/free-roam district, then persistence and
economy, then limited multiplayer free roam, and expand professions/social/family/
crime/creator systems gradually. Online championships/World Cups come after
networking and competitive integrity are stable.

Public guardrails:
Racing remains the foundation. Player history matters. The world should feel alive
without endless chores. Premium spending may support style/status/convenience, but
competitive success should still depend mainly on skill, preparation and career
decisions. Creator payout ideas are later-stage and require strong safety, fraud,
copyright and compliance controls.

CONFIDENTIALITY:
This public knowledge intentionally excludes internal implementation details,
security material, exact anti-cheat logic, private development addresses, unreleased
internal rules and confidential developer documentation. If asked for those details,
state that they are developer-only and unavailable through the public assistant.
`.trim();

const STOP_WORDS = new Set([
    "a","an","and","are","can","command","commands","do","does","for","how",
    "i","in","is","it","me","my","of","on","please","the","to","what","whats",
    "with","you","zorex","tell","explain"
]);

function normalize(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}.]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokensFor(query) {
    return normalize(query)
        .replace(/\./g, " ")
        .split(/\s+/)
        .filter(token => token && !STOP_WORDS.has(token));
}

function explicitCommandNames(query) {
    const matches =
        String(query || "").match(/\.[a-z][a-z0-9]*(?:\s+[a-z]+)?/gi) || [];

    return matches.map(value =>
        normalize(value.replace(/^\./, ""))
    );
}

function scoreCommand(entry, tokens, normalizedQuery) {
    const name = normalize(entry.name);
    const category = normalize(entry.category);
    const haystack = normalize([
        entry.name,
        ...(entry.aliases || []),
        entry.category,
        entry.usage,
        entry.description,
        ...(entry.examples || [])
    ].join(" "));

    let score = 0;

    if (normalizedQuery.includes(name)) score += 10;
    if (normalizedQuery.includes(category)) score += 5;

    for (const token of tokens) {
        if (name === token) score += 8;
        else if (name.includes(token)) score += 4;
        if (category === token) score += 4;
        if (haystack.includes(token)) score += 2;
    }

    return score;
}

function formatCommand(entry) {
    return [
        `Command: .${entry.name}`,
        `Usage: ${entry.usage}`,
        `Category: ${entry.category}`,
        `Access: ${entry.access}`,
        `Description: ${entry.description}`,
        entry.examples.length
            ? `Examples: ${entry.examples.join(" | ")}`
            : ""
    ].filter(Boolean).join("\n");
}

function shouldIncludeRacingLife(query) {
    return /\b(racing life|racinglife|free roam|world cup|faction|legacy|home support|racing game|creator culture)\b/i
        .test(String(query || ""));
}

function isGeneralCommandQuestion(query) {
    return /\b(commands?|menu|what can zorex do|features?|help)\b/i
        .test(String(query || ""));
}

function buildKnowledgeContext(query) {
    const normalizedQuery = normalize(query);
    const tokens = tokensFor(query);
    const explicit = explicitCommandNames(query);

    const exact = COMMANDS.filter(entry =>
        [entry.name, ...(entry.aliases || [])]
            .map(normalize)
            .some(key => explicit.includes(key))
    );

    const scored = COMMANDS
        .map(entry => ({
            entry,
            score: scoreCommand(entry, tokens, normalizedQuery)
        }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(item => item.entry);

    const selected = [];
    const seen = new Set();

    for (const entry of [...exact, ...scored]) {
        const key = `${entry.category}:${entry.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(entry);
        if (selected.length >= 12) break;
    }

    const blocks = [
        "ZOREX PUBLIC INFO",
        ZOREX_PUBLIC_INFO
    ];

    if (isGeneralCommandQuestion(query)) {
        blocks.push(
            "COMMAND CATEGORIES",
            Object.entries(CATEGORY_SUMMARIES)
                .map(([name, description]) => `${name}: ${description}`)
                .join("\n")
        );
    }

    if (selected.length) {
        blocks.push(
            "RELEVANT COMMANDS",
            selected.map(formatCommand).join("\n\n")
        );
    }

    if (shouldIncludeRacingLife(query)) {
        blocks.push(RACING_LIFE_PUBLIC_KNOWLEDGE);
    }

    return {
        context: blocks.join("\n\n---\n\n"),
        hasSpecificKnowledge:
            selected.length > 0 ||
            shouldIncludeRacingLife(query) ||
            isGeneralCommandQuestion(query),
        matchedCommands: selected
    };
}

module.exports = {
    COMMANDS,
    CATEGORY_SUMMARIES,
    MENU_COMMANDS,
    AI_EXECUTABLE_CAPABILITIES,
    ZOREX_PUBLIC_INFO,
    RACING_LIFE_PUBLIC_KNOWLEDGE,
    buildKnowledgeContext,
    buildMenuText,
    buildAiCapabilityList
};
