# Ari Memory — Review mode v1

Memory entries are stored inside the signed-in account's private record in `ariWorkspace.json`. They are not shared between accounts.

## Current behaviour

- A user can add a memory of up to 500 characters.
- Up to 100 memories are stored per account.
- Saved entries have `active` status; review suggestions use `pending` status.
- Users can edit and delete active entries, approve pending entries, or dismiss them.
- Obvious credential-style strings such as `password: ...`, API-key/token assignments and PEM private-key headers are rejected by server-side validation.
- The browser screen is account-bound and ignores responses that arrive after sign-out or account changes.

**Automatic suggestion boundary:** the current chat/model execution path does not propose memories. The screen supports review of pending records, but Ari does not silently extract and save facts from conversation messages in this version. Automatic proposal generation must be integrated as a separate model step and must create pending suggestions, not active memories.

Do not store passwords, account credentials, access tokens or highly private information in Ari Memory. The credential check is a safety guard for common patterns, not a guarantee that every sensitive fact can be identified.

## API

Every route requires a signed-in session. Create, update and delete operations use Ari's existing same-origin and CSRF checks.

- `GET /api/workspace/memory` — list the current account's memories.
- `POST /api/workspace/memory` — add a user-provided active memory using JSON `text`.
- `PATCH /api/workspace/memory/:id` — edit text or change a pending entry to active.
- `DELETE /api/workspace/memory/:id` — remove a memory.

IDs are generated UUIDs, and the server always scopes lookup and mutation to the current account.
