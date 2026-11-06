# ZEZO Forge — Phase 4 release-readiness audit

Audit date: 2026-11-05
Branch: `codex/nextjs-migration-20261104`
Scope: isolated synthetic data only. No deployment, merge, real-data import, pricing change, commission change, email, WhatsApp message, payment, or transfer was performed.

## Verification results

| Area | Result | Evidence and limit |
|---|---|---|
| Existing behavior / permissions | PASS | `node smoke-test.js`; includes CRM privacy, assignments, withdrawals, project stages, delivery review, demo states, and 25% developer commission. |
| Staging gate | PASS | `node staging-smoke-test.js` and `node staging-auth-smoke-test.js`; incorrect password, signed/tampered/expired cookies, noindex, first Owner lock, and disabled outbound integrations. |
| TypeScript / Prisma | PASS | `tsc --noEmit` and `prisma validate`. |
| Production build | PASS | Next.js 16.4.4 webpack build completed, including static route generation. The normal sandbox blocked generated-directory writes; the identical build was rerun successfully with approved workspace write access. |
| PostgreSQL relationships | PASS | Isolated database; SQL smoke suite verified foreign keys, quote/message relations, duplicate payment/commission rejection, rollback, and cascades. |
| PostgreSQL API journey | PASS | Synthetic Owner, customer, Order Manager, HR Manager, marketer, and developer. Registration, persistent login/logout, invitation/activation, assigned conversations and access denial, quote/acceptance, CRM request, developer assignment/review/completion, and cleanup. |
| Payments and commissions | PASS | Eight concurrent requests with the same payment idempotency key left one payment row. A verified 200 ILS collection produced 50 ILS developer execution commission (25%) and 30 ILS marketer referral commission (15%), separately. |
| Attachments | PASS with limit | Authorized `BYTEA` upload/download verified; unrelated employee denied. Exactly 4 MiB accepted; 4 MiB + 1 byte rejected. No sustained throughput or database-bloat load test was run. |
| `NOT VALID` constraints | PASS on test DB only | After API fixtures were cleaned, all 25 unvalidated foreign keys were validated; remaining unvalidated = 0 and total validated foreign keys = 34. No production database was inspected or changed. |
| Backup and restore | PASS on synthetic DB | Custom-format PostgreSQL dump restored to a separate empty review database; table and migration counts matched. The backup/restore procedure was not run against live ZEZO data. |
| 40 template previews | PASS as route/catalog smoke | Opened all 40 preview routes in the browser; each rendered with its template request/customization path. Four demo experiences received interaction checks. This is not a full interaction regression of every control in every template. |
| Demo interactions | PASS, local-only | Daygrid task add/reset; Thread Studio add-to-bag and demo checkout; Luma Clinic appointment booking; Helio Desk canned-response conversation/reset. Their UI explicitly identifies local demo behavior; no real order, booking, AI request, or payment occurred. |
| Responsive / browser matrix | PARTIAL | Desktop browser was reviewed. The available browser session did not provide exact 375/390/768/1366/1440 viewport controls; no physical Android/iPhone or Safari run was available. Responsive CSS was not certified at those exact dimensions. |
| External email / WhatsApp / payment | NOT LIVE | No provider credentials or real transmission were used. WhatsApp remains a user-initiated link; email and payment delivery were not tested. |

## Proven transaction bottleneck

PostgreSQL API requests still load and rewrite the compatibility-shaped store while holding one process queue and one global PostgreSQL advisory transaction lock. A synthetic 20-request probe measured approximately 1.78 seconds total for `/api/public` (p95 about 1.70 seconds). The health endpoint was moved outside that transaction because it reads no mutable store data; a prior 20-request health probe took about 3.5 seconds. The change removes needless health-check contention, but does not solve the global lock for business reads/writes. Do not expose this design to production traffic until domain-scoped repositories/transactions replace full-store hydration and persistence and a representative load test passes.

## Durable data and attachment findings

