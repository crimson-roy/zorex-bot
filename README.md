# Zorex

**Zorex is a modular WhatsApp automation platform built with Node.js and Baileys.**  
It combines conversational AI, a persistent virtual economy, community tools, games, collectibles, media utilities, and an experimental WhatsApp-native video editing pipeline.

Zorex is under active development and is designed as a real, maintainable bot platform rather than a single monolithic command script.

---

## Why Zorex exists

Most WhatsApp bots stop at simple command/reply interactions. Zorex is being developed around a broader idea:

> **Use WhatsApp as an interface for intelligent automation, persistent systems, and creative workflows.**

That includes ordinary bot features such as moderation, games and economy systems, but also more ambitious workflows such as asking Zorex AI to understand a natural-language request, validate it against the user's real permissions and state, then safely execute the underlying bot or editing action.

A major current focus is **editing media directly from WhatsApp**.

---

## Core capabilities

### Zorex AI

Zorex AI is the orchestration layer for natural-language actions.

It can interpret requests and route them into supported bot capabilities instead of directly mutating data. Examples include:

- checking account, profile, company, inventory and collection information
- deposits, withdrawals and transfers
- company upgrades
- shop and card-shop purchases
- group moderation actions
- card and series searches
- supported casino/game actions
- media generation and editing jobs
- editor queue inspection and cancellation

The design rule is simple:

> **Zorex AI may automate actions the user is already allowed to perform, but it must not grant permissions, currency, upgrades or rule bypasses that the normal command system would reject.**

For example, AI-driven company upgrades use the same validation logic as the public company command. A request such as:

```text
.ai max upgrade my company
```

continues upgrading only while the normal game rules allow it, then stops at the first legitimate blocker such as the maximum level, an employee requirement or insufficient balance.

Sensitive or high-exposure actions can require explicit confirmation and identity verification before execution.

---

## WhatsApp-native editing

One of the most active areas of Zorex development is a native editing system designed around the idea that a user should be able to reply to media and describe the edit they want.

Examples:

```text
.ai apply a smooth zoom out with z_ease and max zoom 125
.ai study this edit
.edit cinematic_push
.upscale 4 quality
```

### Current editor capabilities

The editing stack currently includes:

- a native frame-by-frame timeline renderer
- transform and keyframe animation presets
- zoom, pan, shake, bounce and cinematic push animations
- named easing/graph presets
- color correction
- blur, sharpen and denoise controls
- glow and vignette effects
- opacity control
- rectangle, ellipse and polygon mask support
- reusable velocity/edit-style presets
- reference-video analysis
- compact editing fingerprints
- Real-ESRGAN-based image and video enhancement
- persistent editor jobs
- remote worker claiming
- queue inspection and cancellation
- automatic delivery of completed outputs back to the originating WhatsApp chat

### Editor architecture

```text
WhatsApp message / replied media
            │
            ▼
       Zorex AI router
            │
            ▼
 Structured action / timeline
            │
            ▼
     Persistent editor job
            │
      ┌─────┴──────────────┐
      │                    │
      ▼                    ▼
Native renderer       Remote GPU worker
      │                    │
      └─────────┬──────────┘
                ▼
         Finished output
                │
                ▼
       Auto-delivery to chat
```

Heavy jobs are separated from the WhatsApp connection process so the bot can remain responsive while a compatible worker performs rendering, enhancement or analysis.

See:

- [Editor timeline documentation](docs/EDITOR_TIMELINE.md)
- [Editor worker documentation](docs/EDITOR_WORKER.md)

### Reference-study system

Zorex can analyze a reference edit and store a compact description of useful characteristics rather than retaining the source video indefinitely.

The current analyzer can extract information such as:

- cut candidates
- visual peaks
- flashes
- brightness, contrast and saturation statistics
- basic beat/alignment information
- reverse-motion candidates
- source limitations and confidence

Future work includes stronger optical-flow analysis, transform estimation, graph fitting, masks, transitions and reference-to-timeline transfer.

---

## AI companion

Zorex also includes **Chloe**, a stateful conversational AI companion integrated into the normal message flow.

Chloe can:

- be enabled or disabled per chat
- respond when mentioned, tagged, replied to or explicitly summoned
- keep short conversational context
- track trust and affection
- maintain relationship tiers
- store lightweight observations
- generate relationship reflections and statistics

The conversational AI layer is kept separate from command execution so provider logic and personality behavior can evolve without rewriting the rest of the bot.

---

## Economy, companies and jobs

Zorex contains a persistent virtual economy built around the in-bot currency **Crescents**.

Systems include:

- wallets and banks
- work and daily rewards
- shops
- investments
- portfolios
- companies
- employees and job offers
- Major companies
- duty/attendance systems
- auctions
- player-to-player transfers
- trading and collectibles

Company progression includes level caps, employee requirements and salary/income systems. AI automation is expected to obey the same economy rules as manual commands.

---

## Games and collectibles

Zorex includes several persistent and interactive game systems, including:

- Blackjack
- Casino
- Slots
- Roulette
- Dice
- Mines
- Trivia
- raffle systems
- card spawning and claiming
- card collections
- card search and series search
- card shop rotations
- auctions and trading

