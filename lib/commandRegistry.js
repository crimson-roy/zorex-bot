"use strict";

// Public knowledge registry for Zorex.
//
// IMPORTANT:
// Racing Life knowledge in this file comes ONLY from the shareable
// Friends & Testers project overview. The confidential developer GDD
// must never be copied into this registry or passed to public .ask/.ai
// conversations.

const CATEGORY_SUMMARIES = {
    "ai": "AI, image generation, memory/relationship features and Zorex help.",
    "games": "Lightweight multiplayer/chat games.",
    "economy": "Registration, profile money, work, rewards, shopping and economy activities.",
    "profile": "Profile details such as age and bio.",
    "investments": "Investment, portfolio and asset-related commands.",
    "company": "Create, grow and manage player companies, employees, offers and company assets.",
    "jobs": "Browse jobs, apply, inspect employment and perform duties.",
    "cards": "Search, collect, claim, trade/use and browse Zorex cards.",
    "auction": "Card auction viewing, bidding and owner auction-management tools.",
    "casino": "Casino and chance-based Zorex games.",
    "downloader": "Download supported media from online sources.",
    "media": "Image/video/sticker conversion and editing tools.",
    "group": "Group administration and group utility commands.",
    "social": "Fun social interactions and relationship commands.",
    "school": "School/document learning tools.",
    "utilities": "General Zorex utility commands.",
    "owner": "Restricted owner administration commands.",
    "main-owner": "Commands reserved for the main owner."
};

