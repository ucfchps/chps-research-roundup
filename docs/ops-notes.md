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

## 2. Future cron jobs

`ingest-crossref`, `ingest-pubmed-orcid`, and `release-buffer` (§9, §13) will each need their
own workflow file and their own section here as they're built. Reuse the same
secrets/variables above where applicable — don't re-request or re-derive credentials that
already exist in this list.
