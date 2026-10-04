# Zorex WhatsApp Bot

Zorex is a modular WhatsApp bot built with **Node.js** and **Baileys**. It combines AI features, group tools, media utilities, games, economy systems, collectibles, jobs, companies, document helpers, and an in-chat AI companion named **Chloe**.

> **Status:** Active development. The bot is already functional, while its persistence, deployment, testing and public-release structure are still being improved.

## Highlights

### Chloe AI companion

Chloe is a stateful AI companion integrated into the normal message flow. She can:

- be enabled or disabled per chat with `.chaton` and `.chatoff`
- respond when mentioned, tagged, replied to, or explicitly summoned
- keep short conversational context
- track trust, affection and conversation history per user
- move through relationship tiers over time
- store short observations from previous conversations
- generate `.mem` reflections grounded in stored relationship data
- expose relationship statistics through `.relation`

The AI layer is separated from the rest of the command system so provider logic can be changed without rewriting the bot.

### Economy and progression

Zorex includes a persistent virtual economy with rewards, work, shops, investments, portfolios, auctions, companies, jobs and player-to-player trading systems.

The bot's virtual currency is called **Crescents**.

### Cards and collectibles

The bot includes card spawning, claiming, collections, inventories, leaderboards, series search, auctions, trading and administrative card tools.

### Games

The project contains several interactive game modules, including Blackjack, Trivia, Mines and other group-based minigames.

### Group tools

Zorex includes anti-link protection, warning controls, group open/close tools, tagging utilities, command gating, broadcasts and owner/admin permission checks.

### Media and document utilities

The project contains modules for media downloading, playback helpers, image/video upscaling, graphics tools, school slide browsing, document summarization and file-processing workflows.

Some media features require external tools such as `ffmpeg`.

### Editing inside WhatsApp

A major current development goal is to make **WhatsApp itself an editing interface** instead of forcing users to move between multiple editing apps for common workflows.

Zorex AI can interpret natural-language editing requests, turn them into structured editing actions and hand heavier work to persistent editor jobs. The current editing stack includes:

- a native frame-by-frame video timeline renderer
- reusable transform/keyframe animations such as zooms, pans, shakes and cinematic pushes
- named easing/graph presets for animation timing
- color correction, blur, sharpen, denoise, glow, vignette, opacity and basic mask support
- reusable velocity/edit-style presets
- reference-video analysis that extracts compact editing fingerprints rather than storing source videos
- Real-ESRGAN based image/video enhancement workers
- persistent editor jobs that can survive bot restarts
- remote worker claiming so higher-performance machines can process heavy jobs while the WhatsApp bot stays responsive
- queue inspection/cancellation and automatic delivery of completed media back to the originating chat

The long-term direction is a natural-language editing layer where a user can reply to media and say things such as:

```text
.ai apply a smooth zoom out with z_ease and max zoom 125
.ai study this edit
.upscale 4 quality
.edit cinematic_push
```

The AI layer is intended to **orchestrate real editor tools rather than bypass them**. Editing actions are represented as explicit jobs/timeline instructions so they can be inspected, validated, queued and executed by compatible workers.

Planned work includes stronger transform estimation, optical-flow analysis, improved masks/rotoscoping, transition analysis, better reference-to-timeline transfer, richer audio/timeline editing, and eventually more advanced 2.5D/3D compositing.

## Architecture

```text
zorex-bot/
├── index.js          # WhatsApp connection, lifecycle and main router
├── commands/         # Command handlers, AI routing and user-facing features
├── lib/              # Shared helpers, persistence, AI and editor orchestration
├── workers/          # Remote/background editor worker processes
├── providers/        # External media/AI provider integrations
├── bet/              # Additional media/provider helpers
├── config.js         # Runtime configuration
├── wcg.js            # Community game logic
├── vv.js             # Additional feature module
└── package.json
```

`index.js` creates the Baileys socket, handles connection lifecycle events and routes incoming messages to feature modules. The project currently uses **CommonJS**, with a dynamic import for Baileys 7.x.

## Persistence

Persistent JSON state is routed through `lib/dataPath.js`.

Set `DATA_DIR` to a directory that survives restarts or redeploys:

```env
DATA_DIR=/path/to/zorex-data
```

For local development, if `DATA_DIR` is not set, the project falls back to the current project directory.

Baileys authentication currently uses the local `auth/` directory on the main branch. Treat that directory as sensitive and never publish it.

## Requirements

- Node.js 20
- npm
- a WhatsApp account for testing
- `ffmpeg` for media features that need it
- API keys for whichever optional providers you enable

## Installation

```bash
git clone https://github.com/crimson-roy/zorex-bot.git
cd zorex-bot
npm install
```

