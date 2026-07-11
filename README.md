# CHPS Research Roundup

Automates the CHPS "Research Roundup" post: collects faculty publications, lets
faculty verify/submit them, and generates ready-to-paste HTML grouped by unit.

Full spec: `master-plan/CHPS_Research_Roundup_Master_Plan.md` — read it before
making changes.

This session (Phase 1, item 1) is scaffold + database schema only. No
ingestion, AI, citation formatter, or UI beyond the default Next.js page yet.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in values — see below
npm run migrate               # applies db/migrations/*.sql to Turso
npm run dev
```

## Scripts

- `npm run dev` — Next.js dev server
- `npm run migrate` — applies pending migrations in `db/migrations/` (idempotent)
- `npm test` — runs the vitest suite

## Structure

- `app/` — Next.js routes (portal, review page, admin) — later phases
- `lib/db.ts` — Turso client + query helpers
- `lib/types.ts` — shared TS types mirroring the schema
- `db/migrations/` — numbered SQL migrations
- `db/migrate.ts` — migration runner
- `scripts/` — GitHub Actions job entrypoints — later phases
- `tests/` — vitest
