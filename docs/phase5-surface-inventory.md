# Phase 5 surface inventory — Session 0 recon

Read-only recon, no code or tests changed. Master plan sections read in full
first: §6 (schema), §8a/§8b/§8c (security models), §9 (scheduled jobs), §13
Phase 5. Every claim below was checked against real files/schema/production,
not inferred from the plan — the plan is what's being audited here, not
trusted as ground truth.

---

## 1. Schema drift table — three-way diff

**Method:** `sqlite_master` (`type IN ('table','index')`) queried directly
against (a) the scratch DB with every migration in `db/migrations/` applied
fresh, and (b) production (`TURSO_DATABASE_URL`), both read-only SELECTs
only. Diffed programmatically, object by object, exact `sql` text.

### Headline finding: migrations vs. production — zero drift

**Every table and index's `CREATE` SQL is byte-identical between the
freshly-migrated scratch DB and production.** No by-hand production change
exists anywhere in the schema. A fresh deploy from `db/migrations/` today
would produce the exact database currently running. This is the comparison
the task called "the one that matters most and is easiest to miss" — checked
explicitly, and it's clean.

### Plan vs. shipped (migrations/production — identical to each other, so one column covers both)

| Object | In plan §6 | In migrations/production | Note |
|---|---|---|---|
| `faculty` | ✅ | ✅ | Matches column-for-column. |
| `publications` | ✅ (12 cols) | ✅ but **14 cols** | Two real, actively-used columns exist in migrations/production with **no mention anywhere in the plan's §6 DDL block**: `discovered_by_faculty_id INTEGER REFERENCES faculty(id)` and `scholar_alert_url TEXT`. Both are written by `scripts/ingest-scholar.ts` and read by the review campaign/status code. Not a hidden or accidental column — just undocumented in §6. |
| `publication_authors` | ✅ | ✅ | Matches. |
| `pending_submissions` | ✅ | ✅ | Matches. |
| `review_requests` | ✅ | ✅ | Matches. |
| `roundups` | ✅ | ✅ | Matches. |
| `usage_log` | ✅ | ✅ | Matches. |
| `metadata_mismatches` | ✅ | ✅ | Matches on columns; column **order** differs — plan shows `stored_issue`/`crossref_issue` between the volume and pages pairs, migrations show them appended after `detected_at` (migration `004_metadata_mismatches_issue.sql` added them later via `ALTER TABLE ... ADD COLUMN`, which SQLite always appends). Cosmetic, not a real gap — flagging since the plan's DDL block reads as one coherent `CREATE TABLE`, not "as amended." |
| `possible_duplicates` | ✅ | ✅ | Matches. (Note: the task prompt's own framing text guessed this table might be undocumented — checked, it isn't; it's fully in the plan's §6 DDL, correcting that assumption rather than accepting it.) |
| `citation_edits` | ✅ | ✅ table, index not mentioned | `idx_citation_edits_publication ON citation_edits(publication_id)` exists in migrations/production; the plan's DDL block for this table has no `CREATE INDEX` line at all. |
| `settings` | **Prose only, §8c Tab 3 — no DDL** | ✅ | The real drift: `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)` is fully described in prose (§8c Tab 3, the email kill-switch paragraph) but has no `CREATE TABLE` block in §6 at all — the one table genuinely invisible to anyone reading §6 alone. |
| `_migrations` | not mentioned | ✅ | Infrastructure (migration-runner bookkeeping), not part of the app's data model — expected, not a gap. |

**No table, column, or index exists in the plan that is absent from migrations/production.** All drift runs one direction: shipped-but-undocumented, never planned-but-unshipped.

---

## 2. Write-path inventory

No `app/api/**` or `route.ts` handlers exist anywhere in this codebase — confirmed by search, zero results. Every write happens through a Next.js Server Action (`"use server"`) or a `scripts/**` CLI/cron entry point.

### Server Actions (9 files, real `"use server"` directive confirmed at each file's top — several `*-shared.ts` files matched a grep for the string but only in comments explaining the split; excluded)

