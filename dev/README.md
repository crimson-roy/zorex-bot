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

The server binds to `127.0.0.1`, so it is intended for use in a browser on the same computer. It uses Node's built-in HTTP server and adds no dependencies.

## Chat history

- Previous conversations are saved in this browser's `localStorage` on this computer.
- The latest conversation is reopened when the page loads again.
- **New chat** starts a separate conversation; it does not delete older chats.
- Select a conversation in the history panel to revisit it.
- Use the × beside a conversation to delete it from this browser.
- Clearing browser site data or using a different browser profile removes or hides this local history.
- Conversations are not uploaded to the VPS or an AI provider by the playground's history feature.

## Check the WordNet installation

Run this from the repository root:

```bash
npm run ari:check-wordnet
```

The diagnostic reports whether the WordNet 2.1 dictionary files were found and tests the terms `persistence` and `persistenca`. It runs entirely locally.

If automatic Windows path detection fails, PowerShell can set the path before starting the playground:

```powershell
$env:WORDNET_DICT_DIR = "C:\\Program Files (x86)\\WordNet\\2.1\\dict"
npm run ari:dev
```

## Local language capabilities

The playground now has a rule-based local language layer; it does not call an AI API.

- Greetings such as `Hi Ari` receive a local response.
- Definition requests such as `define persistence`, `what is persistence`, and `what does persistence mean` are recognised.
- The WordNet reader loads the ASCII dictionary files directly from the installed `dict` folder.
- On Windows it checks the WordNet 2.1 locations under Program Files, including `C:\\Program Files (x86)\\WordNet\\2.1\\dict`.
- To use a different location, set `WORDNET_DICT_DIR` to the full dictionary folder before starting the server.
- It reads WordNet senses, glosses, synonyms, common inflections and cautious one-character spelling suggestions.

For a local WordNet check, start the playground and open `http://127.0.0.1:4173/api/health`. The `wordNetAvailable` field reports whether the dictionary files were found.

## Preparing OASST1 examples

Place the ready conversation-tree archive here:

```text
data/datasets/oasst1/2023-04-12_oasst_ready.trees.jsonl.gz
```

Then run:

```bash
npm run ari:prepare-oasst
```

This uses Node's built-in gzip and JSONL streaming; no extra package is needed. It writes English conversation paths to `data/processed/oasst1-en/train.jsonl` and `validation.jsonl`.

The preparation step filters deleted/rejected messages, non-English messages and messages with positive flagged-content labels. It is only a candidate-data preparation step. Inspect and review the exported examples before using them for fine-tuning; it does not train a model.

## Current limitations

- WordNet is a lexical database, not a conversational model. It provides dictionary definitions and word relationships, not general explanations or open-ended conversation.
- OASST1 is a collection of example conversations, not a ready-to-run language model.
- Ari does not yet have a connected local language model.
- The playground does not call Azure, WhatsApp, or another AI API.
- No image/document upload or user authentication is included.
