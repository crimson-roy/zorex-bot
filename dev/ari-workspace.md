# Ari workspace foundation

This branch adds the first redesigned Ari workspace shell and account-scoped conversation persistence.

## Interface

The current page uses a dark charcoal and muted seafoam palette, Newsreader for assistant responses, a 268px desktop navigation rail, a responsive mobile sidebar, a wider conversation stage, a rounded composer and an attachment tray. It includes navigation surfaces for Library and Projects plus account pages for Profile, Memory, Settings and account deletion.

The Library, Projects, Memory, Settings and Delete Account pages are presently honest setup states. They do not claim that their backing services exist. Audio and document files can be previewed in the composer, but only image input is accepted by the current chat endpoint. Large pasted text is visually marked in the composer; the existing 2,000-character message limit remains in force.

## Conversation persistence

dev/ariWorkspaceStore.js stores per-account conversation lists in ariWorkspace.json under ARI_DATA_DIR, DATA_DIR, or the project data/ directory. Account subjects are hashed before they are used as object keys. The file is written atomically with restrictive POSIX permissions where supported.

The authenticated endpoints are:

- GET /api/workspace/chats: returns conversations for the active signed-in account.
- PUT /api/workspace/chats: validates and replaces that account's conversation list. The route requires a session and the existing same-origin/CSRF guard.

The browser continues to keep a localStorage copy as a fallback. On sign-in, Ari merges the browser and server copies by conversation ID and updatedAt, then syncs the merged list. The browser is not allowed to overwrite the server copy until the initial read succeeds. If the endpoint is temporarily unavailable, the browser copy remains usable.

The data file is ignored by Git. Configure ARI_DATA_DIR to a persistent, private writable directory in production. Backups are not yet automated.

## Current limits and follow-on work

This is not yet a full account database. Google sign-in remains the only configured login method, and sessions are still held in memory by the existing auth module. Email OTP, persistent sessions, user profile edits, project CRUD, memory review, actual Library uploads/object storage, quotas, data export and verified account deletion are not implemented here.

The web search router is included separately in the PR. It remains disabled by default, has no credentials committed, and is not yet connected to the GPU model's tool-execution loop. SearXNG is not deployed. No production deployment is performed by this branch.

## Tests

The workspace store has isolated tests for persistence across store recreation, account separation, deletion sync and input validation. Ari's HTTP test covers the authenticated workspace GET/PUT endpoints and validates the page's inline script and element IDs.

Run npm ci followed by npm test from a clean Node 20 checkout.
