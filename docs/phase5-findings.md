# Phase 5 findings — consolidated, Sessions 0–9

Every finding surfaced across the Phase 5 hardening pack (Session 0's surface
recon through Session 9's CI/guards work), in one table. Standing rule for
the whole pack still applies: this document reports and tracks, it does not
fix — the two rows marked **fixed** were each their own explicitly-authorized
session; everything else marked **open** is deliberately untouched pending
its own session.

**Severity scale** (mine — adjust freely):
- **Critical** — unauthenticated, exploitable today, meaningful blast radius.
- **High** — either a severe, already-live operational failure at scale, or an authenticated/low-likelihood path to serious impact.
- **Medium** — real gap, bounded blast radius, or requires an already-legitimate credential to reach.
- **Low** — genuine but minor: papercut, low-likelihood, or cosmetic.

## Findings

| # | Finding | Session | Severity | Status | Remediation |
|---|---|---|---|---|---|
| 1 | `sync-roster`, `release-buffer`, `refresh-metadata` have no GitHub Actions workflow — CLI-only in practice, contradicts §9's "Daily"/"Every 6h" claim; `release-buffer` specifically confirmed stalled (13+ days with nothing promoted) as a direct consequence | 0, 2 | **High** | Open | Add `.github/workflows/*.yml` for all three, matching the existing `ingest-*.yml` pattern (cron + `concurrency: group`), or explicitly document them as human-run and drop the "Daily" claim from §9 |
| 2 | PubMed structurally cannot capture author affiliation via `esummary` (`PubmedRecordAuthor` has no such field; confirmed 0/4,027 real yield), and `searchPubmedByAuthor` deliberately searches by author name only — no affiliation filtering anywhere in the PubMed candidate path (Session 11: 89/229 faculty hit `retmax=250`, 28,088 predicted new rows against a 5,797-row table). **Session 12 built and measured the fix live against production**: `efetch`-based affiliation classification (`confirmed`/`not_ucf`/`ambiguous`), applied as a plausibility signal, never an exclusion. Real result on the 87/229 faculty this run reached before its ceiling: of 7,695 new PubMed candidates, only **302 (3.9%) are affiliation-confirmed** — 6,987 (90.8%) are `not_ucf`, 406 (5.3%) are `ambiguous`. Confirms the original hypothesis at real scale, and confirms it's *not* confined to the 89 flagged common-surname cases: even the 65 non-over-broad faculty in this run's sample showed 82.3% `not_ucf`. **A second, newly-discovered blocker**: `efetch` measured 8.6x slower per-faculty-member in this sustained real run than short-burst calibration predicted (51.7s/person vs. an expected ~6s/person) — the wall-clock ceiling only stops *starting* new faculty, so it doesn't bound this; the run took 74m56s real wall-clock to reach 87/229 faculty, which would exceed even the original 30-minute CI timeout that finding #3 was built to fix. **This job cannot be scheduled again until this second cost problem is solved too** — the affiliation fix is necessary but not sufficient | 2, 11, 12 | **High** (raised from Medium — Session 11 demonstrated real, large-scale impact; Session 12 confirmed it precisely and found a second blocker) | **Affiliation classification: built, tested, measured — code shipped this session (dry-run validated only, no production writes). Cost/scheduling: still Open, now the harder half of the blocker** | Affiliation: done, see "Session 12" below for the full implementation. Remaining: either (a) batch `efetch` in smaller chunks with per-chunk ceiling checks instead of one big per-person call, (b) tighten the wall-clock ceiling to also bound in-flight-person time, not just "starting a new person," or (c) profile *why* this run's real per-person cost was 8.6x the calibration estimate (silent retries under sustained load is the leading hypothesis — no exhausted-retry errors appeared in the log besides one, which is consistent with retries succeeding late rather than failing outright, but this needs its own investigation before trusting any fix) |
| 3 | `ingest-pubmed-orcid` has never completed a scheduled run: 202/229 faculty never reached, 40/47 ORCID holders never checked — 13 consecutive CI timeouts at the 30-minute mark, every run restarting from roster position 1 with no resume state | 2 | **High** | **Fixed** (Session 10) | Two independent settings-backed cursors (`orcid_sweep_cursor`, `pubmed_sweep_cursor`), wp_id-keyed, position re-derived from the current roster every run; a ~25-minute wall-clock ceiling that stops starting new faculty and writes the cursor cleanly; `pubmed_sweep_cycle_completed_at` recorded + logged on a genuine full-roster cycle. See "Session 10 — the sweep fix" below for the diagnosis, the load-bearing `applyCandidate` cache fix, and measured before/after |
| 4 | No disposal path for rejected/duplicate publications — `possible_duplicates` has a read side (flagging) but no write side (resolving); a reject action would additionally need to resolve the pair atomically to avoid the mutual-hold "deadlock" `getUnresolvedDuplicatePublicationIds` enforces by design | 2 | Medium | Open | Build the resolve/reject action; must clear both `possible_duplicates` rows in the same transaction the disposal itself commits in |
| 5 | Ingester concurrency: two overlapping runs of the same job race on a shared read-then-write with no lock. A title-only (no-DOI) candidate produces silent duplicate rows; a DOI-bearing collision is caught by the `UNIQUE` constraint but throws **uncaught**, aborting the *entire remaining sweep* for every other candidate in that run — not just the colliding one | 3 | **High** | Open | `concurrency: { group: <job-name>, cancel-in-progress: false }` on each ingest workflow (already used by `ingest-crossref.yml`'s own job — just not consistently as a deliberate cross-run-race defense); worth pairing with a per-candidate try/catch so one collision doesn't drop unrelated candidates in the same run |
| 6 | Multi-candidate Crossref resolution: when two non-preprint candidates are otherwise equally plausible (both or neither UCF-affiliated), the winner is decided by raw, unrecorded Crossref relevance order — confirmed position-sensitive (swapping input order flips the answer) | 3 | Medium | Open | At minimum, log which case this hit (candidate count + which one won) so a wrong pick is diagnosable after the fact — a counter/log line, not a resolution-order change |
| 7 | `chps_faculty` role can be tagged onto a co-author name with zero roster cross-check and no flag of any kind — `setCoAuthorRole` trusts the reviewing faculty member's say-so entirely | 5 | Low | Open | Optional: a soft, non-blocking flag (not a rejection — §8b's whole design principle is trusting the faculty member as "the only person who knows") when the tagged name doesn't fuzzy-match anyone on the roster |
| 8 | Role-overwrite: when two co-authoring faculty both hold valid tokens, the second to classify an already-classified co-author gets a **silent** no-op — no error, no explanation, the page just shows whatever the first faculty member set | 5 | Low | Open | Surface a message distinguishing "already classified by a colleague" from "saved" so the second reviewer isn't left wondering whether their click did anything |
| 9 | Stored XSS via a submission's `url` field: `formatCitation` interpolated `pub.url` into `href` with no escaping and no scheme check, reachable via the **unauthenticated** public portal, rendering as a live `javascript:` link or an attribute-breakout handler in COMMS's own authenticated Tab 1 review view | 7 | **Critical** (while open) | **Fixed** (Session 8) | `escapeHtml` now runs on `pub.url`; added an `http:`/`https:`/`mailto:` scheme allowlist enforced at both parse sites (`parsePortalSubmitFormData`, `parseApproveFormData`) and at render time in `formatCitation` (defense in depth) |
| 10 | `formatCitation`'s generated `<a>` tag carried no `rel="noopener noreferrer"` at all — not a live token-leak (the review page never called `formatCitation`), but the shared "citation is the product" (§15.6) formatter had the gap built in for any future reuse | 6 | Low (as found) | **Fixed** (Session 8, same line as #9) | Added `rel="noopener noreferrer"` alongside the URL-escaping fix |
| 11 | No rate limiting on the public submission route (`submitPortalPublicationAction`) — confirmed empirically, 50 rapid submissions all succeeded; no `middleware.ts` exists anywhere in the project | 7 | **High** | Open | A `settings`-backed counter mirroring `lib/admin-auth.ts`'s existing login-lockout mechanism exactly (same table, same `getSetting`/`setSetting` shape, same serverless-cold-start-safe reasoning already justified there) — lower-lift and more idiomatic than introducing `middleware.ts` as new infrastructure |
| 12 | No payload size limit on either unauthenticated-adjacent write path — a 1MB title and 1,000 author rows were both accepted verbatim on the public portal path; the review-page path (behind a token) has the identical gap | 5, 7 | Medium | Open | A simple length cap (e.g. title/note ≤ a few KB, author rows ≤ a few dozen) at the same two parse sites the URL allowlist now lives in |
| 13 | `faculty_id`/`status`/`reviewed_by`/`reviewed_at`/`roundup_id` forgery protection is structural (these fields are simply never parsed from the submitted form), not validated-and-rejected — safe today, but nothing would catch a future refactor that started reading one of them | 5, 7 | Low | Accepted, documented | None proposed; flagging that this is a good candidate for a short drift-guard test (in the Session 5 style) if this parsing code is ever touched again |
| 14 | Review tokens survive `finalizeRoundup` by design and live their full TTL — finalize gates *writes* via `isPublicationFinalized`, never revokes the token itself (confirmed against `lib/roundup-finalize.ts` directly: zero references to `review_requests` or "token" anywhere in that file) | 4, 8 | — | Accepted, documented | None — this is master plan §8b's own Session 19 correction, re-confirmed against running code |
| 15 | Token expiry boundary is `expires_at < now` — the exact `expires_at` instant itself is still valid, only one millisecond past it is rejected | 4 | — | Accepted, documented | None — worth keeping in mind if `REVIEW_TOKEN_TTL_DAYS` semantics are ever discussed as "exactly N days" |
| 16 | Response uniformity: nonexistent, expired, and revoked tokens all produce the identical generic "This link is no longer valid" — kindest-to-nobody by design (leaks the least, but a professor with a genuinely expired bookmark gets no more help than a stranger guessing tokens) | 4 | — | Accepted, documented | None — explicit trade-off already made; revisit only if support-burden data ever suggests otherwise |
| 17 | `opened_at` cannot distinguish an Outlook Safe Links prefetch (arrives seconds after send) from genuine human engagement (arrives whenever) — same column, same shape, no differentiating field | 4 | Low | Open | A sub-minute-delta heuristic on the campaign status view, flagging likely-scanner opens rather than treating every `opened_at` as engagement |
| 18 | RTL override / zero-width / homoglyph characters in a submitter's name are stored and rendered verbatim — no structural HTML corruption (confirmed), but no defense against visual spoofing in COMMS's own Tab 1 either | 7 | Low | Open | Strip or visibly flag bidi-control and zero-width characters in `submittedBy`/author-name fields at parse time |
| 19 | The admin login lockout (`lib/admin-auth.ts`) is a single shared counter, not per-IP — a handful of wrong guesses from *anyone* locks the login out for *everyone* during the window. Already self-documented as a known limitation before Phase 5; re-flagged here because the portal going public (§8a) changes the calculus — a stranger can now trigger this against COMMS incidentally or deliberately | 0 | Medium | Open | Move to a per-IP counter (keyed in `settings` by a hashed IP, same table/shape) if this becomes a real nuisance; not urgent absent evidence of it happening |
| 20 | `lib/wordpress.ts` (used by `sync-roster`) makes raw `fetch()` calls with **no retry/backoff wrapper of any kind** — not even a duplicated one, unlike `lib/ai.ts` below | 0 | Low | Open | Route through `lib/http.ts::fetchWithRetry` like every other network call in the codebase |
| 21 | `lib/ai.ts` has its own separate, duplicated retry/backoff implementation — never calls the shared `fetchWithRetry`, a second copy of the same logic that can silently drift from it | 0 | Low | Open | Replace the duplicated loop with `fetchWithRetry` |
| 22 | `lib/db.ts::query()` — the one exported helper whose contract is "return an array of plain records," and the natural place a shared `toPlain()`/RSC-safety helper would live — is **completely unused** anywhere in the app (confirmed by grep: the only import of anything but `client` from `lib/db.ts` across the whole codebase is `lib/ai.ts`'s `execute`). Every real caller either goes through `lib/publications.ts::queryPublications` or imports the raw `client` and handles `.rows` itself, ad hoc, per call site — which is exactly the uncontrolled pattern the `getCampaignStatus`/`notYetOpened` incident came from | 9 (this session) | Medium | Open | Not a bug in `query()` itself (verified: its output already satisfies both the plain-object and real-array checks, against the real schema, with `NULL` columns) — the gap is that nothing routes through it. See "RSC guard" section below for the proposed `toPlain()` helper |

## Also verified clean (not findings — listed for completeness)

Sessions 4–7 confirmed a number of properties held with no gap found — worth
recording so this document is a complete audit trail, not just a list of
problems:
- Token hashing at rest, entropy (CSPRNG, ≥128 bits), and the slug-is-never-
  a-credential guarantee (Session 4, 5) — all confirmed against real code,
  no gap.
- The full review-token attack matrix (no/expired/revoked/tampered tokens,
  cross-faculty IDs, already-finalized publications, out-of-enum roles) —
  every attack rejected server-side with a snapshot-confirmed absence of any
  write (Session 5).
- `<meta name="referrer" content="no-referrer">`, `rel="noopener noreferrer"`
  on the review page's own hand-written anchor, zero third-party requests,
  zero token leakage into logs/errors/redirects, and correct escaping of
  `<script>`-bearing co-author names and titles on the review page itself
  (Session 6) — the one gap Session 6 *did* find (finding #10 above) was in
  `formatCitation`, not the review page.
- The public portal never writes to `publications`/`publication_authors`
  directly (snapshot-confirmed), and the four-outcome duplicate handler is
  correctly scoped to the submitting token's own faculty even when a
  `facultyId` field is injected into the payload (Session 5, 7).

## Where I'd rank this differently than the given ordering

- **#3 (PubMed/ORCID sweep never completing) is the single worst *currently
  live* problem in this list**, ahead of every open security finding. It's
  not a hypothetical or an attack — it's a real, ongoing failure: 88% of
  ORCID-holding faculty have never once been checked, right now, today. The
  security findings (#7, #8, #11, #12) all require either an attacker to act
  or a legitimate credential to already exist; #3 is actively failing with
  zero adversary involved. I'd put it first, not third.
- **#5 (ingester concurrency) is worse than its "duplicate rows" framing
  suggests** because of its *other* half: an uncaught `SQLITE_CONSTRAINT_UNIQUE`
  on a DOI collision doesn't just fail one candidate, it silently drops
  *every remaining candidate in that run* for unrelated faculty — meaning
  this finding actively compounds #3's coverage gap rather than being
  independent of it. I'd escalate it to High primarily for that reason, not
  the duplicate-rows half.
- **#11 (no rate limiting) and #12 (no payload size limit) compound each
  other** on the unauthenticated portal path specifically — no throttle
  *and* no size cap together is a trivial, high-impact DoS against COMMS's
  review queue today, not two independent minor gaps. I'd keep #11 at High
  but want it read alongside #12, not in isolation.
- **#7 and #8 (chps_faculty mislabeling, silent role-overwrite) I'd keep at
  Low, not Medium** — both require an already-legitimate, currently-reviewing
  faculty token to reach at all, the blast radius is one paper's author list,
  the action is reversible, and #7 in particular is arguably *consistent*
  with §8b's own design principle of trusting the faculty member as "the
  only person who knows" rather than a gap in it. I'd resist over-weighting
  these relative to #3/#5/#11.
- **#13 (structural-not-validated forgery protection) — I'd keep this
  "accepted" but flag it as the most fragile of the accepted-and-documented
  items**, specifically because "accepted" here rests on a fact (these
  fields are never parsed) that a future, unrelated refactor could silently
  invalidate with no test to catch it — unlike #14–16, which are genuine,
  stable design decisions. A cheap regression test (assert the parsed-form
  object never has a `faculty_id`/`status`/etc. key, mirroring this
  session's `first_seen_at` guard) would convert this from "hope nobody
  changes it" to "would fail loudly if someone did," at low cost.
- **#22 (the unused `lib/db.ts::query()` helper) is new this session** and
  I'd rank it Medium specifically because it's the *root cause* enabling
  the recurring "raw Row object crosses the RSC boundary" bug class this
  whole pack keeps citing (`getCampaignStatus`) — not because `query()`
  itself is broken (it isn't; see below), but because nothing routes
  through the one place that shared safety could live.

## Guards added this session (Session 9)

Not findings — structural infrastructure now in place, referenced from the
table above:

- **`.github/workflows/test.yml`** — typecheck + full suite on every push
  and PR, no secrets, no DB credentials. Verified before adding it: the full
  suite (1,017 tests as of this session) passes with `TURSO_DATABASE_URL`
  and `TURSO_AUTH_TOKEN` both unset — Session 1's network guard and every
  test's own temp-file/local-URL database setup make this safe by
  construction, confirmed empirically rather than assumed. (Also fixed, in
  the course of wiring this up: two test files used a regex `/s` flag that
  `tsc --noEmit` rejects at this project's target — a one-line, test-file-only
  fix in each, unrelated to any finding above.)
- **`tests/rsc-plain-objects.test.ts`** — permanent regression guard:
  `lib/db.ts`'s exported `query()`/`execute()` helpers return real `Array`s
  of `Object.prototype`-rooted rows, checked against the real migrated
  schema (`faculty`, `publications`, `publication_authors`, including a
  `NULL` column) rather than a toy table. Currently green — not because the
  bug class is gone, but because (per finding #22) nothing routes through
  these helpers to trip it.

  **Proposed `toPlain()` helper** (not implemented — this is a proposal
  only, and `lib/db.ts` is out of scope for this session):
  ```ts
  // lib/db.ts — proposed, not implemented
  export function toPlain<T extends Record<string, unknown>>(row: T): T {
    return { ...row };
  }
  export function toPlainRows<T extends Record<string, unknown>>(rows: T[]): T[] {
    return rows.map(toPlain);
  }
  ```
  The value isn't for `query()` itself (already safe, per the guard above) —
  it's for the ~16 files that import the raw `client` and read `.execute(...).rows`
  directly, each currently responsible for remembering its own
  `.map((r) => ({...r}))` (or not, as `getCampaignStatus` didn't, until it
  broke production). A single, tested, named helper gives every future RSC-
  crossing call site one obvious thing to reach for instead of re-deriving
  the spread pattern per call site — worth a follow-up session to add the
  export and update call sites deliberately, not as a side effect of this one.
- **`tests/first-seen-at-guard.test.ts`** — permanent source-level guard:
  every `.ts` file in `scripts/` and `lib/` scanned for `first_seen_at\s*=`
  (an UPDATE assignment; INSERT column lists never match, since they carry
  no `=`), failing on any occurrence that isn't wrapped in
  `COALESCE(?, first_seen_at)` (the self-preserving pattern all three
  ingestion jobs already use safely) outside the one sanctioned file,
  `lib/needs-metadata.ts`. Self-verified: a hand-built bare assignment is
  flagged, a `COALESCE`-wrapped one is not, and the sanctioned file is
  asserted to still actually contain its exception (not just be allow-listed
  by name). 64 files scanned, currently 0 violations.

## Session 10 — the sweep fix (production code change, scoped and authorized)

This is the one session in this pack authorized to change production code,
narrowly: finding #3 above, and nothing else. Scope, per direct
instruction: resumability and per-faculty budget in
`scripts/ingest-pubmed-orcid.ts` only. Explicitly not touched: efetch/
affiliation capture, the ingester concurrency race (#5), the disposal path
(#4), scheduler restoration, and the identical `existingList`-per-candidate
reload pattern in `ingest-crossref.ts`/`ingest-scholar.ts` (see follow-ups
below).

**Diagnosis, measured before designing anything:** 229 active faculty, 47
with ORCID. Real production round-trip latency for the `existingList`-shaped
query: 65–190ms (5 live samples). ORCID+Crossref cost for all 47 real
holders, measured end to end: ~40s total — not the bottleneck, despite
being the "expensive-looking" half. The actual dominant, previously
invisible cost: `applyCandidate` reloaded the entire `publications` table
(5,797 rows and growing) from scratch on *every single candidate*,
unconditionally. `eutils.ncbi.nlm.nih.gov` was unreachable from this
session's sandbox (DNS resolves, `curl`/`fetch` fail instantly) — PubMed's
own network cost is reasoned from code (rate-limit floor ≈152s for 229×2
calls) rather than measured live; disclosed here rather than assumed.

**Fix, as approved:** independent `orcid_sweep_cursor` / `pubmed_sweep_cursor`
settings keys, wp_id-keyed, position re-derived from the current roster each
run (a stale cursor falls back to the start, same branch as no cursor — not
a special case). The cursor advances unconditionally after each person's
attempt, success or caught error alike, which is what makes "skipped
forward, not retried indefinitely" true structurally. ORCID runs to
completion for all 47 holders every invocation, independent of PubMed's
cursor position. A per-sweep `ExistingListCache` (lifetime: one faculty
member's one sweep) replaces the per-candidate reload — this is the
load-bearing change. A ~25-minute wall-clock ceiling stops *starting* new
faculty (no per-person cutoff) and writes the cursor cleanly on the way out.
`pubmed_sweep_cycle_completed_at` + a log line record when a full PubMed
cycle genuinely wraps.

**Measured before/after** (requested explicitly, not inferred from a green
suite): 100 synthetic PubMed candidates for one faculty member, local
SQLite — `existingList` queries: old code 100 (by construction — one per
candidate), new code measured at exactly 1. Local elapsed for the whole
sweep: 222ms. Extrapolated to production's measured 65–190ms/query
latency: old ≈ 7–19s spent on this one redundant query alone across 100
candidates, vs. new ≈ 65–190ms total (one query). Confirms the diagnosis:
the cache, not the cursor, is the dominant throughput win — the cursor
fixes *never finishing*, the cache fixes *how slowly it doesn't finish*.

**Tests:** `tests/idempotency/ingest-pubmed-orcid-resume.test.ts` (new, 10
tests) — a wall-clock-ceiling stop resumes from the cursor, never position
1; repeated ceiling-limited invocations eventually reach all 229 and record
completion; a persistently-failing faculty member is skipped forward, not
retried indefinitely; a genuinely unexpected (non-network) error is caught
by an outer safety net and the cursor still advances past them; ORCID
completes in one invocation regardless of where PubMed's own cursor is
stalled; the cache returns identical results to the uncached path,
including for a candidate inserted earlier in the same sweep; the shared
`assertReRunInvariants` (`tests/helpers/invariants.ts`) holds across a
genuinely resumed run. All 13 pre-existing `--faculty`-scoped tests in
`tests/ingest-pubmed-orcid.test.ts` pass unchanged (that path bypasses the
cursor entirely by design). Full suite: 1,027 passing (1,017 pre-existing +
10 new), `tsc --noEmit` clean, `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`
unset. The job was not run against production this session — all
production access was read-only, via a throwaway gitignored script, used
only for the diagnosis numbers above.

**Follow-ups logged, not fixed this session** (per explicit scope
instruction):

- **efetch/affiliation capture** for `ingest-pubmed-orcid` — separate
  session.
- **Ingester concurrency race (#5)** — separate mechanism (redundant reads,
  not concurrent writers), separate session.
- **Disposal path (#4)** — separate session.
- **Scheduler restoration** — separate session, and must land **with or after** the ingester concurrency fix (#5), not before. This job now writes cursor state (`orcid_sweep_cursor`, `pubmed_sweep_cursor`) as it goes, unconditionally, per person. Two overlapping scheduled runs racing that cursor don't just risk #5's duplicate-row/aborted-sweep failure mode — they can **rewind each other**: run B reads a cursor position run A already advanced past, resweeps ground A already covered, and depending on interleaving can write a cursor value *behind* where A left off, silently discarding progress. That's worse than the insert race Session 3 found (which fails loudly on a DOI collision, or duplicates a single row) — a cursor rewind fails silently and looks like normal operation. No scheduler restored this session, deliberately.
- **`ingest-crossref.ts` and `ingest-scholar.ts` have the identical
  `existingList`-per-candidate reload anti-pattern** this session fixed in
  `ingest-pubmed-orcid.ts`, confirmed via grep to be separate, independent
  copies of `applyCandidate` (not shared code, so this session's fix has
  zero effect on either). Same fix — a per-sweep `ExistingListCache` — would
  apply directly; worth a follow-up session once either script's own
  throughput becomes the bottleneck it already is here.

## Session 11 — production verification (dry run only; no writes)

Supervised manual invocation against real production data and the real
PubMed/ORCID/Crossref network, to confirm the Session 10 rewrite works
against real latency and real data volume before ever running it for real.
Scope: verification only, no code changes, no scheduler restoration.

**Dry run (`--dry-run`, zero writes): the resumability fix is confirmed.**
Ran to a full, natural cycle completion in **~23 minutes** — inside the
25-minute wall-clock ceiling, no ceiling stop needed. Both cursors wrapped
(`orcidCycleCompleted`, `pubmedCycleCompleted` both true). This clears
roster position 27 — the point no run has ever reached in this job's
history — by a wide margin on the very first attempt post-fix.

- 47/47 ORCID holders processed independently of PubMed's own progress, as
  designed: 309 ORCID works fetched, 308 resolved via DOI, 0 via title
  fallback, 1 landed as `needs_metadata`.
- 229/229 active faculty processed via PubMed: 32,287 PubMed records
  fetched, 226 queried via `full_name`, 3 via the sparser `display_name`
  fallback.
- 4,347 candidates matched into existing records; 28,088 predicted as new
  (see finding #2's rewrite above for why this number is largely noise, not
  a legitimate backlog, and should not be read as "28,088 real UCF papers
  we've been missing").
- 3 errors this run, all on PubMed, all skipped forward cleanly with the
  cursor still advancing past each: Jung, K. (`fetch failed`), Ferretti, C.
  and Schwitters, R. (esummary exhausted retries). Zero aborts, zero stuck
  cursors — the outer safety net worked exactly as designed under real
  failures, not just the synthetic ones in the test suite.

**Correction to the Session 10 diagnosis:** `NCBI_API_KEY` is set in this
project's production environment, which raises the PubMed rate-limit floor
from 3 req/s to **10 req/s** (`lib/pubmed.ts`'s `rateLimit()`). The Session
10 diagnosis's ≈152s rate-limit-floor estimate assumed the unauthenticated
3 req/s ceiling, since `eutils.ncbi.nlm.nih.gov` was unreachable from that
session's sandbox and the number had to be reasoned from code rather than
measured live. The real floor is roughly 3x faster than that estimate — a
meaningful, and directionally conservative, contributor to why the real
run finished a full cycle in ~23 minutes rather than needing multiple
ceiling-limited invocations to converge.

**Why no real (write) invocation happened this session:** the dry run's
28,088-new-row prediction, cross-referenced against which faculty triggered
PubMed's `retmax=250` cap (89 of 229 — see finding #2), showed the affiliation-
filter gap and the sweep-completion fix compounding each other: the fix
makes the job capable of reaching every faculty member's full PubMed result
set for the first time ever, including the common-surname cases that were
always over-broad but never previously got far enough to matter. Writing
that for real, with no bulk disposal path (#4) to clean up whatever fraction
is noise, was judged not worth doing blind. Full reasoning and the decision
to stop here rather than proceed is captured in finding #2's rewrite above.

**A counting caveat, for whoever reads the 28,088 number later:**
`ExistingListCache.upsert()` only runs on a real (non-dry-run) write
(`scripts/ingest-pubmed-orcid.ts`, `applyCandidate`/`applyOrcidNeedsMetadata`).
In dry-run mode, a candidate that would be a genuine new insert on its first
sighting within the sweep, but reappears later in the *same* sweep (the same
paper via two co-authoring faculty's PubMed searches, or via both ORCID and
PubMed for one person), is counted as "new" **again** on the second sighting,
because the cache never learned about the first would-be write. A real run's
cache would correctly dedupe that second sighting into a merge. The true
novel-insert count on a real run is therefore lower than 28,088 by an amount
that cannot be determined without actually writing — this is a structural
property of comparing a dry run against a cache whose entire purpose is to
reflect real writes, not a bug in the dry run itself.

**Second real invocation (resume confirmation) and the invariants check
were not run this session** — both depend on a first real invocation having
happened, which didn't. Deferred to whatever session closes finding #2.

**No scheduler was restored.** See the expanded follow-up note above (under
Session 10) on why scheduler restoration is now explicitly ordered behind
the concurrency fix (#5): this job's cursor-writing behavior turns
concurrent-run races into silent cursor rewinds, a worse failure mode than
Session 3's original finding.

**Recommendation for the next session on this job**, given everything
above: close finding #2 (affiliation plausibility check via `efetch`) before
ever running this job unscoped-and-for-real again. It's the one open item
that actually gates a safe production write — #4 (disposal path) matters
for cleanup-after-the-fact, but #2 is the one that determines how much
cleanup there'll be to do. Build the `efetch` affiliation check as a
plausibility signal (route a candidate to `needs_metadata` with a flag
rather than straight to `pending_merge` when no author's affiliation string
suggests UCF, rather than hard-excluding — preserving the original design's
correct instinct not to drop real papers with an unusual affiliation
string), verify it measurably shrinks the common-surname yield with a
before/after on the same 89-faculty set this session already identified,
*then* run the job for real. Build the disposal path (#4) either alongside
or immediately after, since even a well-tuned plausibility filter won't hit
zero false positives and COMMS will need a way to bulk-clear whatever
remains. Scheduler restoration and the concurrency fix (#5) stay a separate
track behind both of those — nothing about this session changes that
ordering.

## Session 12 — PubMed affiliation capture, measured live (no production writes)

Closes the affiliation half of finding #2. Scope, per direct instruction:
affiliation capture and measurement only. No disposal path, no scheduler
restoration, no concurrency fix. No production writes — dry run only, same
posture as Session 11.

**1. Recon, real captures before any parser was written.** Pulled raw,
untrimmed `efetch` XML (`rettype=abstract&retmode=xml`) for 6 real PMIDs —
3 real Norte, G. (CHPS faculty) papers and 3 from a live `Chen S[Author]`
esearch (the same global-collision surname used elsewhere) — plus 3
arbitrary 1970s PMIDs, saved as `tests/fixtures/api/pubmed-efetch-norte-
and-collision.xml` and `pubmed-efetch-old-no-affiliation.xml`. Confirmed
directly, not assumed: UCF affiliation text present and matching; UCF
affiliation present but on author 4 of 6, not the first (Norte's own
co-authored paper — proves "check every author" isn't optional); clearly
non-UCF affiliation (Chinese institutions, the Chen S. collisions); a real
author with **two** `<AffiliationInfo>` blocks on one `<Author>`
(dual-institution authors, a real shape); and affiliation coded on **zero**
authors across all 3 old records (a genuine PubMed coverage gap, confirmed
live, not a parsing failure to guard against hypothetically).

**2. Cost measured before designing around it.** `efetch`'s own per-request
latency (batched by pmid list, same pattern as `esummary`) measured close
to `esummary`'s (0.9x–1.9x at matched batch sizes) despite a 6–11x larger
payload. Extrapolated added cost for `efetch`-ing every fetched record:
≈275s (4.6 min), which would have pushed the ~23-minute baseline cycle to
≈27.6 min, over the 25-minute ceiling. Design response: only `efetch`
candidates that survive the existing in-memory match check (i.e., ones
about to become a real `applyCandidate` insert decision, not a merge) —
semantically correct, since affiliation only matters for the insert
decision, and a real cost cut (merged candidates never fetch affiliation
at all).

One real bug caught by this measurement pass, not by inspection: `efetch`
needs `retmode=xml`, but the shared `eutilsParams()` helper hardcoded
`retmode=json` with no override — appending a second `retmode=` to the URL
string doesn't override it, it produces a live NCBI **500** (confirmed via
direct `curl`, not assumed). Fixed by giving `eutilsParams()` a real
parameter (`"json" | "xml"`) instead of a hardcoded default.

**3. Implemented as a plausibility signal, never a hard exclusion.**
`classifyAffiliationPlausibility` (`lib/matching.ts`, next to the existing
`isUcfAffiliation`) returns `"confirmed"` (any author's affiliation
matches UCF), `"not_ucf"` (affiliation data exists, none of it matches —
a real signal, not an absence of one), or `"ambiguous"` (no affiliation
data retrievable at all — genuinely unknown, not evidence either way).
Every PubMed candidate still reaches `applyCandidate` regardless of
bucket — nothing is filtered out of the pipeline; the classification is
purely informational this session (see the write-routing note below for
why).

**Write-routing, and why nothing changed there this session.** The
obvious next step — route `not_ucf`/`ambiguous` candidates to a different
`publications.status` for human review — was considered and rejected for
now: reusing the existing `needs_metadata` status looked like the natural
fit (it already has a full review UI, `app/admin/needs-metadata/`), but
`lib/matching.ts::promoteFromNeedsMetadata` auto-promotes any
`needs_metadata` row to `pending_merge` the instant a merge attaches a
non-null DOI — and these PubMed candidates almost always already have a
real DOI. That would silently defeat the review gate on the very next
sighting of the same paper, a worse bug than the one being fixed. A
correct "flagged" state needs either a new `PublicationStatus` value or a
new column — schema work with no review UI to pair it with, which is
disposal-path-adjacent scope this session explicitly excluded. Every
candidate this session still inserts as `pending_merge`, exactly as
before; the three-bucket counts are real, measured, and exposed in
`RunSummary` and the run's own log line, but don't yet gate anything
written to the database. Flagged as a real gap, not silently decided.

**4. Measured live against production — the number that matters most.**
Ran with the identical `--dry-run` posture as Session 11. The sweep hit
its wall-clock ceiling at **87 of 229 faculty** (see the timing finding
below for why). Of those 87:

```
47 faculty with ORCID processed · 309 ORCID work(s) fetched
87 faculty processed via PubMed · 10,747 PubMed record(s) fetched
3,111 merged into existing records · 7,695 new candidates
New PubMed candidates by affiliation plausibility:
  302 confirmed UCF (3.9%) · 6,987 plausibly not UCF (90.8%) · 406 ambiguous (5.3%)
```

Broken out for the 22 (of the original 89) common-surname/`retmax=250`
faculty who fell within this run's 87-person prefix: 4,449 of the 7,695
new candidates (58%) came from just these 22 people, and of those, **97.0%
are `not_ucf`** (37 confirmed, 4,314 not_ucf, 98 ambiguous) — the extreme
case behaves exactly as hypothesized.

The more important number is the other 65 faculty, who never triggered
the `retmax=250` warning at all: 3,246 new candidates, and **82.3% still
`not_ucf`** (265 confirmed, 2,673 not_ucf, 308 ambiguous). The noise
problem is not confined to the flagged common-surname group — it's
pervasive across ordinary-surname faculty too, just less extreme in
per-person volume. Real, observed cases from this run: Formby, C. and
Chaput, M. both show a handful of recent `confirmed` UCF papers alongside
many older `not_ucf` results — very likely their own genuine work from
earlier in their careers at a different institution, exactly the
"visiting scholar/prior job" scenario the no-hard-exclusion design exists
to protect, still correctly reaching the pipeline rather than being
dropped.

**Before/after, against the 28,088 baseline**: Session 11's naive dry run
(no affiliation awareness) predicted 28,088 new rows for the full,
unscoped 229-person roster. This run's affiliation-aware sample, extrapolated
at the same ~3.9% confirmed rate across a full cycle, suggests the
genuinely-relevant count is on the order of hundreds to low thousands, not
tens of thousands — an order-of-magnitude reduction. This is an
extrapolation from a partial (87/229) sample, not a full-roster
measurement — a real full-cycle number requires resolving the timing
problem below first.

**A second, newly-discovered blocker — timing, not affiliation.** This
run's real wall-clock cost badly exceeded the pre-implementation
extrapolation: 74 minutes 56 seconds to reach 87/229 faculty, vs. Session
11's baseline of ~23 minutes for the full 229. That's **51.7s/faculty
member measured, against roughly 6s/faculty member predicted from the
cost calibration — an 8.6x gap**, not the ~2x the calibration's own
worst-case extrapolation anticipated. The wall-clock ceiling did exactly
what it was built to do (stopped starting new faculty, wrote the cursor
cleanly, no crash) — but it only ever bounded *starting new people*, never
total elapsed time, and this run demonstrates that gap is not
theoretical: at this real per-person cost, the job would very likely
exceed even the original 30-minute CI `timeout-minutes` that finding #3
was built to survive, reintroducing that exact failure mode. One real
error surfaced during the run (`Buchanan, C., wp_id 1284: unexpected
error: terminated`, a genuine transient network failure, not a code bug —
the cursor advanced past it cleanly, exactly as designed), but that alone
doesn't explain an 8.6x slowdown; no other exhausted-retry errors appear
in the log, which is consistent with (not proof of) many individual
requests silently retrying and eventually succeeding under sustained load
rather than failing outright — NCBI behaving differently under an hour of
sustained traffic than under this session's short, paced calibration
bursts. Root cause not confirmed this session; flagged honestly as
unresolved rather than guessed at.

**Tests**: `tests/pubmed.test.ts` — `extractAffiliationsFromXml` against
the real fixtures (present/matching, present-on-non-first-author-only,
present/non-matching, absent-on-every-author, multiple `AffiliationInfo`
blocks per author, entity decoding, malformed XML never throws, a
`PubmedArticle` missing `<PMID>` is skipped not mis-keyed) and
`getPubmedAffiliations`'s network layer (batches into one call, the
`retmode=xml` regression guard, empty input short-circuits, network
failure wraps in `PubmedUnavailableError`). `tests/matching.test.ts` —
`classifyAffiliationPlausibility`'s three buckets. Three pre-existing test
files (`tests/idempotency/mid-run-resume.test.ts`,
`tests/ingest-pubmed-orcid.test.ts`,
`tests/idempotency/ingest-pubmed-orcid-resume.test.ts`) needed their
hand-rolled fetch mocks extended to route `efetch.fcgi` — the two that
actually exercised a genuinely-new (non-merge) PubMed candidate were
timing out for real (an unmocked `efetch` call fell through to each
mock's `throw new Error("unrouted: ...")`, which `fetchWithRetry` then
retried with real, un-faked exponential backoff) — fixed by routing
`efetch.fcgi` to a valid empty-affiliation response, confirmed by the
throughput-measurement test dropping from a multi-second real delay to
452ms. Full suite: 1,044 passing (1,027 prior + 17 new), `tsc --noEmit`
clean, `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` unset.

**Scope discipline, explicitly**: no scheduler restored, no concurrency
fix, no disposal path, no production writes. The one production access
this session made beyond the dry run itself was read-only recon (a handful
of real `esearch`/`efetch` calls to capture fixtures and calibrate
latency) — no database writes, confirmed.

**Recommendation for the next session on this job**: the timing finding
above, not the disposal path, is now the harder blocker. Affiliation
classification is done and measured; a real write is still unsafe, but
now for a different reason than before — not "too much noise" (that's
solved), but "the job may not finish inside any CI-safe timeout with
`efetch` enabled." Investigate the 8.6x gap before trusting any fix to it
— batching `efetch` into smaller per-chunk requests with their own ceiling
checks is the most promising lever (mirrors the existing `existingList`
cache's own "make the expensive thing amortize" instinct from Session
10), but shouldn't be built until the retry-under-sustained-load
hypothesis is confirmed or ruled out, since a wrong theory here risks
"fixing" a symptom instead of the cause.

## Session 13 — diagnosing the 8.6x slowdown (no fix implemented)

Scope, per direct instruction: diagnose only. No parallelization, no
caching, no concurrency, no batching restructure. Report the cause,
measured, and stop.

**The leading hypothesis (NCBI rate limiting) was tested first, as asked,
and is ruled out.** Verified `NCBI_API_KEY` is configured in `.env.local`
and actually sent (`api_key` param confirmed in the outgoing URL). Verified
NCBI's current documented limits directly against their own docs
(`eutilities.github.io/site/API_Key/usageandkey`, not training data or the
prior session's framing): 3 req/s without a key, 10 req/s with one,
429 on excess. Added real, keepable instrumentation (`lib/http.ts`'s new
`onAttempt` hook on `fetchWithRetry`, wired through `lib/pubmed.ts`'s three
network calls) that separates, per request: status code, attempt count,
time spent in our own rate-limiter's self-throttle, time spent in
backoff-after-a-retryable-response, and each attempt's own genuine
duration — the exact seam needed to tell "succeeded first try" apart from
"succeeded after a silent retry," which no prior session's summary output
could distinguish.

**Measured live against production**, a bounded 10-minute diagnostic run
(56 faculty, 168 individual PubMed requests — esearch+esummary+efetch):
**zero 429s. One timeout** (`Ziegler, A.`: esummary attempt 1 aborted at
the 15s per-attempt ceiling, `TypeError: This operation was aborted`,
retried, succeeded in the second attempt) — a real, rare (1/56 people),
genuine-latency event, not a rate-limit rejection, and not close to
explaining an 8.6x gap on its own. The computed aggregate request rate
this job generates (even fully loaded with `efetch`) is ~0.06 req/s —
nowhere near either the 3 or 10 req/s ceiling. Rate limiting is not the
cause.

**A second, unrelated but consequential discovery made while testing the
rate-limit hypothesis**: `.github/workflows/ingest-pubmed-orcid.yml`
references `secrets.NCBI_API_KEY`, `vars.NCBI_TOOL_NAME`, and
`vars.NCBI_EMAIL` — but `gh secret list` / `gh variable list` against the
real repo show **none of the three are actually configured**. Every real
scheduled run of this job has been running at the unauthenticated 3 req/s
tier, not the 10 req/s tier every prior session's measurements (including
this one) assumed and benefited from via a locally-configured
`.env.local` key that was never propagated to the actual GitHub secret.
This doesn't explain the 8.6x gap either (rate limiting is ruled out
regardless of key presence), but it means every session's "X minutes for
a full cycle" number was measured under materially better network
conditions than production has ever actually had. **This is a one-line
config fix** (add the `NCBI_API_KEY` secret and the two `vars` in the repo
settings) — flagging it and stopping for confirmation rather than adding
it myself, per this session's instructions.

**The actual cause: serial per-merge database round-trips, not PubMed at
all.** The same diagnostic run's per-person breakdown makes this
unambiguous. `applyCandidate`'s `MATCH` branch
(`scripts/ingest-pubmed-orcid.ts`) issues two `SELECT` queries against the
live production database for every candidate that merges into an existing
row — **unconditionally, even in `--dry-run`** (only the subsequent
`UPDATE`/`INSERT` writes are gated on `!dryRun`; the reads that decide
*whether* to write are not). Each query is a real network round trip at
production's own previously-measured latency (65–190ms, Session 10). Two
sequential, un-batched round trips per merge, done one candidate at a
time inside a `for` loop with no batching.

The data: of 56 people, the 6 highest-cost had `other` (this job's own
code, not NCBI) between 17.9s and 35.8s — and **four of the six had zero
new candidates at all** (every single one of their PubMed hits already
matched an existing row): `MacKay, A.` (35,790ms, 0 new), `Adams, A.`
(35,678ms, 0 new), `Pearson, D.` (35,191ms, 0 new), `Perez, K.` (34,811ms,
0 new), `Roman, O.` (18,053ms, 0 new), `Constantine, R.` (17,903ms, 0
new). Dividing each by ~150ms (the expected cost of one merge's two
sequential round trips) implies 232–239 merges for the four biggest — a
near-exact match for the `retmax=250` cap these are known common-surname
cases (confirmed via the same `[pubmed-query-too-broad]` log line
Sessions 11/12 already used to identify them). Pearson's-r between new-
candidate count and `other` time across all 56 people is **−0.29** —
*more* new candidates correlates with *less* "other" time, the opposite
of what an efetch-driven or insert-driven theory would predict, and
exactly what the merge-cost theory predicts (a new/insert candidate costs
nothing extra in dry-run mode; only a merge does). In total across the
56-person sample: **79.1% of all wall-clock time (412.8s of 521.8s) was
this "other" bucket** — PubMed's own network time (`fetch` + `backoff` +
`rateLimitWait` summed across esearch/esummary/efetch) was the remaining
~21%.

**This is not new to `efetch` or Session 12.** The two-`SELECT`-per-merge
pattern is old, unchanged code — present since before Session 10. Applying
the same ~150ms/merge estimate to Session 11's baseline (4,347 merges,
229 people, ~23 minutes / 1,380s total): merge cost alone accounts for
≈652s — **≈47% of that entire "successful" 23-minute run**, already,
before `efetch` ever entered the picture. `efetch` (Session 12) added a
real, measured, secondary cost on top of an already-large existing one; it
did not create the underlying problem, and fixing `efetch`'s own cost in
isolation (this diagnostic's original assignment) would not have been
sufficient — a finding this diagnosis surfaced by measuring, not by
assuming the brief's own framing was complete.

**Recommended fix, sized, not implemented.** Batch the `MATCH` branch's
two queries the same way `existingListCache` already batches the initial
candidate-matching read (Session 10's own "make the expensive thing
amortize" precedent, applied one step further): since every matching
`publication_id` is already known before the per-candidate loop starts
(from `existingListCache`'s in-memory index), the publication-row and
author-row fetches for *all* of a person's merges could be issued as one
or two `WHERE id IN (...)` queries up front, collapsing what's currently
`O(merges)` sequential round trips into a small constant number per
person regardless of merge count. This is a genuinely scoped change
(touches `applyCandidate`'s `MATCH` branch and its caller's loop shape,
not the cursor/ceiling/cache machinery Session 10 already built) —
estimated to cut the dominant cost by roughly the same order of magnitude
the `existingList` cache itself cut the original per-candidate reload
problem in Session 10, but not attempted this session per its own scope.

**Should the wall-clock ceiling also bound total elapsed time, not just
starting new faculty?** Yes, explicitly recommended. This diagnosis
demonstrates the gap is real and not theoretical: a single faculty member
already costs up to ~39 seconds of unavoidable, un-interruptible serial
work under today's code, with no way for the ceiling to intervene
mid-person. Even after the batching fix above, some worst-case person
will still exist; a soft per-person time budget (log a warning and
continue past whatever's left for that person, without abandoning
already-decided outcomes) would make the ceiling's stated guarantee ("this
job writes its cursor and exits cleanly within budget") actually hold in
the worst case, rather than being a best-effort approximation that this
session proved can already be violated 3x over on ordinary production
data.

**Instrumentation, kept**: `lib/http.ts`'s `onAttempt` hook (opt-in,
zero behavior change for every existing caller that doesn't pass it) and
`lib/pubmed.ts`'s `resetPubmedDiagnostics`/`getPubmedDiagnostics`/
`formatPubmedDiagnostics`, wired into `scripts/ingest-pubmed-orcid.ts`'s
`sweepPubmed` as a `[pubmed-timing]` log line per faculty member (reset
before, logged in a `finally` after, so it fires even when a person is
skipped). This is real production visibility this job will need regardless
of which fix lands next — not diagnostic-session scaffolding to be torn
out.

**Tests**: `tests/pubmed.test.ts` — `onAttempt`/diagnostics tests covering
a clean single-attempt success, a 429-then-200 retry (attempts=2,
requests=1, both status codes recorded, non-zero backoff), a
fully-exhausted network failure (tracked under an `error:` key, not
dropped), reset-isolation between two calls, and `formatPubmedDiagnostics`
only including call types actually used. Full suite: 1,050 passing (1,044
prior + 6 new), `tsc --noEmit` clean.

**Scope discipline, explicitly**: no parallelization, caching, concurrency,
or batching restructure implemented, as instructed — the recommended fix
above is sized and described, not built. No production writes; the
bounded diagnostic run was `--dry-run`, same posture as every prior
production-facing session. Write-routing for `not_ucf`/`ambiguous`
candidates remains unchanged (`pending_merge`, same as Session 12 left
it) — still blocked on the same schema-decision-plus-review-UI gap.
