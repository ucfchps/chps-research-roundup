# CHPS Research Roundup

An automated pipeline that collects CHPS faculty peer-reviewed publications, lets
faculty verify and self-submit what it misses, and generates a ready-to-paste
"Research Roundup" post for the College of Health Professions and Sciences —
correctly grouped by academic unit, with the right names bolded and the right
students starred.

## The problem

Twice a year, someone at CHPS assembles the Research Roundup by hand: chasing
down publications across a dozen-plus publisher sites, manually formatting every
citation, manually sorting them into the right academic unit, and manually
applying the college's bold/asterisk conventions for faculty and student
co-authors. It takes weeks, and the live posts show the scars — the same paper
appearing twice with two different spellings of a co-author's name, students
missing their earned asterisk, and citations linking through Outlook
"safelinks" left over from forwarded emails.

None of that is anyone's fault. It's what happens when a real, recurring
publication process runs entirely on manual lookup and copy-paste. This project
replaces the manual steps with a pipeline, while keeping a human in the loop
exactly where only a human can help — mainly, telling us which co-authors were
students.

## How it works

**Discovery, then resolution.** Google Scholar alerts tell us *a CHPS faculty
member has a new paper* — but Scholar's own alert emails are unreliable for
anything beyond the title and year (truncated author lists, no DOI). So Scholar
is treated purely as a trigger: once a paper is discovered, Crossref (and, as a
backstop, PubMed and ORCID) resolves it into a complete, accurate citation —
full author list, journal, volume, issue, pages. Gray literature that neither
service can reach (preprints, position statements, conference posters) gets
flagged for a human to complete by hand rather than silently dropped.

**Units are computed, not stored.** A publication doesn't have "a unit" — it has
units, plural, derived from which CHPS faculty are on it. A paper co-authored
across two academic units correctly appears in both sections, with the same
bolding in each, because it's rendered from one shared record instead of two
independently hand-typed ones. This is the single biggest source of
inconsistency in the current manual post, and it becomes structurally
impossible once units are derived instead of typed.

**Student credit needs a human.** No database on earth knows which co-authors
were a faculty member's graduate or undergraduate students — only the faculty
member does. So each professor gets a short, personal review link showing just
their own upcoming publications and just the co-authors nobody could identify,
with a plain-language ask: was this person your student? That answer is the one
piece of data this entire system cannot get anywhere else.

**Editions, not date ranges.** The roundup isn't "everything published between
two dates" — it's "everything collected since the last roundup that hasn't
gone out yet." A publication is stamped with the edition it appeared in, which
makes double-posting the same paper across two roundups structurally
impossible, instead of a thing a human has to remember to check.

**Nothing goes public unreviewed.** Automation drafts a complete, correctly
formatted post. A person at COMMS reviews it, resolves any open flags, and
presses publish.

Full spec: [`master-plan/CHPS_Research_Roundup_Master_Plan.md`](master-plan/CHPS_Research_Roundup_Master_Plan.md)
— read it before making changes. This README stays intentionally brief; the
master plan is the source of truth for schema, data flow, and design
rationale.

## Status

Built in phased sessions, each independently verified before the next begins
(see the master plan §13 for the full build order).

- ✅ **Phase 1 — Foundation.** Database schema, the AI-provider abstraction
  layer with usage logging, and the citation formatter — validated against
  citations pulled from the actual live roundup post.
- ✅ **Phase 2 — Roster.** Faculty roster synced from the WordPress directory,
  including the Google Scholar profile ID that later ties an alert email back
  to a specific faculty member, plus automatic detection of who's missing
  Scholar alert coverage.
- ✅ **Phase 3, part 1 — Matching & merge engine.** The pure logic that decides
  whether two incoming records are the same paper and merges them without
  duplicating — the fix for the exact failure mode (the same paper posted
  twice) that motivated this whole project.
- ✅ **Phase 3, part 2 — Crossref resolver.** Turns a bare title into a
  complete citation — DOI, full author list, journal, volume, issue, pages —
  and refuses to guess when a match isn't confident. Verified against the live
  API and the actual published roundup post; several real transcription errors
  in the live post were found and documented in the process.
- 🔄 **Phase 3, part 3 — Metadata refresh.** In progress. Keeps already-ingested
  citations from going stale (an ahead-of-print paper's pagination gets filled
  in once assigned) or shipping with silently wrong values.
- ⏭ **Still ahead:** the Scholar-alert ingester, PubMed/ORCID enrichment, the
  public search portal, the faculty review page, and the COMMS admin
  (generator, pending-submissions queue, roundup archive).

## Setup

```bash
npm install
cp .env.example .env.local   # fill in values — see below
npm run migrate               # applies db/migrations/*.sql to Turso
npm run dev
```

`.env.example` documents every variable this project uses, with comments. The
short version: a Turso database, a Groq API key (free tier, swappable later),
the WordPress directory's REST endpoint, and — once the ingestion phases land —
Gmail OAuth credentials and a Crossref contact email.

## Scripts

- `npm run dev` — Next.js dev server
- `npm run migrate` — applies pending migrations in `db/migrations/` (idempotent)
- `npm test` — runs the vitest suite
- `npm run check:ai` — one real call through the AI abstraction layer; prints
  the response and the logged token counts
- `npm run sync:roster` — pulls the faculty roster from the WordPress
  directory, upserts it, and parses each profile's Scholar ID (idempotent)
- `npm run report:coverage` — prints which faculty are missing a Google Scholar
  alert, have an unparseable Scholar link, or have no Scholar profile at all
- `npm run check:crossref -- "<title>" [year] [surname]` — resolves a bare
  title against the live Crossref API and prints a fully formatted citation;
  the fastest way to see the resolver work end to end

## Structure

```
app/                  # Next.js routes (portal, review page, admin) — later phases
lib/
  db.ts               # Turso client + query helpers
  types.ts            # shared TS types mirroring the schema
  ai.ts               # callAI() — provider-agnostic AI calls + usage logging
  citation.ts         # the citation formatter — bold/asterisk rules, unit derivation
  scholar.ts          # Scholar profile URL parsing (the alert→faculty join key)
  wordpress.ts        # WordPress directory REST client
  coverage.ts         # Scholar-alert coverage detection
  matching.ts          # deterministic paper matching + merge rules
  matching-ai.ts       # AI-assisted fuzzy title matching (fallback only)
  crossref.ts          # resolveByTitle / resolveByDoi — title or DOI in, full citation out
  http.ts              # shared retry/backoff, used by crossref.ts (and soon refresh-metadata.ts)
db/
  migrations/         # numbered SQL migrations
  migrate.ts          # migration runner (idempotent)
scripts/              # CLI + GitHub Actions job entrypoints
tests/
  fixtures/           # real data captured from the live roundup post + live APIs
docs/
  wp-directory-notes.md   # WordPress field names, taxonomy mappings, sample records
master-plan/
  CHPS_Research_Roundup_Master_Plan.md   # full spec — source of truth
```
