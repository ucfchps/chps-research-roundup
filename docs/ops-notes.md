# Ops & Deployment Notes

**Purpose:** CI/deployment configuration for the CHPS Research Roundup — GitHub Actions
secrets, variables, and cron workflow setup. This is deliberately separate from
`docs/wp-directory-notes.md`, which stays scoped to the WordPress REST API.

**Verified:** July 2026.

---

## 1. `ingest-scholar` — GitHub Actions secrets & variables

**Workflow file:** `.github/workflows/ingest-scholar.yml`
**Schedule:** every 6 hours (§9 of the master plan), plus manual trigger via
`workflow_dispatch`.

Configured in the repo's **Settings → Secrets and variables → Actions**, under
**Repository secrets** / **Repository variables** — not an Environment. The workflow file
doesn't declare an `environment:` key, so environment-scoped values are invisible to it.

**Source of truth for every value below: your local `.env.local`.** Copy from there —
don't re-derive or re-request credentials separately for CI.

### Secrets (encrypted, write-only after saving)

| Name | Used for |
|---|---|
| `TURSO_DATABASE_URL` | libSQL client connection |
| `TURSO_AUTH_TOKEN` | libSQL client auth |
| `GMAIL_CLIENT_ID` | OAuth token refresh |
| `GMAIL_CLIENT_SECRET` | OAuth token refresh |
| `GMAIL_REFRESH_TOKEN` | OAuth token refresh — the long-lived credential; rotate with care, see below |
| `GROQ_API_KEY` | `callAI` (§10) — fuzzy-match / parse fallback calls |

### Variables (plain text, visible in the UI)

| Name | Value (as of July 2026) |
|---|---|
| `GMAIL_ALERT_QUERY` | `from:scholaralerts-noreply@google.com subject:"new articles"` |
| `GMAIL_PROCESSED_LABEL_ID` | `Label_1` — ★ **fragile.** This is Gmail's internal ID for `roundup/processed`, not a stable name. If the label is ever deleted and recreated, this ID changes and must be re-looked-up (see below). |
| `GMAIL_PROCESSED_LABEL_NAME` | `roundup/processed` |
| `CROSSREF_MAILTO` | Contact email for Crossref's polite pool (§5, Layer 2). Required at `lib/crossref.ts` import time — unset, the module throws immediately and every scheduled run fails before touching Gmail or the DB. |
| `AI_PROVIDER` | `groq` |
| `AI_MODEL` | `openai/gpt-oss-120b` |

**Why the split:** anything that authenticates as *you* or *this app* to an external service
is a secret. Anything that's just configuration — a query string, a label's display name, a
model identifier — is a variable. Being non-sensitive, variables don't need re-entering blind
the way secrets do if you ever need to double-check a value.

### Re-deriving `GMAIL_PROCESSED_LABEL_ID` if it's ever lost or changes

```bash
set -a && source .env.local && set +a
ACCESS=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d client_id="$GMAIL_CLIENT_ID" -d client_secret="$GMAIL_CLIENT_SECRET" \
  -d refresh_token="$GMAIL_REFRESH_TOKEN" -d grant_type=refresh_token \
  | python3 -c "import sys, json; print(json.load(sys.stdin)['access_token'])")

curl -s -H "Authorization: Bearer $ACCESS" \
  https://gmail.googleapis.com/gmail/v1/users/me/labels \
  | python3 -c "
import sys, json
for l in json.load(sys.stdin)['labels']:
    if l['name'] == 'roundup/processed':
        print(l['id'])
"
```

### Verifying the workflow itself

GitHub Actions tab → `ingest-scholar` (left sidebar) → "Run workflow" (manual trigger via
`workflow_dispatch`). A missing or misnamed secret surfaces immediately as a failed run with
a clear error in that run's log — don't wait for the 6-hour schedule to find out something's
wrong.

> ⚠️ If `GMAIL_REFRESH_TOKEN` is ever rotated (re-authorized OAuth consent, scope change,
> revoked access), it must be updated **here**, in the Actions secrets — GitHub Actions
> doesn't read from `.env.local` automatically, and a stale token here will fail silently in
> the cron logs rather than in front of anyone watching a terminal.

---

## 2. `ingest-pubmed-orcid` — GitHub Actions secrets & variables

**Workflow file:** `.github/workflows/ingest-pubmed-orcid.yml`
**Schedule:** daily (§9 of the master plan, §13 Phase 3 item 10), plus manual trigger via
`workflow_dispatch`.

Reuses `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` and the `CROSSREF_MAILTO` variable already
configured for `ingest-scholar` — see §1. Don't re-derive those.

### New secrets

| Name | Used for |
|---|---|
| `NCBI_API_KEY` | PubMed E-utilities. Optional but recommended — raises the rate limit from 3 req/sec to 10 req/sec (`lib/pubmed.ts`). |