Create a `.env` file for the services you use. Example:

```env
DATA_DIR=/absolute/path/to/zorex-data
AI_API_KEY=your_api_key_here
AI_MODEL=your_model_here
```

Never commit `.env`, API keys, WhatsApp credentials, session files or private account identifiers.

Start the bot:

```bash
npm start
```

On a new session, scan the QR code shown in the terminal.

## Chloe Commands

```text
.chaton               Enable Chloe in the current chat
.chatoff              Disable Chloe in the current chat
.chloe <message>      Explicitly talk to Chloe
.mem                  Show Chloe's in-character reflection
.relation             Show relationship statistics
```

## Safety, Responsible Use and Community Guidelines

Zorex is intended to be used in a way that respects applicable laws, WhatsApp rules, group rules, user consent and normal community standards.

The project includes moderation and permission systems intended to reduce misuse, including anti-link controls, warning systems, command gating, owner/admin permission checks and other safeguards. These protections are designed to discourage abuse and actions that conflict with community guidelines, but no automated safeguard can guarantee that every form of misuse will be prevented.

Users and deployers should not use Zorex for:

- spam or unsolicited mass messaging
- scams, fraud or impersonation
- harassment, threats or targeted abuse
- illegal activity
- bypassing platform restrictions or moderation systems
- unauthorized access, surveillance or collection of private information
- any activity that violates WhatsApp/Meta rules, local laws or the rules of the communities where the bot is deployed

The person operating a deployment is responsible for configuring the bot appropriately, controlling who receives privileged access, protecting authentication/session files and monitoring how the bot is used.

## Virtual Currency and Game-of-Chance Features

Some Zorex games use mechanics that resemble gambling, such as Blackjack, Mines and other chance-based activities. These features are **simulated game mechanics only**.

All wagers and rewards inside Zorex use the bot's virtual currency, **Crescents**.

- No real-world money is required to place a wager.
- No external funds are deposited into Zorex for these games.
- Crescents are an in-bot virtual currency and are not represented as real money.
- There is no cash-out, withdrawal or conversion from Crescents into real-world money through the bot.
- Zorex does not provide real-money gambling payouts or financial returns.

These systems are intended for entertainment and progression inside the bot's own virtual economy.

## Developer Responsibility and Limitations

The developer may make reasonable efforts to investigate and address bugs, service interruptions, security issues and other technical setbacks affecting the project. Because Zorex depends on third-party services, unofficial WhatsApp integration, external APIs and user-controlled deployments, uninterrupted operation cannot be guaranteed.

The developer is **not responsible for spam, illegal activity, harassment, abuse or other prohibited actions performed by users or third-party deployments of the bot**. Responsibility for those actions remains with the person performing them and, where applicable, the operator of the deployment that enabled them.

Safety measures are included to reduce the risk of misuse, and the project should be configured and operated in accordance with community guidelines and applicable rules. These safeguards are not a substitute for responsible administration and human moderation.

## Development Direction

Current work includes:

- turning Zorex AI into a safe natural-language orchestration layer for normal bot actions
- expanding the WhatsApp-native editing pipeline and persistent GPU/editor worker system
- improving native timeline rendering, animation graphs, editing presets and reference analysis
- improving Chloe's long-term persistence
- consolidating AI calls behind dedicated provider clients
- improving VPS deployment persistence and worker recovery
- cleaning old credentials and session data from Git history before a public release
- reducing hard-coded ownership assumptions
- improving session isolation and deployment architecture
- expanding documentation, validation and tests

A core design rule for AI-triggered economy/game actions is that **Zorex AI may automate actions a user is already allowed to perform, but it must not grant permissions, currency, upgrades or rule bypasses that the normal command system would reject**. Where AI provides convenience features such as bulk/max actions, the underlying validators remain the source of truth.

## Security

Keep the following out of Git:

```text
.env
auth/
session files
API keys
access tokens
private account identifiers
```

If a credential has ever been committed, removing it from the latest file is not enough. Rotate it and clean the repository history before making the repository public.

## Disclaimer

Zorex uses **Baileys**, an unofficial WhatsApp Web library. This project is not affiliated with or endorsed by WhatsApp or Meta. Anyone deploying the bot is responsible for complying with platform terms, applicable laws and the rules of the communities where the bot is used.

## Contributing

Contributions that improve modularity, persistence, reliability, documentation, tests, provider abstraction, moderation or safety are welcome as the project moves toward a cleaner public release.

Contributors should avoid adding features whose primary purpose is spam, abuse, fraud, privacy invasion or bypassing platform safety controls.

## License

A dedicated open-source license has not yet been added. Add one before treating this repository as a public open-source release.
