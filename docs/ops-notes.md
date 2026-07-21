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

### ★ `ingest-crossref` has no workflow file yet

Unlike `ingest-scholar` and now `ingest-pubmed-orcid`, `scripts/ingest-crossref.ts` (§13 Phase 3
item 8) was built without a corresponding `.github/workflows/ingest-crossref.yml` — confirmed
absent as of this session. It still needs one, reusing the same `TURSO_*`/`CROSSREF_MAILTO`
values above, before it can run on a real schedule rather than by hand.

### Verifying the workflow itself

Same as §1: GitHub Actions tab → `ingest-pubmed-orcid` → "Run workflow" (manual trigger). A
missing or misnamed secret surfaces as a failed run in that run's log.

---

## 3. ★ Data-hygiene bug found in `faculty.full_name` — flagged for `sync-roster`'s owner

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
