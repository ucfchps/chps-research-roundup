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

## 3. ★ RESOLVED: `ingest-crossref` is now scheduled — history of how it got there

**Status: `.github/workflows/ingest-crossref.yml` exists, runs daily at `0 3 * * *`, unscoped,
for real.** This section is kept in full because the path to "safe to schedule" went through a
dead end first (a scoping fix that turned out not to fix anything) before landing on the real
fix (the confirmation gate, §5/§6). The history is the part worth not losing.

`scripts/ingest-crossref.ts` (§13 Phase 3 item 8) originally shipped with no
`.github/workflows/ingest-crossref.yml`. A follow-up session investigated whether a per-faculty
`--faculty <wp_id>` sweep loop (calling the same scoped path `assertScopeIsSafe` protected)
would resolve the false-positive risk that guard existed for, so a scheduled workflow could
safely wrap it. **It does not — that investigation stopped there rather than building the sweep
script or workflow.** A later session (below, "RE-CHECK") took a different path instead.

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

### RE-CHECK (later session, after §5/§6's confirmation gate shipped): empirical proof, then the guard replaced

Once `buildAuthorInputs` became a structural confirmation gate (§5/§6) rather than an
informational flag, the premise above changed: the harm `assertScopeIsSafe` guarded against —
an unconfirmed name match silently writing `chps_faculty` — is now prevented independent of
scope. This was **verified empirically before touching the guard**, not assumed from the code
review alone.

**Fresh full-129-faculty unscoped dry-run, against the current (post-gate) codebase:**

```
129 faculty swept · 887 Crossref candidate(s) seen · 80 merged · 807 inserted new
544 chps_faculty link(s) confirmed by affiliation · 66 unconfirmed name-only match(es)
```

`confirmedFacultyLinks` (544) can only increment when `buildAuthorInputs` assigned
`role = 'chps_faculty'`, which itself only happens after `isUcfAffiliation` passed — so there is
no path here that writes a confirmed link without corroborating affiliation, by construction.
The empirical value: this ran cleanly at full scale on real, messy data (not just unit-test
fixtures), with a realistic split rather than a suspicious 0% or 100%, and **66 unconfirmed
matches — the exact same count** as the original pre-gate investigation's 66
`nameOnlyMatchUnconfirmed` flags above. Same underlying signal; now gated instead of logged.

**Guard replaced, not deleted.** `assertScopeIsSafe` (scope-based blocking, `--faculty` /
`--i-accept-unconfirmed-identity-risk`) is gone. In its place, `runConfirmationGateSelfTest` /
`assertConfirmationGateWired` (`scripts/ingest-crossref.ts`) — a cheap runtime self-test that
runs unconditionally before every invocation, proving `buildAuthorInputs` still correctly
refuses **both** unconfirmed shapes (no affiliation data at all, and affiliation present but
conflicting) using its own synthetic probe candidate + synthetic roster row, fully disconnected
from the real DB. Defense-in-depth against a future refactor silently bypassing the gate, not a
barrier to running at all — `--faculty <wp_id>` still works as a plain search-scoping flag, it
just no longer gates safety.

Caught a real bug in its own first draft, which is itself evidence the tests aren't vacuous: the
conflicting-affiliation probe originally used the string `"Definitely Not UCF University"` —
`isUcfAffiliation`'s `\bUCF\b` alternative correctly matched the literal word "UCF" in it
regardless of the surrounding "Not," so the self-test's own real-gate test failed against its
own probe. Fixed the probe string (`"Unaffiliated Research Institute, Nowhere"`), not the
regex — the regex was right.

### Now scheduled

`.github/workflows/ingest-crossref.yml` — daily, `cron: "0 3 * * *"` (staggered clear of
`ingest-scholar`'s `0 */6 * * *` and `ingest-pubmed-orcid`'s `0 9 * * *`). Runs `npm run
ingest:crossref` unscoped, for real, matching the other two workflows' conventions
(`actions/checkout@v5`, `actions/setup-node@v5`, `npm ci`, `concurrency: { group:
ingest-crossref, cancel-in-progress: false }`). One deliberate deviation: `workflow_dispatch`
takes an optional `dry_run` boolean input, so a manual on-demand safety check doesn't require
running the script locally — scheduled (cron) runs never see that input and always run for
real.