| File : function | Writes | Auth |
|---|---|---|
| `app/portal-actions.ts` : `submitPortalPublicationAction` | `pending_submissions` (via `lib/portal.ts::submitPublication`) | **none** |
| `app/admin/login/actions.ts` : `loginAction` | `settings` (`admin_login_attempts` lockout counter, via `lib/admin-auth.ts`) | none to call it (it *is* the gate) — rate-limited by a shared lockout counter, not per-IP |
| `app/admin/actions.ts` : `logoutAction` | none (clears cookie only) | admin_session |
| `app/admin/pending-submissions/submission-actions.ts` : `approveSubmissionAction` | `publications`, `publication_authors`, `pending_submissions` | admin_session |
| `app/admin/pending-submissions/submission-actions.ts` : `rejectSubmissionAction` | `pending_submissions` | admin_session |
| `app/admin/archive/unstamp-actions.ts` : `dryRunUnstampAction` | none (read-only preview) | admin_session |
| `app/admin/archive/unstamp-actions.ts` : `unstampAction` | `publications` (via `lib/roundup-finalize.ts::unstampRoundup`) | admin_session |
| `app/admin/publications/finalize-actions.ts` : `finalizeRoundupAction` | `roundups`, `publications` (via `lib/roundup-finalize.ts::finalizeRoundup`) | admin_session |
| `app/admin/needs-metadata/complete-actions.ts` : `completeNeedsMetadataAction` | `publications`, `publication_authors` (via `lib/needs-metadata.ts`) | admin_session |
| `app/admin/review-campaigns/campaign-actions.ts` : `previewCampaignAction` | none (read-only preview) | admin_session |
| `app/admin/review-campaigns/campaign-actions.ts` : `sendCampaignAction` | `review_requests`, + real Gmail send (via `lib/campaigns.ts::runCampaign`) | admin_session |
| `app/admin/review-campaigns/campaign-actions.ts` : `revokeAction` | `review_requests` | admin_session |
| `app/review/[slug]/[token]/actions.ts` : `setRoleAction` | `publication_authors` (via `lib/review-actions.ts::setCoAuthorRole`) | review_token |
| `app/review/[slug]/[token]/actions.ts` : `rejectAttributionAction` | `publication_authors` (via `rejectAuthorAttribution`) | review_token |
| `app/review/[slug]/[token]/actions.ts` : `confirmOwnAttributionAction` | `publication_authors` (via `setCoAuthorRole`, self-row) | review_token |
| `app/review/[slug]/[token]/actions.ts` : `editCitationAction` | `publications`, `citation_edits` (via `editCitation`) | review_token |
| `app/review/[slug]/[token]/actions.ts` : `markReviewCompleteAction` | `review_requests` (`completed_at`) | review_token |
| `app/review/[slug]/[token]/actions.ts` : `addPublicationAction` | `pending_submissions` or `publication_authors` (via `addMissingPublication`, 4-outcome handler) | review_token |

### Write-during-render (not an action — easy to miss, exactly the kind of thing this section exists to catch)

| File | Writes | Auth |
|---|---|---|
| `app/review/[slug]/[token]/page.tsx:51` | `review_requests.opened_at` (`markReviewRequestOpened`), unconditionally on every page load | review_token — **verified safe**: only fires after `getReviewRequestByToken` returns non-null (line 40 guards it), so an invalid/expired/revoked token never trips the write and can't be used as a token-guessing oracle |

### `scripts/**` (26 `.ts` files) — all `cron/CLI-only`, none reachable over HTTP; only 3 are actually wired to a scheduler (see Discrepancies)

