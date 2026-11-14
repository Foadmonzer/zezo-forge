# Phase 7 — Performance and final test readiness

## Implemented on `codex/nextjs-migration-20261104`

- Added a PostgreSQL `REPEATABLE READ READ ONLY` transaction helper. Owner, HR, and Marketing Manager dashboard reads no longer take the company-wide advisory write lock or run the legacy full-store persistence pass.
- Added a role-scoped Order Manager repository query for assigned/department/all order scopes, and kept assigned conversation filtering and contact access in the server path. The dashboard response continues to omit Owner-only team and treasury fields.
- Moved quote creation and quote acceptance onto short PostgreSQL transactions. Both lock the conversation row; quote acceptance also locks the current quote row and commits the accepted state, agreed-price snapshot, message, audit entry, and notification together.
- Restricted quote acceptance to the customer or the matching guest session. Staff with conversation read access cannot accept a quote on a customer's behalf.
- Added idempotent state behavior for repeated quote acceptance: once accepted, later attempts return conflict and do not append another acceptance message.
- Added compatibility-upsert guards so a stale legacy write cannot overwrite a newer conversation snapshot or downgrade an already accepted quote.
- Added indexes for Order Manager scope filters and latest quote lookup.
- Extended the synthetic PostgreSQL API test to hold the legacy advisory lock while exercising Owner/manager dashboards and quote create/accept, and to verify repeated acceptance does not duplicate messages.
- Extended the PostgreSQL benchmark with synthetic Owner, Order Manager, assigned orders, and conversations so p50/p95 are reported for those dashboards before and after the scoped-read path.

## Deliberate limits

- Owner, HR, and Marketing Manager dashboard responses still use `loadNormalizedStore` for a consistent read-only snapshot before their existing role serializer. They no longer block behind or rewrite through the global transaction, but they still read a broad set of normalized tables. Replacing that final broad read with per-panel repositories remains a performance task and should be driven by the CI benchmark measurements.
- Official project request writes, payments, commissions, wallet, and withdrawal mutations still use the compatibility transaction. Their global serialization/idempotency protections were not weakened in this phase. Further write-path migration needs separate row-level repositories and concurrency tests.
- Local PostgreSQL was unavailable: Docker CLI was present but there was no reachable Docker Engine, and no local PostgreSQL service was installed/listening. PostgreSQL integration and benchmark tests ran successfully in the isolated PR CI PostgreSQL 16 service instead.
- A local production build was attempted three ways but did not finish in this OneDrive workspace: the default `.next` cleanup hit `EPERM`; a separate Turbopack output directory could not create its dependency junction without permission; Webpack hit `EBUSY` reading a pnpm-cached Next.js file. The clean GitHub Actions build is the authoritative build check for this branch.
- Visual browser QA and the requested 375/390/768/1366/1440 viewport sweep were not completed. A local Next dev server announced readiness on port 4188 but exited with an `EPERM` while cleaning `.next/dev/node_modules`; the Edge automation surface rejected browser visibility. No real phone was tested.
- The public 40-template catalog is covered by existing smoke checks for all 40 identifiers, their JPEG assets, service counts, and default 200 ILS prices. That is not equivalent to manually opening and interacting with all 40 templates in a browser.
- No public HTTPS Staging or Production environment was created. No real email or payment integration was enabled.

## Verification on PR CI

- GitHub Actions run **42063923761** passed on `a7c1483a00d69fdd28bc084a190015a85559f8c2`. It applied all five migrations, passed schema/API/Outbox tests, ran the benchmark, and completed the Next.js production build.
- PostgreSQL API coverage included Owner setup/MFA/session, customer registration/login/logout, role invitations/dashboards, permission denials, referral consent deletion, assigned conversations and manager scopes, read paths while the global lock was held, protected BYTEA upload/download limits, quote creation and acceptance (including rejection of staff acceptance and duplicate customer acceptance), order/CRM linkage, idempotent payments, project completion, and separate 25% developer and 15% marketer commissions. Email was not sent; synthetic data only.
- Benchmark used an isolated PostgreSQL 16 database, 12 synthetic customer users plus Owner/Order Manager/Marketer accounts, and 12 synthetic conversations, orders, and CRM rows. It ran 6 concurrent requests over two waves with zero request errors. Results are in-process test measurements, not production capacity estimates:

  | Route | Before p50 / p95 (ms) | Updated path p50 / p95 (ms) |
  |---|---:|---:|
  | Login | 431.5 / 842.6 | 239.6 / 244.1 |
  | Conversations | 147.5 / 281.3 | 5.0 / 7.8 |
  | Client dashboard | 191.7 / 330.7 | 6.6 / 11.1 |
  | Order Manager dashboard | 140.5 / 275.9 | 8.6 / 10.5 |
  | Owner dashboard | 140.5 / 281.8 | 29.7 / 37.2 |
  | Marketer dashboard | 142.9 / 269.8 | 7.7 / 10.9 |
  | CRM | 143.2 / 283.3 | 3.8 / 4.9 |

- The local test run also passed TypeScript, Prisma validation, application smoke, staging, staging-auth, JavaScript syntax checks, and `git diff --check`.
- The CI production build passed. Local build and interactive viewport review remain blocked by OneDrive/Next.js filesystem access behavior; exact viewport and physical-device checks are still outstanding.
- Quote create/accept was functionally tested while another connection held the global advisory lock, but quote mutation latency was not part of the p50/p95 benchmark. Order/payment writes still use the serialized compatibility path.

## Staging plan (not deployed)

1. Create a separate staging deployment and isolated PostgreSQL database; never reuse production credentials or data.
2. Supply environment variables through the deployment secret manager, including database connection/SSL settings, staging access password, session signing secret, allowed public URL, and disabled email/payment flags.
3. Put HTTPS and access protection in front of the app, retain `noindex`/robots blocking, and verify the staging gate plus Owner MFA.
4. Apply Prisma migrations, run synthetic seed/setup, then run the customer and staff journey suite.
5. Add monitored backups and a tested restore procedure before any real data is considered.
6. Keep email and payment in mock/manual mode until their providers and credentials are separately reviewed and tested.

## Historical credential note

Earlier repository review found an old administrator password hash and salt in historical Git data. No plaintext password was found in that review. This phase does not change any real account, revoke sessions, rotate credentials, or rewrite Git history. Before public launch, the Owner should rotate the affected credential and invalidate relevant sessions; Git history cleanup is a separate coordinated operation because it changes remote history and existing clones.
