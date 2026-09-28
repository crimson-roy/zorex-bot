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
    ai: ["ask", "ai", "image", "relation", "mem"],
    games: ["wcg start", "wcg join", "trivia", "ttt"],
    economy: ["register", "profile", "bal", "dep", "wd", "donate", "daily", "work", "shop", "crime", "rob", "beg", "fish", "sell", "dig", "rich"],
    profile: ["age", "bio", "setage", "setbio"],
    investments: ["invest", "portfolio", "assets"],
    company: ["company", "companycreate", "companyupgrade", "company deposit", "company distribute", "company assign", "company promote", "companyoffers", "companyoffer", "companyapprove", "company disapprove", "hire", "employees", "oversee", "fire", "companyassets"],
    jobs: ["joboffers", "jobapply", "job", "jobinfo", "duty"],
    cards: ["ss", "cshop", "cs", "col", "inv", "claim", "give", "cardlb", "use"],
    auction: ["auction", "auctionbid", "auctioncards", "importauction", "auctionstart", "auctionend"],
    casino: ["gamble", "cf", "dice", "aviator", "slots", "roulette", "poker", "bj", "hit", "stand", "double", "mines", "shovel", "cashout", "raffle"],
    downloader: ["play", "yt", "vv", "ttk", "media"],
    media: ["enhance", "fix", "graph", "silhouette", "upscale", "fps", "bitrate", "sticker", "s", "toimage", "toimg", "tovid"],
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
        description: "General Zorex AI assistant for questions, documents, images and supported AI tasks."
    },
    image: {
        usage: ".image <prompt>",
        description: "Generates a new image from a text prompt."
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
    bal: {
        usage: ".bal",
        description: "Shows your Zorex money balance."
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
    hug: "Hugs a mentioned user or the author of a replied message.",
    kiss: "Sends a playful kiss social action.",
    slap: "Sends a playful slap social action.",
    pat: "Pats a mentioned or replied user.",
    poke: "Pokes a mentioned or replied user.",
    cuddle: "Sends a cuddle social action.",
    bite: "Sends a playful bite social action.",
    highfive: "High-fives a mentioned or replied user.",
    kill: "Sends a fictional/playful elimination social action.",
    dance: "Sends the user's dance social action."
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

const ZOREX_PUBLIC_INFO = `
Zorex is a WhatsApp bot ecosystem with AI, economy, companies, jobs, cards,
casino games, media tools, group utilities, social commands and school tools.
The command prefix is ".".
The public owner identity shown by the bot is Lord Crimson.
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
    ZOREX_PUBLIC_INFO,
    RACING_LIFE_PUBLIC_KNOWLEDGE,
    buildKnowledgeContext
};
