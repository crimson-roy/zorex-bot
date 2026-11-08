# Ari Local Chat Playground

A minimal browser chat interface for testing Ari's local runtime without starting the WhatsApp bot.

## Start it

From the repository root, run:

```bash
npm run ari:dev
```

Then open:

```text
http://127.0.0.1:4173
```

To use another local port:

```bash
ARI_DEV_PORT=4174 npm run ari:dev
```

The server binds to `127.0.0.1` only, so it is intended for use in a browser on the same computer. It uses Node's built-in HTTP server and adds no dependencies.

## Current scope

- The chat is temporary and exists only in the browser tab.
- **New chat** clears the conversation and restores the empty-state message.
- Simple arithmetic is answered by Ari's local parser.
- Other messages receive an honest notice that the local language model is not connected yet.
- The playground does not call Azure, WhatsApp, or another AI API.
- No image/document upload or user authentication is included.

The next step is to connect a local language model to the same `respondToMessage` runtime interface.
