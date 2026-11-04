# ZEZO Forge

ZEZO Forge is a bilingual Arabic/English website and team workspace for ZEZO Digital Solutions & AI. The current source preserves the complete existing ZEZO experience while introducing a Next.js App Router entry point and a PostgreSQL schema for a staged migration.

## Current migration status

- The website shell is served through Next.js App Router and keeps the existing 40 interactive demos, Arabic/English interface, CSS, imagery, customer screens, and workspace UI.
- Next.js API routes adapt local requests to the existing Node domain handler so the current role, CRM, quotes, conversations, referrals, commissions, finance, projects, and notification behaviors remain available during local migration review.
- The API adapter explicitly returns `503` on Vercel. The current domain handler still writes its store and attachments to local disk, so serverless persistence is not ready yet. This guard prevents a deployment from silently accepting writes to ephemeral storage.
- Prisma 7 and PostgreSQL schema/migration tooling are included. The live handler is not yet reading and writing the normalized Prisma models. Do not attach a production database or deploy this branch until the persistence and session migration is completed and integration-tested.
- Existing JSON data is not copied or imported. Local smoke tests use disposable synthetic directories.

## Requirements

- Node.js 24 LTS (or a supported Node release compatible with Next.js 16)
- pnpm 11
- PostgreSQL is optional for local preview and required only after the Prisma persistence phase is implemented.

## Run the Next.js preview

```powershell
pnpm install --frozen-lockfile
pnpm dev --port 4187
```

Open `http://127.0.0.1:4187`. Runtime JSON data is created under the project `data/` directory unless `ZEZO_DATA_DIR` is set. `data/` is ignored by Git. Do not point this preview at a production data directory.

## Checks

```powershell
pnpm typecheck
pnpm build
pnpm test
```

The smoke suite starts with synthetic isolated storage. It covers roles and permissions, customers, CRM, conversations, quotes, project lifecycle, referral attribution and ranks, withdrawals, and developer execution commission calculations.

## Prisma commands

Copy `.env.example` to `.env` and set `DATABASE_URL` only after selecting and configuring a PostgreSQL host. No credentials are included in this repository.

```powershell
pnpm db:generate
pnpm db:migrate:dev
```

Use `pnpm db:migrate:deploy` in a deployment pipeline only after reviewing the generated migration against the chosen empty test database. Existing JSON files are never imported automatically. The compatibility schema is temporary and must not be used as the final normalized persistence layer.

## External integrations

- Email and WhatsApp are still external handoff/integration points; their actual delivery must be tested separately.
- Payment collection and staff transfers remain manual or simulated. No real payment gateway is configured.
- Database, object storage, mail provider, and production hosting have no credentials configured.
- Vercel Hobby is unsuitable for commercial operation; choose an eligible plan or another compatible host before launch.
