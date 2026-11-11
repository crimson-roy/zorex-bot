# Ari Developer Reference — Internal

This document contains operational details for developers. Do not copy this section into user-facing self-knowledge or tell users its exact values. The model policy directs Ari to refer account-specific usage questions to the administrator without disclosing numeric limits.

## Default test limits

- `ARI_DAILY_MESSAGE_LIMIT=100` accepted chat requests per Google account per UTC day.
- `ARI_MESSAGES_PER_MINUTE=10` accepted chat requests per Google account in a rolling 60-second window.
- These are configurable defaults. Confirm the live service configuration before describing a user's actual limit.
- Browser-generated chat-title requests also call `/api/chat` and currently consume the same quota.

## Access configuration

- `GOOGLE_CLIENT_ID`: public Google Identity Services client ID.
- `ARI_REGISTRATION_MODE`: `open` by default; any Google account with a verified identity token can register and sign in. Set to `restricted` only for a private allowlisted deployment.
- `ARI_ALLOWED_EMAILS`: comma-separated approved addresses, required only in restricted mode.
- To make a deployment public, set `ARI_REGISTRATION_MODE=open` in its runtime environment and restart the Ari service. To keep a deployment private, set `ARI_REGISTRATION_MODE=restricted` and list the exact authorized Google emails in `ARI_ALLOWED_EMAILS`.
- `ARI_SESSION_TTL_SECONDS`: absolute session lifetime; default 28,800 seconds.
- `ARI_PUBLIC_ORIGIN`: exact public HTTPS origin in production.
- `ARI_TEXT_FALLBACK_ENABLED`: defaults to `true`; uses the shared Zorex text API only when an Ari text model is unavailable. It never receives image/media payloads. Set to `false` to disable the backup.
- `NODE_ENV=production`: required for Secure production cookies and production-origin validation.
- `ARI_DATA_DIR`: private writable directory for persisted quota records.

Google ID tokens and server session IDs are not written to the usage store. Session records currently live in the Node process; a process restart requires users to sign in again. The JSON usage store is serialized within one Node process and is not a multi-instance quota database.
