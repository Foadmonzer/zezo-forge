# ZEZO Forge — Phase 5 performance and launch readiness

**Branch:** `codex/nextjs-migration-20261104`
**Date:** 2026-11-05
**Data used:** isolated local PostgreSQL database with generated test accounts and records only.

## PostgreSQL contention change

`GET /api/public` now reads the public settings, 40 template prices, availability, and inclusions through a narrow PostgreSQL repository query using the shared pool directly. It does not enter the process promise queue or acquire the compatibility store's advisory lock. Before returning, it checks whether a marketer/developer needs a monthly referral-link rollover. If one does, the route deliberately falls back to the old locked path so it does not skip that state change.

`GET /api/track` now queries the single request matching the hashed tracking token and expiry. It returns only the customer-safe status fields and also bypasses the global store load/write transaction. Both routes preserve the staging gate and no-store/security headers. Health checks already bypassed the store.

An additive expression index on the stored tracking-hash field supports that exact lookup as the request table grows; the tracking hash is not exposed in the response.

**The company-wide bottleneck is only partly removed.** All other API requests still load the normalized company store and persist it under the global advisory lock, including authenticated dashboards, conversations, CRM, orders, quotes, referrals, project work, and finance. Financial idempotency tests remain green, so the lock was not removed from these compatibility writes. Further route-by-route repositories and record-scoped transactions are still required before claiming the overall API is no longer serialized.

## Comparable local read benchmark

The benchmark calls `GET /api/public` directly, with a warm-up followed by five waves of 20 concurrent requests (100 samples total), against the same newly migrated, empty synthetic PostgreSQL database. The before run used the branch's pre-change server implementation; the after run used this branch's new direct-read path. It excludes browser/network and public-host latency. All responses were HTTP 200.

| Measurement | Before | After | Change |
|---|---:|---:|---:|
| p50 | 650.2 ms | 13.6 ms | 97.91% lower |
| p95 | 1,223.6 ms | 30.8 ms | 97.48% lower |
| Maximum | 1,417.4 ms | 32.4 ms | 97.71% lower |
| 100-request elapsed time | 6,260.6 ms | 116 ms | 54.0× less elapsed time |
| Errors | 0 | 0 | — |

The post-change handler completed while another connection held the legacy advisory lock. The PostgreSQL API suite also confirms that the public tracking endpoint completes under the same held lock. The benchmark is evidence for these two read paths only; it is not a load result for authenticated or financial routes.

## Outbox worker