const COMMANDS = [
    {
        name: "ask",
        aliases: [],
        category: "ai",
        usage: ".ask <question>",
        description: "Explains Zorex commands, systems and approved public project information.",
        keywords: ["help", "commands", "how", "zorex", "explain"],
        access: "public",
        mutatesData: false
    },
    {
        name: "ai",
        aliases: [],
        category: "ai",
        usage: ".ai <question or request>",
        description: "General Zorex AI assistant for questions, files, images and other AI tasks.",
        keywords: ["assistant", "question", "document", "file", "image"],
        access: "public",
        mutatesData: false
    },
    {
        name: "image",
        aliases: [],
        category: "ai",
        usage: ".image <prompt>",
        description: "Generates a new image from a text prompt.",
        keywords: ["generate", "art", "picture", "wallpaper"],
        access: "public",
        mutatesData: false
    },
    {
        name: "relation",
        aliases: [],
        category: "ai",
        usage: ".relation",
        description: "Shows or works with the bot's relationship system.",
        keywords: ["relationship", "chloe"],
        access: "public",
        mutatesData: false
    },
    {
        name: "mem",
        aliases: [],
        category: "ai",
        usage: ".mem",
        description: "Works with Zorex's AI memory feature.",
        keywords: ["memory", "remember"],
        access: "public",
        mutatesData: true
    },

    {
        name: "register",
        aliases: [],
        category: "economy",
        usage: ".register YOUR_NAME",
        description: "Creates your Zorex user account. New registrations currently receive the normal starting account/profile and registration bonus.",
        examples: [".register Crimson Roy"],
        keywords: ["account", "signup", "sign up", "new user"],
        access: "public",
        mutatesData: true
    },
    {
        name: "profile",
        aliases: [],
        category: "economy",
        usage: ".profile",
        description: "Shows your registered Zorex profile.",
        keywords: ["account", "user", "stats"],
        access: "public",
        mutatesData: false
    },
    {
        name: "bal",
        aliases: ["balance"],
        category: "economy",
        usage: ".bal",
        description: "Shows your Zorex money balance.",
        keywords: ["money", "wallet", "bank", "balance"],
        access: "public",
        mutatesData: false
    },
    {
        name: "dep",
        aliases: [],
        category: "economy",
        usage: ".dep <amount>",
        description: "Economy deposit command.",
        keywords: ["deposit", "bank"],
        access: "public",
        mutatesData: true
    },
    {
        name: "wd",
        aliases: [],
        category: "economy",
        usage: ".wd <amount>",
        description: "Economy withdrawal command.",
        keywords: ["withdraw", "bank"],
        access: "public",
        mutatesData: true
    },
    {
        name: "donate",
        aliases: [],
        category: "economy",
        usage: ".donate <amount> @user",
        description: "Transfers/donates Zorex currency to another user.",
        keywords: ["give money", "transfer"],
        access: "public",
        mutatesData: true
    },
    {
        name: "daily",
        aliases: [],
        category: "economy",
        usage: ".daily",
        description: "Claims the available daily economy reward.",
        keywords: ["reward", "money"],
        access: "public",
        mutatesData: true
    },
    {
        name: "work",
        aliases: [],
        category: "economy",
        usage: ".work",
        description: "Performs the standard Zorex work activity for economy progress/rewards.",
        keywords: ["job", "earn", "money"],
        access: "public",
        mutatesData: true
    },
    {
        name: "shop",
        aliases: [],
        category: "economy",
        usage: ".shop",
        description: "Opens or works with the Zorex economy shop.",
        keywords: ["buy", "items"],
        access: "public",
        mutatesData: true
    },
    {
        name: "rich",
        aliases: [],
        category: "economy",
        usage: ".rich",
        description: "Shows the richest-user leaderboard using registered users' economy totals.",
        keywords: ["leaderboard", "richest", "wealth"],
        access: "public",
        mutatesData: false
    },

    {
        name: "age",
        aliases: [],
        category: "profile",
        usage: ".age",
        description: "Shows age/profile age information.",
        keywords: ["profile"],
        access: "public",
        mutatesData: false
    },
    {
        name: "bio",
        aliases: [],
        category: "profile",
        usage: ".bio",
        description: "Shows profile bio information.",
        keywords: ["profile"],
        access: "public",
        mutatesData: false
    },
    {
        name: "setage",
        aliases: [],
        category: "profile",
        usage: ".setage <age>",
        description: "Sets the age on your registered Zorex profile.",
        keywords: ["profile", "change age"],
        access: "public",
        mutatesData: true
    },
    {
        name: "setbio",
        aliases: [],
        category: "profile",
        usage: ".setbio <bio>",
        description: "Sets the bio on your registered Zorex profile.",
        keywords: ["profile", "change bio"],
        access: "public",
        mutatesData: true
    },

    {
        name: "company",
        aliases: [],
        category: "company",
        usage: ".company",
        description: "Shows your company status, including company progress and wallet information when you own a company.",
        keywords: ["business", "firm", "company status"],
        access: "public",
        mutatesData: false
    },
    {
        name: "companycreate",
        aliases: [],
        category: "company",
        usage: ".companycreate <company name> <industry>",
        description: "Creates a company for a registered user when the required conditions and funds are met.",
        examples: [".companycreate Roy Trading Group animation"],
        keywords: ["business", "create company", "start company"],
        access: "public",
        mutatesData: true
    },
    {
        name: "companyupgrade",
        aliases: [],
        category: "company",
        usage: ".companyupgrade",
        description: "Upgrades your company level when requirements are met. Higher company levels increase company growth/income systems.",
        keywords: ["upgrade business", "company level"],
        access: "public",
        mutatesData: true
    },
    {
        name: "company deposit",
        aliases: [],
        category: "company",
        usage: ".company deposit <asset type> <amount>",
        description: "Moves supported personal assets/currency into your company holdings.",
        examples: [".company deposit crescent 50000", ".company deposit gold 2"],
        keywords: ["company wallet", "deposit company", "company assets"],
        access: "public",
        mutatesData: true
    },
    {
        name: "company distribute",
        aliases: [],
        category: "company",
        usage: ".company distribute ...",
        description: "Company-management command for distributing supported company resources. Exact arguments are shown by the command when needed.",
        keywords: ["company", "distribute"],
        access: "public",
        mutatesData: true
    },
    {
        name: "company assign",
        aliases: [],
        category: "company",
        usage: ".company assign ...",
        description: "Company-management command for assigning supported employee/company roles. Exact arguments are shown by the command when needed.",
        keywords: ["employee", "role", "assign"],
        access: "public",
        mutatesData: true
    },
    {
        name: "company promote",
        aliases: [],
        category: "company",
        usage: ".company promote ...",
        description: "Company-management command for promoting supported employees/roles.",
        keywords: ["employee", "promotion"],
        access: "public",
        mutatesData: true
    },
    {
        name: "companyoffer",
        aliases: [],
        category: "company",
        usage: ".companyoffer <position>",
        description: "Opens a job position at your company when the position and staffing rules allow it.",
        keywords: ["hire", "job opening", "employee"],
        access: "public",
        mutatesData: true
    },
    {
        name: "companyoffers",
        aliases: [],
        category: "company",
        usage: ".companyoffers",
        description: "Shows your company's open offers, applicants and filled positions.",
        keywords: ["applications", "jobs", "employees"],
        access: "public",
        mutatesData: false
    },
    {
        name: "companyapprove",
        aliases: [],
        category: "company",
        usage: ".companyapprove <position> @user",
        description: "Approves a specific pending applicant for an open company position.",
        examples: [".companyapprove background artist @user"],
        keywords: ["hire", "approve applicant"],
        access: "public",
        mutatesData: true
    },
    {
        name: "hire",
        aliases: [],
        category: "company",
        usage: ".hire <offer #>",
        description: "Company hiring command used with an offer number.",
        keywords: ["employee", "applicant"],
        access: "public",
        mutatesData: true
    },
    {
        name: "employees",
        aliases: [],
        category: "company",
        usage: ".employees",
        description: "Shows company employee information.",
        keywords: ["staff", "workers"],
        access: "public",
        mutatesData: false
    },
    {
        name: "companyassets",
        aliases: [],
        category: "company",
        usage: ".companyassets",
        description: "Shows company-held assets.",
        keywords: ["business assets", "holdings"],
        access: "public",
        mutatesData: false
    },

    {
        name: "joboffers",
        aliases: [],
        category: "jobs",
        usage: ".joboffers",
        description: "Shows available player-company job offers.",
        keywords: ["jobs", "work", "employment"],
        access: "public",
        mutatesData: false
    },
    {
        name: "jobapply",
        aliases: [],
        category: "jobs",
        usage: ".jobapply ...",
        description: "Applies to an available job offer.",
        keywords: ["job application", "employment"],
        access: "public",
        mutatesData: true
    },
    {
        name: "job",
        aliases: [],
        category: "jobs",
        usage: ".job",
        description: "Shows current employment/job information.",
        keywords: ["employment"],
        access: "public",
        mutatesData: false
    },
    {
        name: "jobinfo",
        aliases: [],
        category: "jobs",
        usage: ".jobinfo",
        description: "Shows information about the current job/employment system.",
        keywords: ["employment", "job details"],
        access: "public",
        mutatesData: false
    },
    {
        name: "duty",
        aliases: [],
        category: "jobs",
        usage: ".duty",
        description: "Performs the current job-duty/attendance action when employed.",
        keywords: ["work", "employee", "shift"],
        access: "public",
        mutatesData: true
    },

    {
        name: "cs",
        aliases: [],
        category: "cards",
        usage: ".cs <card name> [tier]",
        description: "Searches the Zorex card database by card name, with an optional tier.",
        examples: [".cs Rem SSR"],
        keywords: ["card search", "find card"],
        access: "public",
        mutatesData: false
    },
    {
        name: "ss",
        aliases: [],
        category: "cards",
        usage: ".ss <series>",
        description: "Searches/browses cards by series.",
        keywords: ["series search", "anime cards"],
        access: "public",
        mutatesData: false
    },
    {
        name: "cshop",
        aliases: [],
        category: "cards",
        usage: ".cshop",
        description: "Opens or works with the card shop.",
        keywords: ["card shop", "buy cards"],
        access: "public",
        mutatesData: true
    },
    {
        name: "col",
        aliases: [],
        category: "cards",
        usage: ".col",
        description: "Shows your card collection.",
        keywords: ["collection", "cards"],
        access: "public",
        mutatesData: false
    },
    {
        name: "inv",
        aliases: [],
        category: "cards",
        usage: ".inv",
        description: "Shows your inventory.",
        keywords: ["inventory", "items", "cards"],
        access: "public",
        mutatesData: false
    },
    {
        name: "claim",
        aliases: [],
        category: "cards",
        usage: ".claim ...",
        description: "Claims a supported card/reward when eligible.",
        keywords: ["cards", "claim"],
        access: "public",
        mutatesData: true
    },
    {
        name: "give",
        aliases: [],
        category: "cards",
        usage: ".give ...",
        description: "Transfers a supported card/item to another user.",
        keywords: ["card transfer", "gift"],
        access: "public",
        mutatesData: true
    },
    {
        name: "cardlb",
        aliases: [],
        category: "cards",
        usage: ".cardlb",
        description: "Shows the card leaderboard.",
        keywords: ["cards", "leaderboard"],
        access: "public",
        mutatesData: false
    },

    {
        name: "casino",
        aliases: [],
        category: "casino",
        usage: ".casino <amount>",
        description: "Plays one Zorex Casino round using the specified wager, subject to wallet, cooldown and daily-limit rules.",
        examples: [".casino 5000"],
        keywords: ["gamble", "bet"],
        access: "public",
        mutatesData: true
    },
    {
        name: "slots",
        aliases: [],
        category: "casino",
        usage: ".slots <amount>",
        description: "Plays one Zorex Slots round using the specified wager, subject to wallet, cooldown and daily-limit rules.",
        examples: [".slots 1000"],
        keywords: ["slot", "gamble", "bet"],
        access: "public",
        mutatesData: true
    },
    {
        name: "mines",
        aliases: [],
        category: "casino",
        usage: ".mines <mine count> <bet>",
        description: "Starts Zorex Mines. Choose the mine count and wager, then uncover safe tiles and cash out before hitting a mine.",
        examples: [".mines 5 10000"],
        keywords: ["gamble", "bet", "mines game"],
        access: "public",
        mutatesData: true
    },
    {
        name: "shovel",
        aliases: [],
        category: "casino",
        usage: ".shovel <tile>",
        description: "Opens a selected tile during an active Mines game.",
        keywords: ["mines", "tile"],
        access: "public",
        mutatesData: true
    },
    {
        name: "cashout",
        aliases: [],
        category: "casino",
        usage: ".cashout",
        description: "Cashes out the current active Mines game when allowed.",
        keywords: ["mines", "winnings"],
        access: "public",
        mutatesData: true
    },
    {
        name: "gamble",
        aliases: [],
        category: "casino",
        usage: ".gamble",
        description: "Shows the Zorex gambling/casino hub and available games.",
        keywords: ["casino", "games"],
        access: "public",
        mutatesData: false
    },

    {
        name: "sticker",
        aliases: ["s"],
        category: "media",
        usage: ".sticker [text] [(author)]",
        description: "Turns replied image/video media into a square WhatsApp sticker. .s is an alias. Text before parentheses is drawn on the sticker; final parenthesized text is used as sticker author metadata.",
        examples: [".s Legend", ".s (Made by Zorex)", ".s Legend (Made by Zorex)"],
        keywords: ["sticker", "webp", "square", "caption"],
        access: "public",
        mutatesData: false
    },
    {
        name: "toimage",
        aliases: ["toimg"],
        category: "media",
        usage: ".toimage",
        description: "Converts a replied sticker into an image.",
        keywords: ["sticker", "png"],
        access: "public",
        mutatesData: false
    },
    {
        name: "tovid",
        aliases: [],
        category: "media",
        usage: ".tovid",
        description: "Converts a replied sticker into a video.",
        keywords: ["sticker", "video"],
        access: "public",
        mutatesData: false
    },

    {
        name: "inviteowner",
        aliases: [],
        category: "group",
        usage: ".inviteowner",
        description: "Group-admin/owner command that privately sends the main owner an invite link for the current group; the owner decides whether to join.",
        keywords: ["owner", "group invite"],
        access: "admin-or-owner",
        mutatesData: false
    },
    {
        name: "tagall",
        aliases: [],
        category: "group",
        usage: ".tagall",
        description: "Mentions group members. Restricted to owner/group admins.",
        keywords: ["mention everyone", "group"],
        access: "admin-or-owner",
        mutatesData: false
    },
    {
        name: "open",
        aliases: [],
        category: "group",
        usage: ".open",
        description: "Opens the group for member messages when permitted.",
        keywords: ["group", "admin"],
        access: "admin",
        mutatesData: true
    },
    {
        name: "close",
        aliases: [],
        category: "group",
        usage: ".close",
        description: "Closes/restricts the group for member messages when permitted.",
        keywords: ["group", "admin"],
        access: "admin",
        mutatesData: true
    },

    ...[
        ["hug", ".hug @user", "Hugs a mentioned user or the author of a replied message."],
        ["kiss", ".kiss @user", "Gives a playful social kiss to a mentioned/replied user."],
        ["slap", ".slap @user", "Sends a playful slap social action."],
        ["pat", ".pat @user", "Pats a mentioned/replied user."],
        ["poke", ".poke @user", "Pokes a mentioned/replied user."],
        ["cuddle", ".cuddle @user", "Cuddles a mentioned/replied user."],
        ["bite", ".bite @user", "Sends a playful bite social action."],
        ["highfive", ".highfive @user", "High-fives a mentioned/replied user."],
        ["kill", ".kill @user", "Sends a deliberately fictional/playful elimination social action."],
        ["dance", ".dance", "Makes your Zorex social persona dance."]
    ].map(([name, usage, description]) => ({
        name,
        aliases: [],
        category: "social",
        usage,
        description,
        keywords: ["social", "fun"],
        access: "public",
        mutatesData: false
    })),

    {
        name: "menu",
        aliases: [],
        category: "utilities",
        usage: ".menu",
        description: "Shows the current Zorex command menu.",
        keywords: ["commands", "help"],
        access: "public",
        mutatesData: false
    },
    {
        name: "owner",
        aliases: [],
        category: "utilities",
        usage: ".owner",
        description: "Shows public Zorex owner/contact information.",
        keywords: ["lord crimson", "contact"],
        access: "public",
        mutatesData: false
    },

    // Commands that are visible in the live menu but do not yet have
    // detailed registry documentation. .ask should never invent missing
    // syntax/behavior for these.
    ...[
        ["wcg start", "games"], ["wcg join", "games"], ["trivia", "games"], ["ttt", "games"],
        ["crime", "economy"], ["rob", "economy"], ["beg", "economy"], ["fish", "economy"],
        ["sell", "economy"], ["dig", "economy"],
        ["invest", "investments"], ["portfolio", "investments"], ["assets", "investments"],
        ["company disapprove", "company"], ["oversee", "company"], ["fire", "company"],
        ["auction", "auction"], ["auctionbid", "auction"], ["auctioncards", "auction"],
        ["cf", "casino"], ["dice", "casino"], ["aviator", "casino"], ["roulette", "casino"],
        ["poker", "casino"], ["bj", "casino"], ["hit", "casino"], ["stand", "casino"],
        ["double", "casino"], ["raffle", "casino"],
        ["play", "downloader"], ["yt", "downloader"], ["vv", "downloader"],
        ["ttk", "downloader"], ["media", "downloader"],
        ["enhance", "media"], ["fix", "media"], ["graph", "media"], ["silhouette", "media"],
        ["upscale", "media"], ["fps", "media"], ["bitrate", "media"],
        ["afk", "group"], ["hidetag", "group"], ["antilink", "group"], ["setwarnings", "group"],
        ["resetwarnings", "group"], ["mute", "group"], ["unmute", "group"], ["promote", "group"],
        ["demote", "group"], ["kick", "group"], ["setwelcome", "group"], ["setleave", "group"],
        ["invite", "group"],
        ["marry", "social"], ["marryaccept", "social"], ["marrydecline", "social"], ["divorce", "social"],
        ["slides", "school"], ["teach", "school"],
        ["ping", "utilities"], ["test", "utilities"], ["mycds", "utilities"], ["mydls", "utilities"],
        ["d", "utilities"],
        ["restart", "owner"], ["commandoff", "owner"], ["commandon", "owner"], ["cardoff", "owner"],
        ["cardon", "owner"], ["setrole", "owner"], ["addcrescent", "owner"], ["spawn", "owner"],
        ["addcard", "owner"], ["rcard", "owner"], ["fixcompany", "owner"],
        ["broadcast", "main-owner"], ["removecrescent", "main-owner"], ["addowner", "main-owner"],
        ["removeowner", "main-owner"], ["resetcd", "main-owner"], ["resetdl", "main-owner"],
        ["resetbal", "main-owner"], ["reseteconomy", "main-owner"], ["hb", "main-owner"]
    ].map(([name, category]) => ({
        name,
        aliases: [],
        category,
        usage: `.${name}`,
        description: "This command exists in Zorex, but its detailed public help has not yet been added to the command registry. Do not invent missing arguments or rules.",
        keywords: [name],
        access:
            category === "main-owner"
                ? "main-owner"
                : category === "owner"
                    ? "owner"
                    : "public",
        mutatesData: null
    }))
];

