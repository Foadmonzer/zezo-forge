# ZEZO Forge production operations preparation

This document prepares deployment without creating a cloud service or changing DNS.
The application has not been approved for production traffic.

## Runtime shape

- Run the Next.js app as a persistent Node.js web service with `pnpm start`.
- Run the durable email Outbox poller as a separate worker with `pnpm worker:mail`.
- Both services must point to the same production PostgreSQL database through a secrets manager. Do not use JSON file storage, a server-memory session store, or local uploads in a multi-instance deployment.
- Run `pnpm db:migrate:deploy` as a one-off pre-deploy step, then `pnpm typecheck`, `pnpm build`, and the approved smoke checks.
- Leave `ZEZO_ENABLE_EMAIL_DELIVERY=false` until the sender domain, provider, bounce handling, and delivery test are approved. Do not configure WhatsApp or real payment credentials in Staging.

## Container deployment files

- `Dockerfile` builds the Next.js app on Node 22 and includes PostgreSQL client tools for the operator backup helper. The runtime uses the unprivileged `node` account and has an HTTP health check.
- `compose.production.yml` defines the web process, the separate Outbox worker, and an opt-in migration job. It expects an external PostgreSQL URL and does not start or seed a database.
- The Compose web port is bound to `127.0.0.1` so a reverse proxy can terminate HTTPS. Do not open port 3000 directly to the Internet. Configure the proxy to overwrite forwarded headers before setting `ZEZO_TRUST_PROXY=1`.
- Keep `DATABASE_URL`, `MIGRATION_DATABASE_URL`, and other values in the host secret manager. The `tools` profile migration job is a one-off deployment step; do not run it against Staging or Production without the approved target URL.
- The Docker image build was checked locally. Creating cloud services, HTTPS proxy/DNS records, alert destinations, or scheduled backups still requires a host and account decision.

## Required environment values

Copy `.env.example` into the host's secret manager, not into a committed `.env` file. Set:

- `NODE_ENV=production`
- `DATABASE_URL` to the dedicated production PostgreSQL URL with TLS required by that provider
- `ZEZO_PUBLIC_URL=https://zezoforge.com` only after domain ownership and DNS are verified
- No public Owner-registration flag or route is used; first-owner creation is a private PostgreSQL CLI operation.
- `ZEZO_STAGING` unset or `false`
- `ZEZO_ENABLE_EMAIL_DELIVERY=false` until separately approved
- `ZEZO_TRUST_PROXY=1` only after confirming the selected host overwrites forwarded IP headers
- `ZEZO_DATABASE_POOL_SIZE` within the database's connection allowance divided across web and worker instances
- `ZEZO_BACKUP_ENCRYPTION_KEY` only in a protected operator environment when running encrypted backups

Keep payment and WhatsApp integrations disabled. Keep AI credentials absent until consent, privacy, and cost handling are reviewed. Create a dedicated non-owner app database role with only required privileges. Run migrations with a separate migration role if the chosen host supports it.

## Database backup encryption

The repository helper streams a PostgreSQL custom-format dump through AES-256-GCM and does not write plaintext dumps. It expects Node.js 20+ and `pg_dump` / `pg_restore` on `PATH`; optional `ZEZO_PG_DUMP_BIN`, `ZEZO_PG_RESTORE_BIN`, and JSON argument-prefix variables allow an operator-controlled wrapper. The helper reads connection parameters from `DATABASE_URL`, but does not put the URL in tool arguments or logs.

1. Create a random 32-byte backup key in the hosting secrets manager or a password manager. Keep a second protected recovery copy separate from the database and backup destination. Do not reuse the application session secret.
2. Back up into an encrypted object-store bucket with retention and access logging. Never keep the only copy on the database host. Set `DATABASE_URL` and `ZEZO_BACKUP_ENCRYPTION_KEY` in a private operator shell, then run:

   ```powershell
   pnpm db:backup:encrypted -- D:\secure-backups\zezo-<utc-date>.pgdump.aesgcm
   ```

3. For a recovery drill, create a new empty disposable database whose name starts with `zezo_restore_test_`, set its URL in `DATABASE_URL`, set `ZEZO_CONFIRM_TEST_RESTORE=YES`, and run:

   ```powershell
   pnpm db:restore:encrypted:test -- D:\secure-backups\zezo-<utc-date>.pgdump.aesgcm
   ```

   This command rejects database names outside `zezo_restore_test_<suffix>`, uses a single restore transaction, and must not be pointed at a production database. Verify schema and synthetic record counts before destroying that disposable database.

4. Before a real recovery, restore into a *new* production-sized database, validate it, and only then switch the app secret to the recovered URL. The synthetic-only helper intentionally cannot restore directly into a live production database.

