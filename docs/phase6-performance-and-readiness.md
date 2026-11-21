# ZEZO Forge Phase 6: performance and release readiness

## Change summary

The compatibility handler previously serialized most authenticated API requests behind one process queue and PostgreSQL advisory transaction lock, then loaded and rewrote the full company store. This phase routes these reads through narrowly scoped PostgreSQL queries:

- `POST /api/auth/login`: one active account lookup, a shared PostgreSQL rate-limit bucket, then a short transaction for the hashed session and audit row.
- `GET /api/conversations` and `GET /api/conversations/:id`: role-scoped conversation/message/quote queries.
- `GET /api/crm`: role-scoped CRM/referral queries, returning aggregate-only data for HR, marketer, and developer views.
- `GET /api/dashboard` for clients: the customer's own requests, payments, and conversations.
- `GET /api/dashboard` for marketers and developers: only their own referral/project, CRM summary, commission, wallet, and related rows.

The login and read paths do not acquire the global company-state lock. Scoped account reads retain session validation and permission checks. Finance writes, duplicate-payment protection, commissions, quote/order writes, and state-changing project operations remain on the existing serialized compatibility transaction. Owner, HR, marketing-manager, and order-manager dashboards still use that compatibility path because they include broad views and/or reconciliation side effects. This change does not claim complete removal of the global lock.

## Synthetic PostgreSQL comparison

Measured against the isolated `zezo_phase6_20261105` PostgreSQL database using 12 synthetic requests per route and concurrency 6. The benchmark calls the same in-process API handler and database repositories; it does not include a reverse proxy, internet latency, or production-sized data.

| Route | Before p50 / p95 | After p50 / p95 | Errors before / after |
|---|---:|---:|---:|
| `POST /api/auth/login` | 1139.2 / 2287.8 ms | 471.4 / 491.2 ms | 0 / 0 |
| `GET /api/conversations` | 552.0 / 1116.6 ms | 11.9 / 17.7 ms | 0 / 0 |
| `GET /api/dashboard` client | 542.5 / 1068.5 ms | 11.3 / 26.3 ms | 0 / 0 |
| `GET /api/dashboard` marketer | 550.1 / 1097.7 ms | 15.0 / 21.8 ms | 0 / 0 |
| `GET /api/crm` | 515.5 / 1034.8 ms | 8.5 / 11.2 ms | 0 / 0 |

`postgres-core-read-benchmark.js` recreates this test with synthetic users, conversations, and CRM records, then removes its fixtures. CI runs the same benchmark with a smaller fixed sample on its disposable PostgreSQL service. These local measurements demonstrate that the selected reads no longer queue on the advisory lock; they do not predict production latency or load capacity.

## Regression checks run

- TypeScript: `tsc --noEmit` passed.
- PostgreSQL API journey: passed customer registration/login/logout, employee invitations and role dashboards, conversation access boundaries, file upload/download limits, quote acceptance, order creation, CRM visibility, developer delivery, and wallet/commission checks.
- A PostgreSQL session holding the legacy advisory lock did not block conversation reads, CRM/client dashboard reads, or a developer dashboard read.
- Duplicate payment idempotency passed under concurrent requests. The verified synthetic project retained 25% developer execution commission and 15% Rookie marketing commission.
- Prisma schema validation and relational/FK/idempotency smoke tests passed.
- Staging isolation/auth checks passed. Outbox lease recovery and duplicate-send protections passed without calling an email provider.
- Forty-template catalog metadata and pricing checks passed; the catalog remains split into ten templates per service. Existing smoke checks exercise the four interactive demo families, not a manual visual review of every template.
- Production build passed with `next build --webpack` and `ZEZO_NEXT_BUILD_DIR=.next-phase6-build`.

## Browser QA limitation

The protected preview answered HTTP 200 on the host at `http://127.0.0.1:4187/`. The Work in-app browser returned `ERR_CONNECTION_REFUSED` for both `127.0.0.1` and `localhost`. Native Edge was started, but computer-use could not safely determine the current Windows browser URL, so viewport screenshots and visual interaction checks were stopped. No physical phone was tested. Do not treat responsive visual QA at 375, 390, 768, 1366, or 1440 px as completed. The local preview uses only the disposable synthetic database and is not a public staging URL.

## Staging plan (not deployed)

1. Provision a dedicated PostgreSQL database with a separate role, no production records, and migrations applied from this branch.
2. Create a protected HTTPS preview on an approved host using organization access control or equivalent edge authentication, plus the application staging gate and `noindex` headers.
3. Set staging-only session/signing secrets in the host secret manager; leave real email, WhatsApp sending, and payment providers disabled.
4. Load synthetic owner/customer/order-manager/HR/marketer/developer data, test login and permission boundaries from desktop and actual mobile devices, and verify backups/restores before sharing the URL.
5. Keep staging isolated from production databases, object storage, mail, analytics, and payment credentials. No host, account, subscription, or deployment was created in this phase.

## Remaining release blockers

- Remove the compatibility-store loader/rewriter and global advisory lock from the remaining dashboards and all authorized write flows by migrating them incrementally to row-scoped repositories and transactions.
- Complete visual QA at all requested viewport widths using a browser session that can reach the local preview, then repeat on a real phone when available.
- Run GitHub Actions after the branch push; local checks cannot attest that remote CI has passed.
- Review broad owner/manager data reads, shared rate-limit behavior behind the production proxy, and staging access/secret rotation with the chosen host before creating public staging.
- Production readiness is not established. There was no deployment, external email, WhatsApp, or payment-provider test.
