# ZEZO password recovery email

Password recovery uses a separate, synchronous Gmail SMTP transport. It does not
enable the general Resend mail queue or depend on a worker that can stop when a
Netlify Function returns.

## Production configuration

Keep the Gmail values in the Netlify Production environment only:

- `ZEZO_GMAIL_SMTP_USER=zezo.info.2026@gmail.com`
- `ZEZO_GMAIL_SMTP_APP_PASSWORD` = the Gmail App Password, stored as a secret
- `ZEZO_PUBLIC_URL=https://zezoforge.com`

`ZEZO_PUBLIC_URL` is required and must be set to the exact HTTPS origin for each
deploy context. Production uses the production site URL. A Deploy Preview must
use that preview's URL if it is separately configured for testing. If the value
is absent or invalid, recovery stays disabled; it will never silently fall back
to the Production URL. Netlify's `DEPLOY_PRIME_URL` is a build-time value and is
not one of the read-only values exposed to serverless Functions at runtime, so
do not rely on it as a runtime fallback.

When Gmail credentials are present, they enable only password-recovery mail.
Optionally set `ZEZO_ENABLE_PASSWORD_RECOVERY_EMAIL=false` to explicitly turn
this path off; set it to `true` to enable it explicitly. The separate
`ZEZO_ENABLE_EMAIL_DELIVERY` switch still controls the existing Resend mail
flows and is not required for password recovery.

The sender is fixed to the same authenticated Gmail inbox. Set
`ZEZO_ENABLE_PASSWORD_RECOVERY_EMAIL=true` explicitly for Production after
confirming the environment is correct; leave it `false` in isolated previews
unless a separate test database, test inbox, and test-only SMTP configuration
are in place. The site must be redeployed after changing function environment
variables. Never put the App
Password in Git, a local committed file, a log, or a chat message. The account
must have Google's 2-Step Verification enabled before it can issue an App
Password.

## Request and storage behavior

- A reset link is generated from the configured HTTPS site origin, not the
  incoming Host header, and carries its token in the URL fragment.
- PostgreSQL stores only the SHA-256 token hash and the one-hour expiry on the
  account. The outbox record retains the recipient address and minimal delivery
  status metadata; it does not store the token, reset URL, or message body. Treat
  the recipient address as personal data under the database's normal access and
  retention controls.
- The SMTP send is awaited within the API request and has a 12-second upper
  bound. A failure is recorded as `uncertain`, logged only as a coarse error
  category, and is never retried by the background mail worker.
- Known, unknown, and delivery-failure addresses get the same generic 202
  response when sending is configured. If global configuration is absent, the
  route returns a generic 503 without looking up the address. For an unknown
  address, ZEZO performs an SMTP connection check but sends no email, reducing
  timing differences without creating messages to arbitrary addresses.
- Existing rate limits, hashed one-time tokens, expiry checks, session
  revocation, and the normal MFA-aware sign-in flow remain in place.

## Limitations

This is a temporary, low-volume fallback. A personal Gmail inbox is not a
transactional mail service: Google can reject SMTP sign-in from a cloud runtime,
App Passwords are weaker than OAuth and can be revoked, Gmail applies sending
limits, and delivery can be filtered as spam. Netlify's function runtime does
not guarantee that Gmail accepts a connection from every deployment region.
Production delivery must be tested through the deployed function before the
feature is declared active. A verified business domain and transactional email
provider are the safer long-term solution.
