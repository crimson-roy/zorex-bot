# Ari Email and Phone Verification

Ari keeps authentication separate from the assistant conversation model. The Node authentication backend generates and validates verification codes; the AI model never generates, receives, or checks OTPs.

## Providers

- Email delivery uses the Resend Email API.
- SMS delivery uses the Termii SMS API. Use the account-specific Termii base URL shown in its dashboard.

No provider credentials are included in the repository. Configure them as server-side environment secrets only.

## Required server settings

### Shared OTP settings

- ARI_OTP_SECRET: a unique random secret of at least 32 characters. Generate one with openssl rand -hex 32.
- ARI_OTP_TTL_SECONDS=300: code lifetime; accepted range is 120–900 seconds.
- ARI_OTP_RESEND_SECONDS=60: minimum time between sends to the same destination; accepted range is 30–600 seconds.
- ARI_OTP_MAX_ATTEMPTS=5: wrong-code limit; accepted range is 3–10 attempts.

### Email

- RESEND_API_KEY: API key from the Resend dashboard.
- ARI_EMAIL_FROM: sender address configured and verified in Resend. Resend requires a verified sending domain before sending from that domain.

### SMS

- TERMII_API_KEY: API key from the Termii dashboard.
- TERMII_SENDER_ID: sender ID configured for the Termii account.
- TERMII_BASE_URL: account-specific base URL; defaults to https://api.ng.termii.com.
- TERMII_CHANNEL: defaults to dnd.

### Restricted registration

- ARI_REGISTRATION_MODE=restricted continues to use ARI_ALLOWED_EMAILS for email identities.
- ARI_ALLOWED_PHONE_NUMBERS is a comma-separated list of phone numbers in international format for SMS identities.
- In open mode, the contact method can register after successful verification.

## Flow and safeguards

1. The browser sends the chosen method and destination to /api/auth/otp/request over same-origin HTTPS with the Ari CSRF token.
2. The backend validates the destination, checks provider configuration and registration policy, creates a cryptographically random six-digit code, stores an HMAC digest, and sends the code through the provider.
3. The code expires after five minutes by default. A destination can request another code only after the configured cooldown.
4. The backend checks the submitted code in constant time, permits a limited number of attempts, and creates the usual Ari session after successful verification.
5. OTP values are never returned to the browser, included in logs, or passed to the assistant model.

Ari accepts Nigerian local 11-digit phone numbers beginning with 0 and converts them to +234; international numbers should include their + country code.

## Account identity note

Google, email and phone sign-ins currently create stable identities within their own methods. A Google identity is not automatically linked to an email or phone identity, even when the contact details appear to belong to the same person. Account linking is a separate feature and must require proof of control of both methods.

## Runtime note

OTP challenges and login sessions currently live in the Ari Node process memory. They are removed on restart, and this setup assumes one Ari process. Before adding multiple application instances, move challenges, send throttles and sessions to a shared store with atomic expiry and rate-limit operations.