### New variables

| Name | Value |
|---|---|
| `NCBI_TOOL_NAME` | Sent as the `tool` param per NCBI's usage policy — not a credential. |
| `NCBI_EMAIL` | Sent as the `email` param per NCBI's usage policy — not a credential. |
| `ORCID_LOOKBACK_YEARS` | Bounds `getOrcidWorks` to recent publication years (`lib/orcid.ts`). Default 3 if unset. |

### Verifying the workflow itself

Same as §1: GitHub Actions tab → `ingest-pubmed-orcid` → "Run workflow" (manual trigger). A
missing or misnamed secret surfaces as a failed run in that run's log.

---

## 3. ★ `ingest-crossref` still has no workflow file — blocked, not just unbuilt

`scripts/ingest-crossref.ts` (§13 Phase 3 item 8) has no `.github/workflows/ingest-crossref.yml`.
A follow-up session investigated whether a per-faculty `--faculty <wp_id>` sweep loop (calling
the same scoped path `assertScopeIsSafe` already protects) would resolve the false-positive risk
that guard exists for, so a scheduled workflow could safely wrap it. **It does not — the
investigation stopped there rather than building the sweep script or workflow.**

### What was tested

`assertScopeIsSafe`'s comment cites a full-roster dry-run showing "~814 of 890 candidates would
have inserted, many to the wrong same-surname person." A fresh unscoped dry-run against live
data reproduced the same shape (129 faculty swept, 885 candidates seen, 805 inserted, **66
`nameOnlyMatchUnconfirmed` flags** — the real false-positive-relevant metric, not the insert
count itself, which is mostly just legitimate new papers).

10 of those flagged faculty were re-run individually via `--faculty <wp_id> --dry-run` and
compared against the *same* candidates from the unscoped run. Naive raw counts looked
encouraging at first (some dropped, e.g. Norte 5→2, Stewart 3→2) — but tracing the actual flagged
titles showed this was **entirely a deduplication artifact**: in the unscoped run, the same real
candidate can be independently rediscovered by *multiple* faculty members' own searches (e.g.
two different roster members both named "Loughran" both surfacing the same rattlesnake paper),
and each rediscovery reprocesses and re-flags it — inflating the unscoped total without
representing distinct risk. Once de-duplicated by title, **all 10 sampled people showed the
exact same set of flagged candidates whether run scoped-alone or as part of the full sweep** —
identical titles, identical affiliation strings, zero difference.

### Why: the root cause, confirmed by reading the code

`scripts/ingest-crossref.ts::runIngestCrossref` scopes `--faculty <wp_id>` by filtering which
faculty get their **own Crossref search** run (`scoped`/`searchable`) — but `applyCandidate` is
always called with `roster`, the full, unfiltered active roster, never `scoped`. Every co-author
on every candidate — regardless of which person's search found it — gets matched against all 129
active faculty via `matchAuthorNameToFaculty` (`lib/scholar-ingest.ts`), which is family +
first-initial only, with no ORCID or other identity cross-check. Scoping controls *how many
people get searched in one run*; it does not touch *who a found candidate's co-authors get
matched against*. There is no code path in which `--faculty` narrows that roster.

**Conclusion: per-faculty scoping does not fix the false-positive mechanism — it only
eliminates redundant re-discovery of the same candidate across multiple people's searches within
one unscoped run.** A roster-sweep script that loops `--faculty` once per person would produce
the identical set of unconfirmed `chps_faculty` links as today's guarded unscoped path, just
spread across more process invocations. Building that sweep and wiring a daily workflow to it
would not be a safety improvement — it would look like one.

**Not pursued in that session, and not scoped for a quick follow-up:** the real fix is
strengthening `matchAuthorNameToFaculty` itself (e.g. an ORCID cross-check where available, or
requiring affiliation confirmation before auto-linking `chps_faculty`) before `ingest-crossref`
gets a scheduled workflow of any shape. Until then, `assertScopeIsSafe`'s guard is doing the one
job it claims to do — blocking a *new, accidental, unscoped* real run — correctly. That is a
narrower claim than "the existing matches are safe": `matchAuthorNameToFaculty`'s weakness
predates this guard and already has at least one live wrong link in production from an earlier
real run — see §5. Don't read this section as clearing anything already written; it only means
the specific accidental-unscoped-run failure mode the guard targets is closed.

### Step 4 (same investigation): Crossref query-broadening check — reassuring, no gap found

