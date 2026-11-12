# Ari Playground

Ari Playground is the browser workspace for the Zorex AI assistant. It runs from `dev/ari-chat-server.js` and is separate from the WhatsApp bot process.

## Start it locally

From the repository root:

```bash
npm run ari:dev
```

Open `http://127.0.0.1:4173`. The server binds to loopback by default. Use the deployment's process manager and reverse proxy for a hosted environment; do not expose the loopback service directly to the public internet.

## Accounts and saved work

Google sign-in identifies each account. Ari stores chat history, profile details, privacy settings, memories, projects and Library metadata in the configured private data directory. Account keys are hashed in the data stores. The Library stores file bytes separately from metadata.

The Library computes a SHA-256 digest for each uploaded file and reuses an existing account file when the same bytes are uploaded again. Duplicate uploads do not consume additional Library quota.

## Profile and preferences

The Profile / About You page lets each account edit a preferred nickname, occupation, hobbies, additional context, Ari's personality and emoji preference. The choices are:

- Personality: Overly cheerful, Cheerful, Neutral, Sarcastic or Professional.
- Emoji use: Zero emojis, Balanced or More emojis.

Settings includes independent controls for:
- **Access to previous chats:** Ari may search all saved chats when asked about a past conversation.
- **Access to last chat:** Ari may refer only to the most recently updated conversation.
- **Active Experience Learning:** Mini may use de-identified answer-pattern signals learned from explicitly rated Medium/Max responses.

The sidebar's chat search searches the signed-in user's own saved conversations. This local search works independently of the permission that controls whether Ari itself may retrieve prior chat context.

## Active Experience Learning

Ari does not update Mini's model weights after each response. Instead, it stores only general task categories, response-structure signals and like/dislike outcomes from Medium and Max. It does not copy raw prompts, answer text or personal facts into the experience library. Mini can retrieve the reusable patterns as guidance for similar tasks. Accounts can turn this feature off in Settings.

## Audio and text attachments

The chat composer supports images on supported GPU tiers, readable text attachments and audio attachments on Max/Ultra. Gemma 4 E2B/E4B accepts audio input; the Kaggle API cell converts uploads to mono 16 kHz audio and enforces an 8 MiB file limit and a 30-second clip limit. Max/Ultra availability still depends on the corresponding Gemma model being loaded in the current Kaggle session.

Large text pasted into the composer is detached into a separate text-file attachment, so it no longer remains duplicated in the message field. Text attachments are limited to 16,000 characters on GPU tiers and 1,600 on Mini. PDF and Word document parsing are not enabled by this change; Docling remains a separate integration.

To enable audio on a running Kaggle session, update the existing Ari GPU API cell using `dev/ari-kaggle-api-cell.py` from the same branch, then restart that API cell. This change does not download or replace the loaded model.

## Admin analytics

Set `ARI_ADMIN_EMAILS` to a comma-separated list of administrator Google email addresses in the server environment. This list is separate from `ARI_ALLOWED_EMAILS`, which controls sign-in access. Only administrators see the Admin analytics page.

The dashboard reports unique registered accounts, heartbeat-based activity windows and the percentage of unique rated responses that are likes or dislikes. A response rating can be changed; changing it updates the existing rating rather than adding another vote.

## Tests

Run the full repository test suite from the repository root:

```bash
npm test
```

The Ari-specific test files include `test/ariChatServer.test.js`, `test/ariWorkspaceStore.test.js`, `test/ariLibraryStore.test.js`, `test/ariExperienceStore.test.js` and `test/ariKaggleApi.test.py`.

## Safety and deployment notes

- The feature branch is not deployed automatically by these changes.
- The WhatsApp bot is a separate process and should not be restarted to deploy Ari.
- Never commit Google credentials, GPU API keys, session secrets or provider keys.
- Audio conversion requires `ffmpeg` in the Kaggle runtime and a Transformers version that supports Gemma 4 audio processing.