const ZOREX_PUBLIC_INFO = `
Zorex is a WhatsApp bot ecosystem with AI, economy, companies, jobs, cards,
casino games, media tools, group tools, social commands and school utilities.
The command prefix is ".".
The public owner identity shown by the bot is Lord Crimson.
.ask is the help/knowledge assistant for explaining Zorex itself.
.ai is the broader personal AI assistant.
`.trim();

const RACING_LIFE_PUBLIC_KNOWLEDGE = `
RACING LIFE — PUBLIC / FRIENDS & TESTERS KNOWLEDGE ONLY

Identity:
Racing Life is a persistent racing career, multiplayer life world and long-term
social simulation. The player is meant to live a racing life rather than simply
pick races from menus. Racing remains the central profession while the larger
world is planned to support careers, family, fame, crime/law, property, social
media, travel, creator culture and long-term consequences.

Public design goals:
- Start with little and build skill, reputation, income, relationships and career.
- Victories and failures should change future opportunities rather than simply reset.
- Real players should fill world roles where practical while NPCs keep services/world activity reliable.
- Time, travel, money, relationships and reputation matter without making the game endless chores.
- Major setbacks such as losing championships, dismissal, prison, injury, retirement and rare true death can create new paths.
- Long-term fantasy: rise from unknown racer to champion, property/company owner,
  family figure, wealthy or infamous public figure, retire, and leave a legacy.

Current publicly shareable development status:
- Existing 2D racing prototype includes playable car controls, several track themes,
  AI racers, lap tracking, collisions, finish order and result updates.
- Career UI tracks racer name, team, manager trust, reputation, money, season/week
  and recent race history.
- Profile setup includes player name, age, appearance options and local profile saving.
- Development is transitioning toward Three.js 3D scenes for racing, home and free roam,
  with imported glTF/GLB environments/tracks.
- Next public milestone: move racing into 3D with a real circuit and drivable car, then
  reconnect career systems around the 3D race.

Game structure:
- Career/local progression: personal career, managers, AI professional events,
  story beats and local competition.
- Multiplayer free roam: shared online world for travel, jobs, social life, crime,
  families, creator activity and economy.
- Online professional competition: qualified factions use real players in structured
  5v5 competition.
- Special story experiences: tighter scripted modes for licensed collaborations/events.

Public free-roam direction:
- Free roam is intended to be online-only, not a local/offline sandbox.
- Planned spaces include cities, lower-income/slum districts, homes, businesses,
  race venues, airports, police facilities, hospitals and social spaces.
- Players can drive/walk/travel, buy property, meet real players, join jobs/events,
  commit crimes or follow lawful careers, and focus on racing/family if they prefer.

Public profession examples:
Professional racer, driver, pilot, police officer, criminal path, lawyer,
footballer and artist/creator. These are intended to be added gradually.

Public professional-racing model:
- A faction is the larger racer organization/pool.
- A team is the racers selected for a particular matchup.
- The current public concept uses five individual 1v1 races in a 5v5 faction matchup.
- First faction to three wins takes the matchup; a 2-2 score makes the fifth race decisive.
- Local championships/World Cup are AI-driven career events.
- Online championships/World Cup are intended for qualified real-player factions.

Public life/economy/social direction:
- Career income, race winnings, contracts, sponsorships, cars, houses, businesses,
  wealth rankings, trophies and titles can contribute to progression/status.
- An in-world social network can support profiles, followers, gameplay posts,
  likes/comments/reposts, trends and fame.
- Artist/creator careers can release original music and build an in-world audience.
- Creator real-money payout concepts are later-stage and depend on legal/compliance,
  fraud prevention and platform/payment rules; they are not required for the first playable world.
- Family systems can include spouse/children, home routines, relationship reactions,
  aging and long-term legacy continuation.
- Crime has persistent consequences such as fines, records, prison or career loss.
- Serious prison terms may use personal time skips rather than forcing literal waiting.
- Injury has severity levels; true death is intended to be rare and can lead to a
  legacy/new-life continuation instead of ending the account experience.

HOME:
HOME is a planned in-world support organization where players can report bugs,
harassment/bullying or suspicious behavior, submit moderation/account appeals,
receive appropriate explanations and provide their player UID/evidence.

Public development priorities:
Build the 3D racing foundation first, reconnect career systems, build faction/local
championship flow, add a small 3D home/free-roam district, then persistence/economy,
limited multiplayer free roam, and only gradually expand professions/social/family/
crime/creator systems. Online championships/World Cups come after networking and
competitive integrity are stable.

Public guardrails:
Racing remains the foundation. Player history matters. The world should feel alive
without endless chores. Premium spending may support style/status/convenience, but
competitive success should still depend mainly on skill, preparation and career decisions.
True death should be rare. Creator systems require strong copyright/safety/fraud/payout
controls before real-money withdrawal features.

CONFIDENTIALITY BOUNDARY:
This knowledge intentionally excludes developer-only implementation details, exact
anti-cheat logic, local development addresses, unreleased internal rules, security
architecture, backend boundaries and other confidential GDD material.
If asked for developer secrets/internal GDD information, say that information is
developer-only and is not available through Zorex's public assistant. Never invent it.
`.trim();