The repository alone cannot protect the key, bucket, retention policy, alerts, or backup schedule. Those require an owner-selected host and secret/object storage account. A provider's PITR is not a substitute for an independently held encrypted export.

## Monitoring and operational checks

- Alert on service restarts, HTTP 5xx, authentication spikes, PostgreSQL connection saturation, migration failure, Outbox retry growth, and failed backup/restore jobs.
- Keep email delivery disabled until the Outbox worker has a provider key and sender domain installed in the secret manager and a successful controlled delivery is explicitly authorized.
- Perform a restore drill before onboarding customers and periodically thereafter. Record the observed restore time, not a guessed RTO.
- Keep request logs free of passwords, session cookies, full payment references, customer WhatsApp numbers, and database URLs.
- Review the current PostgreSQL CI finance stress result before launch. The synthetic suite exercises 24 concurrent withdrawal attempts, partial reservations, rejection release, duplicate payment idempotency, and wallet balance snapshots.

## Owner bootstrap and history

The public signup interface and `/api/setup` endpoint never create Owner accounts. To provision the first Owner, an operator with PostgreSQL access must use a private interactive terminal after setting `DATABASE_URL` in that terminal and `ZEZO_CONFIRM_FIRST_OWNER=CREATE_FIRST_OWNER`. Run `pnpm owner:provision`; it requires a second typed confirmation, accepts the password only as hidden terminal input, refuses non-interactive input, and locks transactionally after any Owner row exists (active or disabled). The account is flagged to change its password immediately and complete management MFA. The CLI does not create a session and never prints the password or hash. Test the procedure only against a disposable PostgreSQL database first.

The historical Git record contains an old administrator password hash and salt. The available repository evidence cannot determine whether that identity was an abandoned test account or remains active. Before launch, coordinate with the account owner and specialist engineer to compare historical identifiers to the live Owner inventory without exposing hashes, rotate any matching live credential, and revoke all active `auth_sessions` for the affected account. Do not rewrite Git history until that coordination and a repository-wide secret scan are complete. No real Owner account, session, or Git history was changed by this readiness work.

## Railway deployment files (prepared only)

- `.railway/railway.ts` defines the web service, managed PostgreSQL, durable Outbox worker, and a daily encrypted backup job. It targets `codex/nextjs-migration-20261104`; it does not create Railway resources until an operator links and applies this configuration.
- The service runs the existing Dockerfile, applies Prisma migrations as a pre-deploy command, and uses `/api/health`. Public Owner setup remains disabled. Email delivery is pinned off until its provider is separately configured and approved.
- The backup job creates an AES-256-GCM `pg_dump` in a temporary directory, uploads it over HTTPS with S3 Signature V4 to a private S3-compatible bucket, and removes the local encrypted file. Set `ZEZO_BACKUP_ENCRYPTION_KEY` only in the Railway secret store; keep its recovery copy outside Railway. Do not put the key in `.railway/railway.ts`, GitHub variables visible to builds, or the database service.
- The Railway Bucket is separate from PostgreSQL but is still the same provider. The current Railway bucket feature does not provide object lifecycle rules, so a true independent disaster-recovery copy and automated retention remain a pre-launch operator decision. Configure an external S3-compatible destination with lifecycle retention or copy the encrypted object to a separately controlled account, and test retrieval/decryption plus restore before production.
- Railway health checks, service logs, and resource metrics are available for web, worker, database, and cron job; alert destinations and thresholds must be configured in the linked Railway project before launch. This repository has not enabled external monitoring or sent alerts.

## Provider notes

The preliminary operating scenario is one persistent web process, one Outbox worker, managed PostgreSQL, modest early traffic, and no HA replica. Railway's public rate card charges $10/GB-month RAM, $20/vCPU-month CPU, $0.05/GB service egress, $0.15/GB-month volume storage, and $0.015/GB-month for Buckets. An illustrative always-on footprint of 0.5 GB web + 0.25 GB worker + 0.5 GB PostgreSQL RAM is $12.50/month in RAM; average 0.25 vCPU across all services adds about $5/month; 5 GB volume adds $0.75; 20 GB egress adds $1; and 10 GB of backup objects adds $0.15. That is about $19.40 before mail, domain, tax, overage, or larger DB/backup usage. The Pro plan's $20/month minimum usage includes $20 of usage, so this modest scenario would be around $20/month total; higher usage increases the invoice. These are assumptions, not a provider quote. Railway labels Hobby for personal/side projects and Pro for professional production teams; Pro is the appropriate launch tier for ZEZO even though the application can technically run on lower limits. See the live rate card again before purchase.