All wagers and rewards use **Crescents**, which are virtual in-bot currency only. Zorex does not provide real-money gambling, cash-out or conversion to real-world funds.

---

## Community and moderation

Group-management features include:

- group open/close controls
- anti-link protection
- warnings
- mute and unmute controls
- admin promotion/demotion
- kick actions
- command gating
- broadcasts
- owner/admin permission checks
- configurable welcome and leave messages
- AFK and tagging behavior

Permission-sensitive actions are validated by the real command handlers rather than trusted solely because they originated from AI.

---

## Media and document tools

Zorex also provides utilities for:

- image and video processing
- downloads
- animated sticker conversion
- video enhancement
- depth-video workflows
- image generation
- video generation through configured providers
- PDF parsing
- DOCX generation
- XLSX generation
- PowerPoint generation
- document summarization
- school/document browsing workflows

Some media workflows require external tools such as **FFmpeg**.

---

## Architecture

```text
zorex-bot/
├── index.js                 # WhatsApp connection, lifecycle and main router
├── commands/                # User-facing command handlers
├── lib/                     # Shared state, AI, editor and orchestration logic
├── workers/                 # Background / remote editor workers
├── providers/               # External media and AI provider integrations
├── docs/                    # Architecture and workflow documentation
├── bet/                     # Additional media/provider helpers
├── config.js                # Runtime configuration
├── package.json
├── wcg.js
└── vv.js
```

Important editor/AI modules include:

```text
lib/aiCommandExecutor.js
lib/commandRegistry.js
lib/editorAnimations.js
lib/editorDelivery.js
lib/editorFingerprints.js
lib/editorGraphs.js
lib/editorJobs.js
lib/editorKnowledge.js
lib/editorPresets.js
lib/editorStyleJobs.js
lib/editorStyles.js
lib/editorTimeline.js
lib/editorWorkerServer.js
lib/referenceAnalysisJobs.js

workers/editorWorker.js
workers/nativeTimelineRenderer.js
workers/referenceStyleAnalyzer.js
```

The codebase currently uses **CommonJS**.

---

## Technology

Primary technologies used by the project include:

- Node.js 20
- JavaScript
- Baileys
- FFmpeg
- Sharp
- Axios
- Real-ESRGAN worker integration
- Azure/OpenAI-compatible AI endpoints where configured
- Fal and other optional media providers
- DOCX, Excel, PDF and PowerPoint generation libraries

---

## Persistence

Persistent runtime data is routed through:

```text
lib/dataPath.js
```

Set `DATA_DIR` to a persistent directory:

```env
DATA_DIR=/absolute/path/to/zorex-data
```

This allows state such as economy data, editor jobs and other persistent bot data to survive normal process restarts or redeployments when the deployment environment provides persistent storage.

---

## Installation

### Requirements

- Node.js 20
- npm
- FFmpeg for media workflows that require it
- a WhatsApp account for development/testing
- provider credentials only for optional AI/media services being used

### Setup

```bash
git clone https://github.com/crimson-roy/zorex-bot.git
cd zorex-bot
npm install
npm start
```

To run an editor worker:

```bash
npm run editor-worker
```

Runtime secrets and provider credentials should be supplied through environment variables and should not be committed to the repository.

---

## Development workflow

Zorex is developed through focused feature branches and pull requests.

Recent work has concentrated on:

- safe AI command orchestration
- persistent identity/confirmation flows
- shared economy validators
- company and employment systems
- portfolio history repair
- native editing
- persistent rendering jobs
- remote GPU workers
- reference-style analysis
- media auto-delivery
- deployment reliability

Changes that affect economy or persistent state are designed so the public command path and AI path share business rules instead of maintaining separate rule sets.

---

## Current development direction

Near-term work includes:

- expanding safe AI bulk/max actions
- improving the WhatsApp editing UX
- richer editor progress reporting
- stronger reference-style analysis
- optical-flow and transform estimation
- improved masking and rotoscoping
- richer transition analysis
- reference-to-timeline transfer
- better worker recovery and scheduling
- dynamic Major-company vacancies and NPC staffing
- continued cleanup of shared UI/message formatting
- stronger tests and validation around persistent economy state

Longer-term editing goals include more advanced timeline operations, audio workflows, 2.5D/3D compositing and deeper AI-assisted editing while keeping executable actions explicit and inspectable.

---

## Security and responsible use

Zorex uses permission checks and moderation controls to reduce misuse.

Operators should:

- protect runtime credentials and session state
- restrict privileged commands
- follow WhatsApp/Meta rules
- respect user consent and community rules
- avoid spam, harassment, fraud, unauthorized access or privacy-invasive behavior

No automated safeguard can replace responsible administration and human moderation.

---

## Disclaimer

Zorex uses **Baileys**, an unofficial WhatsApp Web library.

This project is not affiliated with or endorsed by WhatsApp or Meta. Anyone deploying Zorex is responsible for complying with applicable platform terms, laws and community rules.

---

## Maintainer

Zorex is actively developed and maintained by **crimson-roy**.

The project is experimental in several areas, especially AI orchestration and WhatsApp-native media editing, and is being improved continuously through active development, testing and pull-request-based iteration.
