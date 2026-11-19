# ZEZO password recovery email

Password recovery uses the chosen email provider synchronously. The API waits for acceptance while it holds the reset token in memory. It records the outcome in the existing Outbox table. The background worker does not send password reset messages.

## Production configuration for Resend

- `ZEZO_PASSWORD_RECOVERY_PROVIDER=resend`
- `ZEZO_ENABLE_PASSWORD_RECOVERY_EMAIL=true`
- `ZEZO_FROM_EMAIL=ZEZO <noreply@notify.zezoforge.com>`
- `RESEND_API_KEY` is a sending key scoped to `notify.zezoforge.com`. Store its value as a secret in the Production Functions environment.
- `ZEZO_PUBLIC_URL=https://zezoforge.com`

Keep click and open tracking disabled for the transactional send domain. Click tracking rewrites the one-time link, which contains a credential in its URL fragment. Check the received link against the official domain during the email delivery test. [Resend transactional email guidance](https://resend.com/guides/email/plan-onboarding-email-program)

For the first Production test, set `ZEZO_EMAIL_TEST_RECIPIENT` to the exact address belonging to the approved test account. Other addresses still receive the normal generic response from the recovery endpoint. The address comparison is case insensitive. For a recovery-only test, `ZEZO_ENABLE_EMAIL_DELIVERY=false` keeps the general queue paused. Remove the test recipient restriction only after confirming receipt and completing the reset test. Netlify Functions need a new deployment to pick up environment changes.

For a separately configured preview, use the exact HTTPS preview origin, an isolated database, a test inbox and test-specific email credentials. Keep recovery disabled in shared previews. The application never falls back to the Production URL when its configured origin is missing or invalid.

The existing Gmail SMTP option remains available when `ZEZO_PASSWORD_RECOVERY_PROVIDER=gmail` or the provider setting is missing. That option still requires the approved Gmail address and its App Password, stored securely. An explicit Resend configuration never switches to Gmail after a failure.

## Request and storage behavior

- A reset link uses the configured origin and carries its token in the URL fragment. PostgreSQL stores the SHA-256 token hash and the one-hour expiry on the account. The Outbox record contains the recipient and minimal attempt metadata, including the Resend acceptance ID if available.
- Resend receives the Outbox ID as the idempotency key. The request has a timeout. On failure the application records a coarse failure category and the worker cannot resend the original one-time link. An acceptance ID confirms only that Resend accepted the request. Verify delivery separately in Resend and the test inbox.
- Known accounts, unknown addresses and provider failures produce the same generic HTTP 202 when the feature is configured. The Resend response has a minimum duration to absorb ordinary provider request timing. Missing global configuration produces HTTP 503 before account lookup.
- The existing IP and address limits, token expiry, one-time consumption and session invalidation still apply. Staff sign back in through the usual MFA flow.

## Checks on isolated PostgreSQL

- `pnpm test:password-recovery-email` uses a loopback HTTP sink that simulates the Resend API. It tests content, the provider acceptance ID, token hashing, successful reset and rejected reuse, session invalidation and provider error redaction.
- Set `ZEZO_TEST_RECOVERY_CANARY=true` for the same regression with an exact recipient restriction. It checks that an active account outside the allowed address cannot obtain a reset link.
- Set `ZEZO_TEST_RECOVERY_TRANSPORT=gmail` to run against the isolated SMTP sink.
