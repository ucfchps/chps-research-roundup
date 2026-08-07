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
| 2 | PubMed structurally cannot capture author affiliation (`PubmedRecordAuthor` has no such field; confirmed 0/4,027 real yield), **and** `searchPubmedByAuthor` deliberately searches by author name only — no affiliation filtering anywhere in the PubMed candidate path. Session 11's dry run against production proved these are one problem, not two: for a common surname, the unfiltered global author-name search returns up to `retmax=250` records with no UCF connection at all, and nothing downstream re-filters them (PubMed candidates skip Crossref's `isUcfAffiliation` gate entirely — that gate only ever applied to Crossref candidates). Measured: 89 of 229 active faculty (39%) hit the `retmax=250` cap this run — surnames like Chen S. (104,584 total matches worldwide), Wang X. (257,622), Zhu Y. (68,329) — and the dry run predicted 28,088 new `pending_merge`/`needs_metadata` rows against a table that currently holds 5,797, with no bulk disposal path (#4) to clean up whatever fraction of that is noise | 2, 11 | **High** (raised from Medium — Session 11 demonstrated real, large-scale impact, not a theoretical gap) | **Open — now a hard blocker on running this job for real at full scale** | Capture affiliation via `efetch` (richer than `esummary`) and use it as a plausibility signal on PubMed candidates before insert — not a hard exclusion gate (the existing no-affiliation-filter choice was deliberate, to avoid dropping a real UCF paper carrying a visiting-scholar/prior-job affiliation string; the fix is narrowing the net, not closing it). **Ordering constraint: this must land before this job is ever run for-real at full unscoped scale, and a disposal path (#4) should exist before that write too, not after it.** The current 5,797-row `publications` table is the residue of a job that has never once passed roster position 27 — Session 10 made the job *able* to complete a cycle, and Session 11's dry run proved that completing a cycle without an affiliation filter multiplies noise rather than fixing the coverage gap it was built to close |
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