### ★ Operational consequence: this makes §8b more urgent, not less

Running `ingest-crossref` daily and unscoped means the unconfirmed-match backlog
(`npm run report:unconfirmed-matches`) will keep growing every day, indefinitely, on top of the
151-row backlog already found by the §6 sweep — both the "no affiliation data" bucket and,
more importantly, the "conflicting affiliation" bucket (the one that actually warrants a human
look, §6). The confirmation gate prevents *wrong automated confirmation*; it does not review
anything, and nothing currently drains the backlog it produces. This is a direct, foreseeable
consequence of scheduling daily unscoped ingestion, not an incidental side effect — flagging it
here so it isn't rediscovered as a surprise later. It strengthens the case for §8b (the personal
review page, where faculty can confirm or reject their own unconfirmed matches) and/or a regular
COMMS cadence of actually working through `report:unconfirmed-matches` — neither exists yet.

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

## 5. ★ RESOLVED: unconfirmed name matches are now a structural gate, not a console flag

**Status as of the follow-up session that closed this out: fixed, not just documented.**
`buildAuthorInputs` (`lib/scholar-ingest.ts`) is now the shared confirmation gate every
ingester routes through — a name match (family + first initial, `matchAuthorNameToFaculty`,
still no ORCID cross-check) only becomes `role = 'chps_faculty'` when its affiliation string
corroborates UCF (`isUcfAffiliation`, moved to `lib/matching.ts`). Otherwise it writes
`role = 'unknown'` durably, with `faculty_id` preserved as a reviewable hint and a
`role_set_by` tag distinguishing *no affiliation data at all*
(`ingest:unconfirmed_name_match` — PubMed, always; Crossref/ORCID whenever the field is
genuinely empty) from *affiliation present but doesn't mention UCF*
(`ingest:unconfirmed_name_match_conflicting_affiliation` — stronger negative evidence, the
exact Zhu case below). `scripts/report-unconfirmed-matches.ts`
(`npm run report:unconfirmed-matches`) is the durable review surface this produces, replacing
the old `nameOnlyMatchUnconfirmed` console-only flag (`flagNameOnlyMatches`,
`ingest-crossref.ts`), which is retired.

### The corrected picture on "which sources have the data"

The original write-up of this finding treated ORCID and PubMed as one undifferentiated gap.
They are not the same:

- **Crossref-direct and Scholar-discovered-then-Crossref-resolved** always had per-author
  affiliation data available (`CrossrefResolutionAuthor.affiliation`) — it just wasn't being
  checked before this fix. Nothing new to fetch; the check was simply missing.
- **ORCID works resolved by DOI** round-trip through `resolveByDoi` (`lib/crossref.ts`), which
  returns the exact same `CrossrefResolutionAuthor` shape a Crossref-direct candidate does —
  so ORCID candidates *also* already had this data available, dropped in the same spot.
- **PubMed** genuinely, structurally lacks it — `esummary` has no per-author affiliation field
  at all. This is the one source where "unconfirmed" isn't a missed check, it's the ceiling of
  what the source can ever tell us.

Confirmed with a direct test (`tests/shared-confirmation-gate.test.ts`): the same author +
affiliation fixture, run through all three real entry points (Crossref-direct search, Scholar
alert → Crossref title resolution, ORCID work → Crossref DOI resolution), produces the
identical `role`/`role_set_by` outcome in each — the gate doesn't drift between call sites.

### The Zhu, Y. case (publications.id = 96) — reclassified, not deleted

`Testing circuit-level theories of consciousness in humans` (DOI `10.1016/j.tics.2025.08.012`)
had two `chps_faculty` links: `Zhu, Y.` (faculty_id 23) and `Dykstra, A.` (faculty_id 33). Only
Zhu's was in scope for this session's retroactive fix:

```sql
UPDATE publication_authors
SET role = 'unknown', role_set_by = 'ingest:unconfirmed_name_match', role_set_at = datetime('now')
WHERE publication_id = 96 AND faculty_id = 23;
```

Applied. `role_set_by` deliberately used the *no-data* tag (`ingest:unconfirmed_name_match`),
not the *conflicting-affiliation* one, matching what the row already recorded — `faculty_id`
stays set, reversible in either direction once there's a real answer from Zhu (§8b, once it
ships, or a direct email today — still the fastest real path).