const STOP_WORDS = new Set([
    "a","an","and","are","can","command","commands","do","does","for","how",
    "i","in","is","it","me","my","of","on","please","the","to","what","whats",
    "with","you","zorex","tell","explain"
]);

function normalize(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^p{L}p{N}.]+/gu, " ")
        .replace(/s+/g, " ")
        .trim();
}

function commandKeys(entry) {
    return [
        entry.name,
        ...(entry.aliases || [])
    ].map(normalize);
}

function exactCommandMatches(query) {
    const explicit =
        String(query || "")
            .match(/.[a-z][a-z0-9]*(?:s+[a-z]+)?/gi) ||
        [];

    if (!explicit.length) {
        return [];
    }

    const values =
        explicit.map(value =>
            normalize(
                value.replace(/^./, "")
            )
        );

    return COMMANDS.filter(entry =>
        commandKeys(entry)
            .some(key =>
                values.includes(key)
            )
    );
}

function tokensFor(query) {
    return normalize(query)
        .replace(/./g, " ")
        .split(/s+/)
        .filter(token =>
            token &&
            !STOP_WORDS.has(token)
        );
}

function scoreEntry(entry, queryTokens, normalizedQuery) {
    const name =
        normalize(entry.name);

    const category =
        normalize(entry.category);

    const aliases =
        (entry.aliases || [])
            .map(normalize);

    const haystack =
        normalize([
            entry.name,
            ...(entry.aliases || []),
            entry.category,
            entry.usage,
            entry.description,
            ...(entry.keywords || []),
            ...(entry.examples || [])
        ].join(" "));

    let score = 0;

    if (
        normalizedQuery.includes(name) &&
        name.length >= 2
    ) {
        score += 10;
    }

    if (
        normalizedQuery.includes(category)
    ) {
        score += 5;
    }

    for (const alias of aliases) {
        if (
            alias &&
            normalizedQuery.includes(alias)
        ) {
            score += 8;
        }
    }

    for (const token of queryTokens) {
        if (name === token) score += 8;
        else if (name.includes(token)) score += 4;

        if (category === token) score += 4;

        if (haystack.includes(token)) {
            score += 2;
        }
    }

    return score;
}