- The migration uses typed PostgreSQL columns and constraints for identity, ownership, status, amount, and idempotency, but some business detail remains in per-entity JSONB `data` columns. It is not a fully relational redesign.
- No JSON runtime data was imported or removed.
- Attachments remain in PostgreSQL `BYTEA`, with the existing 4 MiB file cap and authorization checks. Boundary and access tests passed. Production suitability depends on actual file volume, backup growth, restore time, and database storage limits; those were not load-tested. Retain `BYTEA` for the current review build and measure before choosing object storage.
- PostgreSQL dump/restore is demonstrated only for the isolated synthetic database. Production backup cadence, retention, encryption, off-site copies, and restore objectives still need configuration and an owner-approved runbook.

## Staging security changes

- Staging access uses a signed 12-hour HttpOnly/SameSite cookie and constant-time password comparison. Login attempts use the shared PostgreSQL rate-limit bucket when PostgreSQL is configured.
- The Next.js proxy now gates compiled assets as well as pages and APIs. A hosted Vercel staging instance fails closed when `DATABASE_URL` is absent, rather than falling back to per-instance in-memory rate limits.
- A locally protected preview is not equivalent to a public HTTPS Staging deployment. Before a public Staging run, configure a separate database, a strong private staging password, HTTPS, noindex, a private deployment URL, independent synthetic credentials/data, and verify the gate through the deployed endpoint.

## Background email and hosting readiness

The database has an `outbox_messages` table, but the current sender is an in-process worker/polling path and is not a durable serverless worker. Before hosting, use an idempotent database lease/claim (`FOR UPDATE SKIP LOCKED` or equivalent), bounded retries, dead-letter state, and an independently invoked worker/scheduled route; keep email disabled until a provider is explicitly configured and tested. A schedule must not be treated as exactly-once: worker operations need idempotency and overlap protection.

Vercel's [Hobby plan](https://vercel.com/docs/plans/hobby) is for personal/non-commercial use, so it is not an appropriate ZEZO business deployment tier. Vercel documents [Hobby Cron](https://vercel.com/docs/cron-jobs/usage-and-pricing) as at most once daily with hourly timing precision; Pro supports per-minute schedules. Its [database connection guidance](https://vercel.com/kb/guide/connection-pooling-with-functions) also calls out pooling and serverless connection pressure. Choose either a commercial plan or a different host that permits commercial use after reviewing its database, runtime, region, storage, and backup terms. No paid service was selected or purchased.

## Historical administrator data in Git

The public repository's `origin/main` commit `346fb9573e10b87aefba8b33e6aa2dea6687ce30` contains historical `data/zezo-data.json` (7,174 bytes). A value-free scan found seven records marked as administrator/owner and fields named `passwordHash` and `salt`; it found no non-empty plaintext password field in that JSON. The removal described by PR #1 affects the proposed branch tip but does not erase this blob from reachable Git history. Treat every credential represented by that historical file as exposed and potentially crackable.

Safe remediation order:

1. Identify any still-active accounts represented by the old data through an owner-controlled private audit; disable them or rotate their passwords/MFA and revoke their sessions before any history rewrite.
2. Prepare a coordinated history rewrite that removes the data blob from all affected branches and tags; inspect every rewritten ref and repository copy before force-updating. Do not rewrite shared history from this review task.
3. Coordinate the rewrite with GitHub and collaborators, then check forks, cached raw URLs, archives, Actions artifacts, and local clones. A history rewrite cannot recall copies already downloaded.
4. Keep runtime data ignored and use synthetic fixtures only. PR #1 and PR #2 remain drafts and unmerged.

## Release decision

| Target | Ready? | Blocking work |
|---|---|---|
| Local review | Yes, with demo limits | Use the local preview and isolated test database. Owner browser test account was synthetic and is left at its forced password-change screen. |
| Public protected Staging | No | No HTTPS host/deployment exists; provision isolated hosted PostgreSQL and secrets, deploy privately, and verify the proxy, static asset gate, role journeys, and noindex on that deployment. |
| Production | No | Global request lock/full-store rewrites, outbox worker, real backup/restore objectives, monitoring/connection pooling, production schema/data audit and constraints, history credential remediation, exact responsive browser matrix, and external integration sign-off remain. |

No item in this audit authorizes a merge or production release.
