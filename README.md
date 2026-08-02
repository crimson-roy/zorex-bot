# Chloe WhatsApp Bot

## Files
- `lib/chloePersona.js` — Chloe's character/system prompt. Edit this file only
  when you want to tweak her voice — nothing else touches it.
- `lib/chloeMemory.js` — per-chat `.chaton`/`.chatoff` state + rolling message
  history (last 20 messages/chat), persisted to `data/chloeStore.json`.
- `lib/aiClient.js` — thin wrapper around the LLM call. Defaults to the
  Anthropic API; swap the fetch call if you're using OpenAI or something else.
- `commands/chloe.js` — the actual message handler. Wire `handleMessage(sock, msg)`
  into your Baileys `messages.upsert` event.

## Env vars
Uses Groq — free, no credit card required (~14,400 requests/day on Llama 3.3 70B):
1. Go to https://console.groq.com/keys
2. Sign up / log in, create a new API key
3. Put it in your `.env`:
```
AI_API_KEY=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
AI_MODEL=llama-3.3-70b-versatile   # optional, has a default
BOT_JID=64833370255602@lid
```

## Trigger logic
- `.chaton` — turns Chloe on for that chat. Always works.
- `.chatoff` — turns her off for that chat. Always works.
- `.chloe <message>` — explicit summon, works whether she's on or off.
- While ON: she replies if her name is said, she's @tagged, or someone
  replies directly to one of her messages. Every other message in the
  chat is still logged to her rolling memory (so she has context) but
  doesn't get a reply.
- While OFF: only `.chloe <message>` gets a response.

## Wiring into your existing index.js

Your `index.js` already has one big `messages.upsert` handler with an
`if / else if` chain on `text`, plus a standing `await moderationWatcher(sock, msg);`
call that runs on every message regardless of what it is. Follow that same
pattern:

**1. Add requires at the top of index.js**, alongside your other `require`s:
```js
const { handleMessage: chloeHandle } = require("./commands/chloe");
const { relationCommand } = require("./commands/relation");
const { memCommand } = require("./commands/mem");
```

**2. Right after `await moderationWatcher(sock, msg);`**, add:
```js
await moderationWatcher(sock, msg);
await chloeHandle(sock, msg); // decides internally whether Chloe should reply
```
This mirrors how `moderationWatcher` already runs unconditionally on every
message — `chloeHandle` does the same, quietly no-op'ing unless her trigger
conditions (`.chaton` active + name/tag/reply, or explicit `.chloe` summon)
are met. It does NOT go inside your `if/else if` chain.

**3. Add `.mem` and `.relation` as two more branches** in your existing
`if/else if` chain (anywhere among the others, e.g. near `.profile`):
```js
} else if (text === ".mem") {

    await memCommand(sock, msg);

} else if (text === ".relation") {

    await relationCommand(sock, msg);

}
```

## Relationship system (.mem / .relation)
- `lib/relationshipStore.js` — per-user trust/affection/conversation count,
  persisted to `data/relationships.json`. Tiers: stranger (0–2 trust),
  acquaintance (2–4), friend (4–6), bestfriend (6–8), crush (8–10), couple
  (exactly 10).
- `lib/relationshipEngine.js` — after every Chloe reply, one small AI call
  judges the exchange and nudges trust/affection by -0.3..+0.3, plus notes a
  short real behavioral observation (stored, capped at 8 most recent).
- `.relation` — pure stats readout, no AI call, matches your example format.
- `.mem` — AI-generated in-character reflection, grounded in the real stored
  observations rather than generic filler, tone shifts with trust level.

**Assumption I made:** trust/affection move automatically based on how the
AI judges each exchange (warmth, honesty, rudeness, etc.) rather than fixed
per-message increments or explicit commands. If you'd rather it work
differently (e.g. specific actions like gifts/compliments giving fixed
amounts), that's a change to `relationshipEngine.js` and/or `chloe.js` — let
me know and I'll adjust.

## Notes / things you'll likely want to adjust
- `MAX_HISTORY_PER_CHAT` in `chloeMemory.js` controls how much context she
  keeps per chat — bump it up if replies feel like they're forgetting things
  too fast, but more history = more tokens per call.
- The field names in `extractText`/`getContextInfo` assume a fairly standard
  Baileys message shape — double check against whatever version/fork you're
  actually running, since these shift between releases.
- `data/chloeStore.json` is a flat file for simplicity. Fine for a handful of
  chats; swap for SQLite/Postgres if this scales up.