### Dykstra, A. (publication 96, same paper as Zhu) — flagged, NOT reclassified, weaker evidence than Zhu

**Not touched in this session** — reclassifying it wasn't part of the instructions this entry
was written against. Documented here with the same dedicated treatment Zhu got, specifically
so it doesn't sit as a passing mention that quietly goes stale the way Zhu's case almost did
before this conversation started.

- **Real profile:** `faculty.id = 33`, `Andrew Dykstra`, School of Communication Sciences and
  Disorders. Linked to exactly one publication in the whole database — this one.
- **Bucket:** `ingest:unconfirmed_name_match` (no affiliation data at all) — **not**
  `_conflicting_affiliation`. Weaker/neutral evidence, not active evidence of a wrong match.
- **The evidence that actually distinguishes this from Zhu:** Dykstra's *other* candidate from
  his own Crossref author search in the original §3 investigation was *"Combined MEG and EEG
  suggest a limbic source network of the P3 including retrosplenial cortex and hippocampus"* —
  genuine EEG/neuroscience work, topically consistent with a consciousness paper and with a CSD
  faculty member's plausible research area. Zhu's other candidates in that same investigation
  were quantum error correction, embedded systems, and gut microbiome research — nothing
  adjacent to Health Sciences. Dykstra has no corroborating red flag; Zhu had several.
- **Next step:** still needs the same real confirmation as any unconfirmed match (§8b once it
  exists, or a direct email today) — but should not be worked with the same urgency as the 6
  conflicting-affiliation rows in §6. Treat as normal-priority backlog, not a suspected error.

---

## 6. ★ Cross-source sweep: the real number, not an extrapolation from one case

`npm run sweep:role-confirmations` (`scripts/sweep-role-confirmations.ts`) re-ran the exact
gate from §5 against every **existing** `publication_authors` row with
`role = 'chps_faculty'`, `role_set_by = 'ingest'` — i.e. every automated link the system had
made before this session, regardless of which source originally discovered the paper. It's
read-only: it fetches each row's publication DOI fresh from Crossref, rebuilds the author list
through the same `buildAuthorInputs` the ingesters use, and reports what role that row would
get *today* — nothing is written.

### The real number

The sweep was re-run after Zhu's row (§5) was reclassified, so it dropped out of the pool —
151 rows checked here, not the original 152:

```
151 existing 'chps_faculty'/'ingest' rows checked
 91 still confirmed              (60%)
 60 now unconfirmed              (40%)
    54 no affiliation data at all      (90% of the unconfirmed bucket)
     6 conflicting affiliation         (10% of the unconfirmed bucket)
  0 no DOI (unconfirmable)
  0 DOI unresolvable
  0 no longer matched (faculty member absent from the current author list entirely)
```