function formatCommand(entry) {
    const examples =
        entry.examples?.length
            ? `Examples: ${entry.examples.join(" | ")}`
            : "";

    return [
        `Command: .${entry.name}`,
        `Usage: ${entry.usage}`,
        `Category: ${entry.category}`,
        `Access: ${entry.access}`,
        `Description: ${entry.description}`,
        examples
    ]
        .filter(Boolean)
        .join("\n");
}

function shouldIncludeRacingLife(query) {
    return /\b(racing life|racinglife|free roam|world cup|faction|legacy|home support|creator culture|racing game)\b/i
        .test(String(query || ""));
}

function isGeneralCommandQuestion(query) {
    return /\b(commands?|menu|what can zorex do|features?|help)\b/i
        .test(String(query || ""));
}

function buildKnowledgeContext(query) {
    const normalizedQuery =
        normalize(query);

    const queryTokens =
        tokensFor(query);

    const exact =
        exactCommandMatches(query);

    const scored =
        COMMANDS
            .map(entry => ({
                entry,
                score:
                    scoreEntry(
                        entry,
                        queryTokens,
                        normalizedQuery
                    )
            }))
            .filter(item =>
                item.score > 0
            )
            .sort((a, b) =>
                b.score - a.score
            )
            .map(item =>
                item.entry
            );

    const selected = [];
    const seen = new Set();

    for (const entry of [...exact, ...scored]) {
        const key =
            `${entry.category}:${entry.name}`;

        if (seen.has(key)) continue;

        seen.add(key);
        selected.push(entry);

        if (selected.length >= 12) {
            break;
        }
    }

    const blocks = [
        "ZOREX PUBLIC INFO",
        ZOREX_PUBLIC_INFO
    ];

    if (isGeneralCommandQuestion(query)) {
        blocks.push(
            "COMMAND CATEGORIES",
            Object.entries(CATEGORY_SUMMARIES)
                .map(
                    ([name, description]) =>
                        `${name}: ${description}`
                )
                .join("\n")
        );
    }

    if (selected.length) {
        blocks.push(
            "RELEVANT COMMANDS",
            selected
                .map(formatCommand)
                .join("\n\n")
        );
    }

    if (shouldIncludeRacingLife(query)) {
        blocks.push(
            RACING_LIFE_PUBLIC_KNOWLEDGE
        );
    }

    return {
        context:
            blocks.join("\n\n---\n\n"),
        hasSpecificKnowledge:
            selected.length > 0 ||
            shouldIncludeRacingLife(query) ||
            isGeneralCommandQuestion(query),
        matchedCommands:
            selected
    };
}

module.exports = {
    COMMANDS,
    CATEGORY_SUMMARIES,
    ZOREX_PUBLIC_INFO,
    RACING_LIFE_PUBLIC_KNOWLEDGE,
    buildKnowledgeContext
};