`ingest-crossref.ts` already queries Crossref with `f.full_name` (rich form, e.g. "Matt S.
Stock"), not the sometimes-sparse `display_name` — unlike PubMed's confirmed bug (§13 item 10,
above). A live, read-only comparison for Stock confirmed the choice matters: `query.author=Stock,
M.` (sparse) returned unrelated marketing/business papers by a different "M. Stock" mixed into
its top 20 relevance-ranked results; `query.author=Matt S. Stock` (full) returned 20/20 results
that were all genuinely his exercise-physiology work. So Crossref's relevance ranking is *not*
immune to the same class of degradation PubMed's exact boolean match suffered — but since the
code already uses the richer field, there's no gap to fix here.

---

## 4. ★ Data-hygiene bug found in `faculty.full_name` — flagged for `sync-roster`'s owner

Confirmed live (§13 item 10 bug-fix session, `lib/names.ts::parseFullNameForPubmedQuery`): the
`faculty` row for `display_name = "Lee, E.M."` has a corrupted `full_name` value —

```
Eunkyung &#8220;Muriel&#8221; Lee
```

Raw, undecoded HTML entities (curly-quote codes) sitting in the column, sourced from
`title.rendered` per `docs/wp-directory-notes.md` §2. This is a `sync-roster`/WordPress-REST
ingestion bug — the entity decoding that already happens for taxonomy names (§5 of that doc)
evidently isn't applied to `title.rendered`. **Out of scope for this fix pack** —
`parseFullNameForPubmedQuery` deliberately fails closed on it (returns `null`, no entity
decoding attempted — that normalization belongs in `sync-roster`, not in a PubMed-query
builder) and the caller falls back to `display_name`, which happens to already be complete for
this person. Whoever owns `sync-roster` should decode HTML entities on `title.rendered` the
same way taxonomy names already are.

Also found while auditing the mismatch-guard path against every live roster row: `faculty` row
`display_name = "Renziehausen, J."` has `full_name = "Justine Starling-Smith"` — a completely
different surname from the same person's citation-form last name. Most likely a maiden/married
name applied to one WordPress field and not the other. `parseFullNameForPubmedQuery` correctly
fails closed (the known surname "Renziehausen" doesn't appear anywhere in "Justine
Starling-Smith") and falls back to `display_name`, so this doesn't break PubMed queries — but
it's a real inconsistency in the underlying directory data, worth a look by whoever can check
which of the two names is current.

---

## 5. ★ Suspected wrong author link already live in production — needs a human, not a query

Found while spot-checking existing `source = 'crossref'` records for the §3 investigation above.
**Suspected, not confirmed** — do not "fix" this from Crossref metadata alone; see reasoning
below.

**`publications.id = 96`**, title *"Testing circuit-level theories of consciousness in humans"*
(DOI `10.1016/j.tics.2025.08.012`, a *Trends in Cognitive Sciences* paper), has a
`publication_authors` row linking it to `faculty` row `display_name = "Zhu, Y."` with
`role = 'chps_faculty'`, written 2026-07-16 by a real (non-dry-run) `ingest-crossref` run —
predates any of the dry-run investigation in §3.

**Why it's suspicious:** `Zhu, Y.`'s name repeatedly produced unrelated-field false positives
in the §3 dry-run sample — quantum error correction, embedded systems, underwater vehicle
actuators, gut microbiome research — none plausibly CHPS work, all matched by family + first
initial alone (`matchAuthorNameToFaculty`, no ORCID or affiliation cross-check). A consciousness/
cognitive-science paper fits that same pattern: not an obvious match to any CHPS unit.

**Why it's still just "suspected":** `nameOnlyMatchUnconfirmed` (§3) is a console-only flag —
nothing persists it, so this row's original ingest run gave no durable signal that a human
should look at it. There's no `possible_duplicates` entry either (checked: zero rows for
`publication_id = 96`) — that table is written by a completely different mechanism
(`ingest-scholar`'s near-duplicate-title check), unrelated to `nameOnlyMatchUnconfirmed`. So this
sat unflagged and un-actioned since 2026-07-16 with no trace anywhere until this session's manual
DB query turned it up.

**Deliberately not touched in this session** — pulling the DOI's Crossref affiliation would only
get to "this looks wrong," never to "confirmed wrong." Real confirmation is the person saying
it isn't theirs (§8b's whole reason for existing), and unlinking based on metadata alone risks
being just as wrong as the original match, permanently and silently (nothing re-links a role
once cleared).

**Fastest real path, available today, no code needed:** someone on the team emails Zhu directly
and asks — faster than waiting for §8b to ship, and it's the actual gold-standard answer either
way.

**The real underlying gap this exposes:** `nameOnlyMatchUnconfirmed` needs to persist somewhere
queryable (a table, or a status/flag column) instead of only ever existing in one run's console
output — otherwise every future ambiguous match has the same fate as this one: correctly detected
at ingest time, then invisible forever after. Not scoped as a fix here; noting it so it doesn't
get rediscovered from scratch next time.