- PostgreSQL message claims are atomic and lease-based, use `FOR UPDATE SKIP LOCKED`, and have a lease token so an expired worker cannot mark another worker's message sent.
- Retries reuse the outbox row ID as the Resend idempotency key. Resend documents a 24-hour key retention window, so a message stuck in `sending` beyond that window is moved to `uncertain` and requires review instead of being automatically sent again. This avoids an automatic duplicate at the cost of manual review in an ambiguous delivery case. [Resend idempotency keys](https://resend.com/changelog/idempotency-keys)
- Delivery is disabled by default and also disabled in Staging. Explicitly setting `ZEZO_ENABLE_EMAIL_DELIVERY=true`, plus valid provider configuration, is required before the worker sends anything.
- PostgreSQL API requests now only persist messages; they do not send from a request transaction. Run `node outbox-worker.js` as a separately supervised process on a long-running host. A Next.js serverless deployment does not start this process automatically. No real email or provider request was sent in these tests.
- Retries are deduplicated per outbox item. Duplicate business events could still create separate outbox rows; current API request idempotency and future event-level keys must continue to be reviewed as remaining systems migrate.

## Regression checks executed

The final local checks passed:

- Role and permission smoke test, CRM privacy, referral retention/ranks, wallets/withdrawals, 25% developer commission, project stages, and demo render states.
- Staging gate, noindex/robots, disabled external integrations, first Owner setup lock, and signed session expiry.
- PostgreSQL schema, foreign keys, payment idempotency, commission uniqueness, and conversation relations.
- Synthetic Owner, client, order manager, HR manager, marketer, and developer journey; login/session persistence; conversation access; quote and acceptance; official order/CRM; project assignment/review; verified payment; 15% marketer and 25% developer commission.
- Eight concurrent duplicate payment submissions produced exactly one payment row.
- 40 public templates retained their 200 ILS default starting prices and availability flags.
- Public settings and tracking reads finished while the old advisory lock was held.
- Outbox lease/restart recovery, stale-token rejection, stable idempotency key, and uncertain delivery after the provider window; no email provider was called.
- TypeScript check, Prisma schema validation, and optimized Next.js production build.

The benchmark did not run as HTTP traffic through a browser or hosted proxy. A local preview process started, but this Work browser/network sandbox could not reach its localhost port. Therefore I did **not** complete the requested visual browser matrix at 375, 390, 768, 1366, and 1440 px, nor claim physical-device testing. Use a reachable browser preview to complete that part before public Staging.

## Monitoring, backup, restore, and production connection plan

1. Use a separately provisioned production PostgreSQL database with TLS and a provider-issued pooled connection URL. Keep credentials only in the hosting environment; size each app pool against the database connection cap and expected instance count. Vercel's current database guidance recommends connection pooling for function workloads. [Vercel connection pooling guidance](https://vercel.com/kb/guide/connection-pooling-with-functions)
2. Monitor request p50/p95/error rate, PostgreSQL active/idle/waiting connections, long transactions, lock waits, query duration, pool acquisition timeouts, attachment size/storage, and Outbox counts by `pending`, `retry`, `sending`, `failed`, and `uncertain`. Alert on growing oldest-pending age, repeated transaction retries, or a rising lock wait trend. Avoid logging passwords, tokens, message bodies, or customer contact details.
3. Before production traffic, define an owner-approved backup RPO/RTO and retention policy. Take encrypted PostgreSQL custom-format backups to storage separate from the app host, restrict backup access, and verify checksums. Restore into a separate database on a regular schedule; run migrations and PostgreSQL smoke tests against the restored copy. Never test restore with production overwrite commands.
4. Keep a tested deployment rollback target and database-compatible migration plan. Prefer additive schema changes, verify backups before migrations, and document forward repair for migrations that cannot safely roll back.
5. The prior Phase 4 synthetic database backup/restore exercise is documented separately; no production database, paid monitor, hosted backup, or external worker service was configured here.

For hosting decisions, Vercel's current documentation restricts Hobby to personal, non-commercial use and limits Hobby Cron to once daily with up to 59 minutes of timing variance. That plan/schedule is not appropriate for ZEZO's commercial use or prompt transactional email processing. No hosting plan was selected or purchased. [Vercel Hobby plan](https://vercel.com/docs/plans/hobby), [Cron usage limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)

## Historical administrator records in public Git history

The existing Phase 4 review found a historical `data/zezo-data.json` blob (7,174 bytes) on public `origin/main`, containing seven administrator/owner records with `passwordHash` and `salt` fields but no plaintext password value in that file. Treat the represented credentials as exposed. The safe order remains: owner-controlled identification of active affected accounts; password/MFA rotation and session revocation; coordinated repository-wide history cleanup; inspect every branch/tag/fork and cached copy. This phase did not rotate accounts, rewrite Git history, or force-push any ref.

## Readiness decision

- **Local code/build readiness:** passed for the tested paths.
- **Public protected Staging:** **not ready yet**. The global lock still covers most authenticated API reads and writes, responsive visual/device checks could not be completed, and no external HTTPS Staging environment was configured.
- **Production:** **not ready**. In addition to the above, a production connection pool, backup objectives, monitoring, real provider setup/testing, owner-approved credential rotation and history cleanup, and a full route-by-route migration away from full-store rewrites remain outstanding.
- No deployment, PR merge, paid service, or real email delivery was performed.