| Script | Writes | Trigger |
|---|---|---|
| `sync-roster.ts` | `faculty` (`INSERT ... ON CONFLICT(wp_id) DO UPDATE`, `UPDATE faculty SET active=0`) | **claimed Daily in plan §9 — no GitHub Actions workflow exists.** CLI-only in practice. |
| `ingest-scholar.ts` | `publications`, `publication_authors`, `faculty.last_alert_seen_at` | cron, `.github/workflows/ingest-scholar.yml`, every 6h |
| `ingest-crossref.ts` | `publications`, `publication_authors` | cron, `.github/workflows/ingest-crossref.yml`, daily 3am |
| `ingest-pubmed-orcid.ts` | `publications`, `publication_authors` | cron, `.github/workflows/ingest-pubmed-orcid.yml`, daily 9am |
| `release-buffer.ts` | `publications.status`/`released_at` | **claimed every 6h in plan §9 — no workflow exists.** CLI-only in practice. |
| `refresh-metadata.ts` | `publications` (volume/issue/pages fill-only), `metadata_mismatches` (upsert) | **claimed Daily in plan §9 — no workflow exists.** CLI-only in practice. |
| `backfill-2025.ts` | none (dry report; real assertions live in `tests/backfill.test.ts`) | CLI-only, one-time |
| `backfill-reconcile-2025.ts` | `publications`, `publication_authors` | CLI-only, one-time (2025 backfill) |
| `backfill-promote-2025.ts` | `publications.status`, `journal`/`volume`/`issue`/`pages` | CLI-only, one-time |
| `backfill-remediate-duplicates-2025.ts` | `publication_authors` (DELETE + UPDATE) | CLI-only, one-time |
| `backfill-verify-production-2025.ts` | none (read-only comparison report) | CLI-only, one-time |
| `backfill-finalize-2025.ts` | `roundups`, `publications` (via `finalizeRoundup`) | CLI-only, one-time — "the one irreversible write in the whole system" per its own header |
| `unstamp-roundup.ts` | `publications` (via `unstampRoundup`) | CLI-only |
| `mint-review-token.ts` | `review_requests` (via `createReviewRequest`) | CLI-only, stopgap/testing utility per its own header |
| `run-campaign.ts` | `review_requests` + real Gmail send (via `runCampaign`) | CLI-only |
| `settings-email.ts` | `settings` | CLI-only |
| `sweep-role-confirmations.ts` | none (read-only; header claims read-only, verified — only `SELECT`s) | CLI-only |
| `report-unconfirmed-matches.ts`, `report-rejected-attributions.ts`, `coverage-report.ts`, `campaign-status.ts`, `roster-verify-2025.ts`, `audit-fullname-coverage.ts` | none (all read-only report generators) | CLI-only |
| `backup-db.ts` | none (dumps to local JSON file, gitignored) | CLI-only |
| `check-ai.ts`, `check-crossref.ts` | none (live diagnostic calls only) | CLI-only, manual |

---

## 3. Unauthenticated surface

Pulled from section 2, `auth ∈ {none, review_token}`:

