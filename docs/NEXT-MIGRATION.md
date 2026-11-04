# Next.js migration checkpoint

## Phase 1 implemented in this branch

- A Next.js 16 App Router shell serves the existing public ZEZO page without creating a second visual product.
- The current HTML body and all public asset paths remain in `public/`; the existing browser app is loaded after the App Router mounts.
- `/api/*` routes adapt Next.js Node runtime requests to the existing backend handler for local review.
- Prisma 7 schema covers accounts, customer requests/projects, conversations/messages/quotes, payments, commissions, wallets, withdrawals, referrals, CRM, notifications, audit, pricing, settings, sessions, attachments, mail outbox and campaigns.
- Legacy JSON imports are not automatic. `.env.example` contains placeholders only.
- Vercel API calls return `503` while the handler still uses local JSON and filesystem uploads.

## Remaining migration gates

1. Replace the compatibility store with transaction-safe Prisma repositories and persist sessions in PostgreSQL.
2. Split `server.js` into domain services and typed route handlers; remove the global in-memory store and rate-limit maps.
3. Route attachments to durable object storage (or a database-backed blob service) and migrate download authorization.
4. Generate and review SQL migrations, then test against a disposable PostgreSQL instance.
5. Add import tooling that reads a user-selected backup only, validates counts and references, and requires an explicit confirmation; never read production `.env`, uploads, or databases automatically.
6. Add multi-instance concurrency, role-authorization, file-upload, and browser tests against the Next.js route adapter and the PostgreSQL implementation.
7. Choose a commercial-compatible host and configure secrets outside this source repository. No deployment is performed here.

## Why the temporary compatibility schema is not production persistence

The existing business logic mutates a single process-local object and calls a JSON file writer. The Next.js route adapter preserves local behavior while exposing clear deployment boundaries, but it does not yet use the relational models. The Vercel guard is intentional until requests, sessions and uploads all use durable services.