**The 54/6 split is the number that actually determines urgency, not the bare 60.** No
affiliation data at all is weak/neutral evidence — Crossref's affiliation field being sparse is
normal and expected (master plan §5: "inconsistently populated... many legitimate Crossref
records carry an empty affiliation array"), and most of those 54 are almost certainly correct
matches that simply can't be confirmed from this field. The 6 conflicting-affiliation rows are
different in kind — the affiliation string is present and says something else, the same shape
of evidence Zhu had. **Those 6 are the ones that warrant the same look Zhu got, not the full 60.**

**All 151 are `source = 'crossref'`** — not because the sweep filtered on source (it
deliberately didn't), but because no real (non-dry-run) `ingest-pubmed-orcid` run has ever
happened yet (confirmed separately: `SELECT COUNT(*) FROM publications WHERE source IN
('orcid','pubmed')` returns 0). `ingest-scholar`-discovered records also land here, since
`decideArticleOutcome` stamps `source = 'crossref'` once a Scholar-discovered title resolves —
the source column reflects metadata provenance, not discovery channel.

### The 6 conflicting-affiliation rows — highest priority, same evidence shape as Zhu

- Case Assignment Principles for Achieving Worker Well-Being, Organizational Justice, and Casework Quality → Stewart, C. (28)
- Reliability of achieving target dehydration levels using a portable infrared sauna protocol in healthy young adults → Wells, A. (67)
- Reliability of achieving target dehydration levels using a portable infrared sauna protocol in healthy young adults → Stout, J. (67)
- Demographic and Acoustic Factors Related to Automatic Speech Recognition Inaccuracies for Child African American English Speakers → Fletcher, B. (85)
- The influence of transitioning between grass and concrete surfaces on resultant tibial accelerations while running → Norte, G. (101)
- Potential Influence of Acute Dysregulated Sleep on Fall Incidence Among Low-Income Older Women: A Case Study → Stout, J. (127)

None of these 6 were individually investigated this session (only Zhu was, per the explicit
scope) — this list is "same evidence shape as Zhu," not "confirmed wrong." Same posture as §5:
a human needs to look, not an automated reclassification.

### The other 54 (no affiliation data) — normal-priority backlog

<details>
<summary>Expand — same list scripts/report-unconfirmed-matches.ts now surfaces going forward (includes Dykstra, discussed above)</summary>

- Metabolic and Phonatory Responses to Anaerobic Vocal Capacity Tasks With and Without Back Pressure → Zraick, R. (6)
- Neural activity differences and their functional and clinical correlates after anterior cruciate ligament reconstruction: A systematic review of task-based fMRI studies → Norte, G. (7)
- Mental Health Outcomes Among Non-English Primary Language Survivors of Intimate Partner Violence → Backes, B. (13)
- Creatine monohydrate supplementation for recovery from muscle disuse: Timing matters → Stout, J. (15)
- NFL's Alex Singleton and the Testicular Cancer Detection Gap → Rovito, M.J. (16)
- Acoustic Measures of Articulation and Vocal Quality in Transgender People Completing Vocal Feminization Therapy → McKenna, V. (17)
- Hyperacusis-inducing drug candidates → Salvi, R. (21)
- Hyperacusis-inducing drug candidates → Eddins, A. (21)
- Examining differences in parent-reported screen time from school to summer in children: an observational cohort study → Brazendale, K. (26)
- The Pre-Kidney Transplant Cardiovascular Evaluation: A Narrative Review of Current Scientific Statements and Consensus Documents → Anderson, K. (27)
- Improving the Readability of Spasmodic Dysphonia Patient Education Materials Using ChatGPT-4o Mini: A Cross-Sectional Study → Zraick, R. (33)
- Foundations for writing: preschool oral storytelling following visual design and story grammar instruction → Towson, J. (34)
- Examination and quantification of motor evoked potentials in the non-target resting leg → Stock, M. (44)
- Effect of sex, leg dominance, and task on knee cartilage and anterior cruciate ligament biomechanics during single-leg landings-a pilot study → Norte, G. (46)
- Shared Interactive Book Reading → Towson, J. (53)
- Associations Between Fall Risk and Lower Limb Joint Range of Motion During Sit-to-Stand Among Community-Dwelling Older Adults → Stout, J. (55)
- Why Integrate Mathematics, Science, and Children's Literature? → Towson, J. (56)
- Free summer programming on elementary-aged children's food and beverage consumption: a randomized clinical trial → Brazendale, K. (60)
- Correction: Drug use and sexual behaviors among women who inject drugs and use a syringe services program; Miami, Florida → Scheidell, J. (61)
- Relationships between upper extremity neuromuscular function and patient-reported outcomes among individuals with a history of glenohumeral labral repair → Norte, G. (62)
- Allocative efficiency of opioid overdose prevention strategies for people incarcerated in New Jersey → Scheidell, J. (74)
- Real-Time Resonance Biofeedback for Gender-Affirming Voice Training: Usability Testing of the TruVox Web-Based Application → McKenna, V. (75)
- Test-related psychological responses and quadriceps neuromuscular outcomes in people with and without patellofemoral pain → Norte, G. (77)
- Novel evidence of age-related cortical and subcortical constraints in cross-education → Stock, M. (80)
- A Model for Advocacy Approaches and Goals in Domestic Violence Transitional Housing → Backes, B. (83)
- A Model for Advocacy Approaches and Goals in Domestic Violence Transitional Housing → Leibovits, I. (83)
- Allocative efficiency analysis of strategies to reduce overdose deaths among people with opioid use disorder and history of incarceration in Connecticut → Scheidell, J. (88)
- TruVox Web-Based Software for Vocal Pitch Training in Transgender Women: Development and Single-Session Evaluations → Wang, X. (95)
- TruVox Web-Based Software for Vocal Pitch Training in Transgender Women: Development and Single-Session Evaluations → McKenna, V. (95)
- Testing circuit-level theories of consciousness in humans → Dykstra, A. (96) — see dedicated write-up in §5
- The Cost Effectiveness of a Free Summer Day Camp Voucher Program to Prevent Summer Weight Gain Among Children From Disadvantaged Households → Brazendale, K. (102)
- Navigating service pathways out of youth homelessness: An analysis of shelter utilization in Central Florida → Lu, S. (103)
- Using a Vortex Whistle System to Estimate Phonatory Airflow via the Phonation Quotient → Awan, S. (105)
- Using a Vortex Whistle System to Estimate Phonatory Airflow via the Phonation Quotient → McKenna, V. (105)
- Using a Vortex Whistle System to Estimate Phonatory Airflow via the Phonation Quotient → Eddins, D. (105)
- Screen Time and Objectively Measured Sleep of U.S. College Students: A Brief Report → Lee, E.M. (114)
- Screen Time and Objectively Measured Sleep of U.S. College Students: A Brief Report → Brazendale, K. (114)
- Validity and reliability of a novel portable tension-gauge dynamometer for isometric and isotonic seated knee extension strength measurement → Norte, G. (117)
- Health-related quality of life trajectories among older breast cancer survivors: a SEER-MHOS analysis → Lee, E.M. (122)
- Health-related quality of life trajectories among older breast cancer survivors: a SEER-MHOS analysis → Ferdowsi, K. (122)
- Drug use and sexual behaviors among women who inject drugs and use a syringe services program; Miami, Florida → Scheidell, J. (125)
- Effects of Negative Emotions and Personality Traits on Laryngeal and Speech Motor Control → Zraick, R. (129)
- Perinatal depression at the intersection of race/ethnicity and disability → Chapple, R. (130)
- Comparing quantitative sensory testing and psychological factors between individuals with acute and chronic shoulder pain → Anderson, A. (132)
- Comparing quantitative sensory testing and psychological factors between individuals with acute and chronic shoulder pain → Hanney, W. (132)
- Abstract P3-01-06: Differences in health-related quality of life among breast cancer survivors by Hispanic origins → Lee, E.M. (133)
- Abstract P3-01-06: Differences in health-related quality of life among breast cancer survivors by Hispanic origins → Rovito, M.J. (133)
- Time-course and pressure-dependent changes in microvascular responses during ischemic preconditioning → Stout, J. (134)
- Time-course and pressure-dependent changes in microvascular responses during ischemic preconditioning → Hill, E. (134)
- The influence of chronic knee pain and age on conditioned pain modulation and motor unit control → Hill, E. (137)
- The influence of chronic knee pain and age on conditioned pain modulation and motor unit control → Chaput, M. (137)
- The influence of chronic knee pain and age on conditioned pain modulation and motor unit control → Anderson, A. (137)
- The influence of chronic knee pain and age on conditioned pain modulation and motor unit control → Stock, M. (137)
- Pneumococcal Community-Acquired Pneumonia (CAP) in Adults: Epidemiology, Pathophysiology, and Updated Vaccination Guidance → Lopez Castillo, H. (140)

</details>

### What this does and doesn't mean

**Not** "60 wrong links," and even less so "60 equally-urgent links" — see the 54/6 split
above. What it means: 60 links that were auto-confirmed on name alone now correctly show as
`unknown`/reviewable instead of silently passing as settled fact — exactly the §15.4/§15.11
posture ("when uncertain, mark unknown, never guess"; "surface invisible failures") applied
retroactively instead of only going forward.

**Not actioned in this session** — only publication 96 / Zhu was reclassified (§5), per the
explicit scope given. The rest are visible now (`npm run report:unconfirmed-matches`) but
still show as `chps_faculty` in the live data until someone decides how to handle a batch this
size — a per-row email-and-wait like Zhu's doesn't scale to 60; likely needs either a COMMS
bulk-review pass (start with the 6 conflicting-affiliation rows) or the §8b review page (once
built) surfacing these to the affected faculty directly.