**`auth = none`:**
- `app/portal-actions.ts::submitPortalPublicationAction` — writes `pending_submissions`. Defended by a honeypot only (`app/portal-shared.ts`, the `website` field), no rate limiting beyond that.
- `app/admin/login/actions.ts::loginAction` — the login gate itself; writes `settings` for its own lockout counter (shared global counter, not per-IP — see `lib/admin-auth.ts`'s own header comment acknowledging this).

**`auth = review_token`:** every function in `app/review/[slug]/[token]/actions.ts` (6 functions) plus the write-during-render in `page.tsx:51`. All six re-derive `facultyId` server-side from the token via `getReviewRequestByToken` (`lib/review.ts`) — none trust a client-supplied `facultyId`/`{slug}`. Token itself: `randomBytes(32)` (256-bit, `lib/tokens.ts`), stored only as `sha256(token)`, checked for `revoked` and `expires_at` on every lookup.

This is the list the rest of Phase 5 is written against.

---

## 4. Idempotency mechanisms

| Job | Mechanism | Where |
|---|---|---|
| `sync-roster` | `INSERT INTO faculty (...) ON CONFLICT(wp_id) DO UPDATE SET ...` | `scripts/sync-roster.ts:35-37` |
| `ingest-scholar` | Two layers: (1) Gmail label applied post-processing — `await gmail.applyLabel(id, labelId)` (`scripts/ingest-scholar.ts:182,244`) so an already-labeled email is never re-fetched by the next run's query; (2) `findMatch`/`mergeAuthors`/`mergeMetadata` (shared merge engine, `lib/matching.ts`) prevent a re-processed article (e.g. a manually re-run label removal) from creating a duplicate `publications` row |
| `ingest-crossref` | `findMatch`/merge engine, same as above — no separate per-run marker (this job re-queries "recent works" by author every run, so idempotency is entirely the merge engine's job, not a run-tracking mechanism) |
| `ingest-pubmed-orcid` | Same — `findMatch`/merge engine only |
| `release-buffer` | `UPDATE publications SET status='published' ... WHERE id IN (...) AND status='pending_merge'` — the trailing `AND status='pending_merge'` is a deliberate re-assertion of the same condition already used to select the rows, commented explicitly as "defensive in case this run overlaps an ingestion run touching the same row" (`scripts/release-buffer.ts:65-69`) |
| `refresh-metadata` | Two distinct guards for its two jobs: (1) the fill-gaps path never overwrites a non-null value — computed in application code, not SQL: `const volume = pub.volume ?? resolved.volume;` (`lib/refresh-metadata.ts:60`, nullish-coalescing, existing value always wins); (2) the mismatch-detection path upserts — `INSERT INTO metadata_mismatches (...) ON CONFLICT(publication_id) DO UPDATE SET ...` (`lib/refresh-metadata.ts:92`) |

**No row where the answer is "nothing found."** Every job in §9 plus `refresh-metadata` has an identifiable, real mechanism — none are relying on accident.

---

## 5. Sensitive-field write map

### `publications.first_seen_at`
- `lib/pending-submissions.ts:223` — set once, at INSERT (new record via review-page/portal submission approval)
- `lib/needs-metadata.ts:134` — **the one deliberate reset**, on promotion out of `needs_metadata` (documented exception, §6)
- `scripts/ingest-scholar.ts:65,81` (INSERT) and `:107` (`UPDATE ... first_seen_at = COALESCE(?, first_seen_at)`)
- `scripts/ingest-crossref.ts:156` (same `COALESCE` pattern), `:185` (INSERT)
- `scripts/ingest-pubmed-orcid.ts:122` (same `COALESCE` pattern), `:148,186` (INSERT)
- `scripts/backfill-reconcile-2025.ts:275` — one-time backfill INSERT

### `publications.roundup_id`
- `lib/roundup-finalize.ts:77` — stamp (`finalizeRoundup`), guarded `WHERE ... roundup_id IS NULL AND status='published'`
- `lib/roundup-finalize.ts:125` — clear (`unstampRoundup`), `WHERE roundup_id = ?`
- These are the **only** two write sites for this column anywhere in the codebase — both in one shared file, both used by both the CLI script and the admin action (no parallel implementation).

### `publications.status`
- `lib/pending-submissions.ts:195,250,285` — `pending_submissions.status` (not `publications.status` — different table, same field name, worth not conflating)
- `scripts/ingest-scholar.ts:107`, `scripts/ingest-crossref.ts:156`, `scripts/ingest-pubmed-orcid.ts:122` — set on merge/insert (`pending_merge` or `needs_metadata`)
- `scripts/release-buffer.ts:68` — `pending_merge` → `published`
- `scripts/backfill-promote-2025.ts:84,113` — one-time backfill promotion

### `publication_authors.role` / `publication_authors.role_set_by`
Written together at every site (never independently) except `lib/matching.ts:149,157`, which is **in-memory only** — `mergeAuthors` is a pure function; it never touches the DB itself, only the caller's subsequent `UPDATE`/`INSERT` persists it. Real write sites:
- `lib/needs-metadata.ts:162` (INSERT), `:167` (UPDATE)
- `lib/review-actions.ts:49` (`setCoAuthorRole`), `:76` (`rejectAuthorAttribution`), `:210` (INSERT, `addMissingPublication`'s linked_you outcome)
- `lib/pending-submissions.ts:149,187,244` (INSERT, 3 separate branches: submitter auto-link, create-path co-authors, MATCH-branch portal-author linking)
- `scripts/ingest-scholar.ts:88,117` (INSERT), `:122` (UPDATE)
- `scripts/ingest-crossref.ts:166,195` (INSERT), `:171` (UPDATE)
- `scripts/ingest-pubmed-orcid.ts:132,158` (INSERT), `:137` (UPDATE)
- `scripts/backfill-reconcile-2025.ts:230,297` (INSERT), `:237` (UPDATE) — one-time
- `scripts/backfill-remediate-duplicates-2025.ts:140` (UPDATE) — one-time
- `lib/backfill-seed.ts:157` (INSERT, no `role_set_by` column at all — test/scratch seeding only, not a production path)

---

## 6. Network call sites

Every raw `fetch(` in the codebase (`app/`, `scripts/`, `lib/`), vs. calls that go through `lib/http.ts::fetchWithRetry`:

| File | Goes through `fetchWithRetry`? |
|---|---|
| `lib/http.ts:56` | **Is** the wrapper — the one sanctioned raw `fetch` call |
| `lib/crossref.ts`, `lib/pubmed.ts`, `lib/orcid.ts`, `lib/gmail.ts` | Yes — zero raw `fetch(` calls in any of these; all route through `fetchWithRetry` |
| `lib/ai.ts:102` | **No.** Raw `fetch()`, with its own separate, duplicated retry/backoff implementation (`backoffDelayMs`, its own attempt loop) — not a reuse of `lib/http.ts`, a parallel copy of the same logic |
| `lib/wordpress.ts:83,104` | **No.** Two raw `fetch()` calls, **no retry/backoff wrapper of any kind** — not even a duplicated one. Used by `sync-roster.ts`. |
| `app/**` | Zero `fetch(` calls anywhere — no client-side or server-side direct network calls from the UI layer |
| `scripts/**` | Zero direct `fetch(` calls — everything routes through `lib/` |

**Two real gaps for Session 1's network guard to know about:** `lib/ai.ts` (duplicated-not-shared retry logic) and `lib/wordpress.ts` (no retry logic at all, and — relevant for "fails CI if a test hits the real internet" — this is the one live HTTP dependency in `sync-roster.ts`, a script with no test-time mock currently verified in this recon).

---

## 7. Open questions

1. **Are `sync-roster`, `release-buffer`, `refresh-metadata` actually running at all?** No GitHub Actions workflow, no `vercel.json`, no other cron config found anywhere in the repo for any of the three — despite §9 listing all three as "Daily"/"Every 6h" scheduled jobs, same as the three that do have real workflows. Couldn't determine whether they're triggered manually by a human on some cadence outside the repo, or genuinely not running on any schedule. Not guessing either way — see Discrepancies.
2. **`lib/wordpress.ts`'s lack of retry logic** — is this deliberate (WordPress REST API assumed reliable enough not to need it) or an oversight? Nothing in the code or plan says which.
3. **The admin login lockout is a single shared counter, not per-IP** (`lib/admin-auth.ts`'s own header comment already acknowledges this as a known limitation, "would need to become per-IP if this ever grows real user accounts"). Whether that's still an acceptable trade-off now that the portal is public (a stranger's failed guesses could lock out COMMS) wasn't something I could resolve from the code — a product decision, not a recon finding.
4. **No `middleware.ts` exists** — every admin Server Action/page independently calls `requireAdminSession()`. This works (verified: every single one does call it, no gaps found), but there's no structural backstop if a future action forgets to. Worth Session 3 treating "does every admin action call the guard" as its own explicit test rather than assuming the current all-green state holds forever.

---

## Discrepancies (plan vs. shipped) — feeds a master-plan amendment, not a code change

1. **`settings` table has no `CREATE TABLE` in §6**, despite being fully described in prose at §8c Tab 3 and being real, shipped, and in active use (the email kill switch). Needs a DDL block added to §6.
2. **`publications.discovered_by_faculty_id` and `publications.scholar_alert_url` are undocumented in §6's DDL** despite being written by `ingest-scholar.ts` and referenced elsewhere. Needs adding to the `publications` CREATE TABLE in §6.
3. **Three of §9's six scheduled jobs have no scheduling mechanism in the repo**: `sync-roster`, `release-buffer`, `refresh-metadata` are listed as "Daily"/"Every 6h" alongside `ingest-scholar`/`ingest-crossref`/`ingest-pubmed-orcid`, but only the latter three have a `.github/workflows/*.yml` file. Either these three are actually run by hand and §9 should say so, or workflows for them don't exist yet and should. This is the highest-value item in this whole document to resolve before writing idempotency tests against a "Daily" cadence that may not exist.
4. **`citation_edits` has an index in migrations/production not shown in the plan's DDL** (`idx_citation_edits_publication`) — minor, add for completeness.
5. **`metadata_mismatches`'s column order** differs between plan (logical grouping) and migrations (chronological `ALTER TABLE` append order) — cosmetic only, plan reads as final-state prose rather than migration history, worth a one-line note rather than a rewrite.

Correction to the task's own framing, not a discrepancy in the plan: the pre-Session-0 assumption that `possible_duplicates` was undocumented was checked and found wrong — it's fully in §6. Only `settings` was genuinely missing.

---

## Appendix: pre-existing drift note (2026-08-05, kept from before this session)

`tests/fixtures/orcid/sample-works.json` and `tests/fixtures/pubmed/sample-summaries.json` are both explicitly **trimmed** excerpts of real API pulls — each file's own `_note` field says so. `tests/orcid.test.ts` and `tests/pubmed.test.ts` import them directly and test parsing logic straight against them (real risk: green against a shape that doesn't occur in the wild). `tests/ingest-pubmed-orcid.test.ts` and `tests/names.test.ts` only reference them indirectly via hand-copied literals (lower risk). Not a confirmed Phase 5 finding — no test has been shown to pass against the trimmed shape and fail against the raw one. `tests/fixtures/api/orcid-works-bennett.json` and `tests/fixtures/api/pubmed-esummary-norte.json` (genuinely raw, captured the same day) exist so a future session can settle this directly.
