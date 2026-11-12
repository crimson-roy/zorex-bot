# Ari Authentication

Ari currently uses Google Identity Services for both account creation and sign-in. The browser receives a Google credential, and the Ari Node backend verifies the ID token before creating an Ari session.

## Configuration

- `GOOGLE_CLIENT_ID`: the Google OAuth client ID used by the browser and backend.
- `ARI_REGISTRATION_MODE=open`: allows any Google account with a verified email identity to create an Ari account and sign in.
- `ARI_REGISTRATION_MODE=restricted`: limits access to the Google accounts listed in `ARI_ALLOWED_EMAILS`.
- `ARI_ALLOWED_EMAILS`: comma-separated Google email addresses; used only in restricted mode.
- `ARI_PUBLIC_ORIGIN`: the exact HTTPS origin of the deployed Ari site.
- `ARI_SESSION_TTL_SECONDS`: absolute session lifetime; defaults to 28,800 seconds.

Email OTP and phone/SMS OTP are currently disabled. The sign-in interface does not expose those methods, and the Ari HTTP server does not offer OTP request or verification endpoints. They can be reintroduced after the email or messaging delivery setup is ready.

## Session safeguards

Ari validates the Google token audience, issuer, expiry and verified-email claim. Session cookies are HTTP-only, same-site and secure in production. Mutating authentication requests use same-origin and CSRF checks.

Google ID tokens and server session IDs are not written to the usage store. Session records currently live in the Node process; a process restart requires users to sign in again.
