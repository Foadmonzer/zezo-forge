# ZEZO Forge

ZEZO Forge is ZEZO's bilingual Arabic/English website and team workspace. This branch contains the Next.js App Router shell, the existing ZEZO domain behavior, and a PostgreSQL-backed runtime for local review.

## Current migration status

- The website shell preserves the 40 interactive template demos, Arabic/English interface, existing CSS, imagery, customer flows, and team workspace.
- Next.js API routes adapt requests to the existing Node domain handler. The handler uses PostgreSQL tables whenever `DATABASE_URL` is set; it does not read or write `application_state_compat` and does not load local JSON data in that mode.
- PostgreSQL-backed runtime tables cover accounts and hashed sessions, project requests/projects/assignments, conversations/messages/quotes, CRM records, payments, commissions, withdrawals, finance entries, expenses, referral links/events/attributions, rank requests, campaigns and mail outbox, notifications, audit entries, template prices, app settings, employee invitations, shared rate limits, and attachments.
- Ownership, workflow, amounts, and idempotency fields use typed columns and constraints. Some less frequently queried domain fields remain in JSONB `data` columns on each entity row. The legacy single JSONB application snapshot is no longer the runtime source of truth.
- Payments have unique idempotency keys; commissions are unique per user/request/kind; referral events use unique idempotency keys; referral visitor hashes are unique. API mutations and reads load and persist state under PostgreSQL transactions and an advisory lock. This global lock prioritizes consistency over throughput and still needs load testing and finer-grained transactions before production scale.
- PostgreSQL-backed attachments are stored as `BYTEA` and served only through the existing authorization checks. This is suitable for local review and modest files, but an external object-storage adapter is recommended before production volume grows.
- Shared rate-limit counters and monthly referral-link creation use PostgreSQL. Vercel's `x-vercel-forwarded-for` is used for the request IP; other reverse proxies should set `ZEZO_TRUST_PROXY=1` only when they overwrite the forwarded header.
- Without `DATABASE_URL`, local preview keeps the existing JSON storage behavior. Existing JSON data is never copied, imported, or deleted by these changes.
- The Next.js adapter fails closed with `503` on Vercel if `DATABASE_URL` is absent. The branch has not been deployed or validated on Vercel, and is not declared production-ready.

## Requirements

- Node.js 20.19+, 22.12+, or 24+
- pnpm 11
- PostgreSQL for the PostgreSQL-backed runtime and its integration tests

## Run the Next.js preview

```powershell
pnpm install --frozen-lockfile
pnpm dev --port 4187
```

Open `http://127.0.0.1:4187`. Without `DATABASE_URL`, local JSON state is created under `data/` unless `ZEZO_DATA_DIR` is set. With `DATABASE_URL`, use an isolated review database and synthetic records; production or customer data is not needed.

## Database setup

Copy `.env.example` to `.env` and set `DATABASE_URL` only for a private, isolated PostgreSQL database. Never commit `.env` or use production credentials for tests.

```powershell
pnpm db:generate
pnpm db:migrate:deploy
```

Existing JSON files are not imported automatically. Keep them as a separate backup; migration and data-import scripts are intentionally separate work.

## Checks

```powershell
pnpm typecheck
pnpm build
pnpm test
pnpm test:postgres
```

The regular smoke suites use isolated synthetic stores. The PostgreSQL suite verifies schema relations and uniqueness, then exercises first-Owner setup and setup lock, password change/MFA/login/logout, client registration, employee invitations and role dashboards, conversation assignment and access denial, messages and quote acceptance, official order/CRM linkage, developer assignment at 25%, marketer commission at 15%, payment idempotency, normalized-row persistence, and cleanup. It requires a disposable PostgreSQL database.

## PostgreSQL-backed local preview

Start a local test database and apply migrations, then set `DATABASE_URL` in the shell before `pnpm dev --port 4187`. `/api/health` reports `storage: postgresql`. All synthetic records are deleted by the API smoke test; app settings may remain because they contain default runtime configuration, not personal data.

## Known production work

- A production PostgreSQL service, restricted credentials, connection-pool sizing, backup/restore rehearsal, monitoring, and disaster recovery have not been configured or tested.
- The request handler still materializes domain rows into the current ZEZO store shape per request and serializes access with one database-wide advisory lock. It is durable and shared across processes, but throughput and large-dataset behavior need redesign and load testing.
- PostgreSQL `BYTEA` attachment storage is persistent but not a substitute for object storage at scale. No object-storage service has been purchased or configured.
- The standalone server runs the mail-outbox retry timer. Next.js/serverless requests persist the outbox but do not start a worker or scheduled job. Email delivery therefore remains disabled/unverified until a worker and provider are configured.
- WhatsApp is a user-initiated external handoff; no official WhatsApp API integration or delivery confirmation is enabled. Payment collection and staff transfers remain manual/simulated.
- Browser coverage and supported desktop/mobile browser/device coverage must be reported from the actual test run. No deployment or production readiness is implied by a successful local build.

## External service status

No production database, object storage, mail provider, payment gateway, or hosting credentials are included. Do not deploy this branch or connect production data until the remaining operational work and the commercial hosting plan are reviewed.
