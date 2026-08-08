// ORCID + PubMed enrichment sweep (§5 Layer 3, §9, §13 Phase 3 item 10).
// Mirrors scripts/ingest-crossref.ts's roster-driven-sweep architecture —
// same merge engine (§7), same buildAuthorInputs/findCandidateMatch
// (lib/scholar-ingest.ts) — two sources instead of one:
//   - ORCID (only for faculty with `orcid` set): highest-trust discovery
//     signal (§5 layer priority), but Crossref is still the preferred source
//     of full citation metadata whenever a DOI is available — resolve
//     DOI-first via resolveByDoi, else resolveByTitle, else insert as
//     needs_metadata (rare — ORCID is richer than Scholar).
//   - PubMed (every active faculty member, regardless of ORCID): normally
//     carries complete metadata already, so it goes straight into
//     match/merge — no Crossref round-trip needed.
// Run with:
//   npm run ingest:pubmed-orcid -- --dry-run
//   npm run ingest:pubmed-orcid -- --faculty <wp_id>
import { config } from "dotenv";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { getOrcidWorks, OrcidUnavailableError, type OrcidWork } from "../lib/orcid";
import {
  buildPubmedAuthorQuery,
  formatPubmedDiagnostics,
  getPubmedAffiliations,
  getPubmedDiagnostics,
  getPubmedRecords,
  PubmedUnavailableError,
  resetPubmedDiagnostics,
  searchPubmedByAuthor,
} from "../lib/pubmed";
import {
  classifyAffiliationPlausibility,
  mergeAuthors,
  mergeMetadata,
  normalizeTitle,
  promoteFromNeedsMetadata,
  type AffiliationPlausibility,
  type ExistingAuthor,
  type MatchableExisting,
  type MergeableExisting,
  type PublicationMetadata,
} from "../lib/matching";
import { buildAuthorInputs, findCandidateMatch } from "../lib/scholar-ingest";
import { getSetting, setSetting } from "../lib/settings";
import type { CrossrefResolutionAuthor, Faculty, PublicationSource, PublicationStatus } from "../lib/types";
// isUcfAffiliation/resolveByDoi/resolveByTitle come from lib/crossref.ts,
// which throws at import time if CROSSREF_MAILTO is unset — imported
// dynamically inside runIngestPubmedOrcid, same reason ingest-crossref.ts does this.

config({ path: path.join(__dirname, "..", ".env.local") });

const UCF_AFFILIATION_HINT = "University of Central Florida";

// Phase 5 hardening (docs/phase5-findings.md #3): this job never completed a
// scheduled run — 13 consecutive CI timeouts at 30 minutes, every one
// restarting from roster position 1. Resume state lives in `settings`
// (the existing precedent: lib/admin-auth.ts's login-lockout counter), keyed
// on wp_id so it survives a roster re-sort, never a raw array index.
// ORCID and PubMed are swept independently, each with its own cursor and its
// own "did we reach the end" tracking — see runIngestPubmedOrcid for why.
// Exported for direct testing (tests/idempotency/ingest-pubmed-orcid-resume.test.ts)
// — same reasoning as ingest-crossref.ts exporting runConfirmationGateSelfTest.
export const ORCID_CURSOR_KEY = "orcid_sweep_cursor";
export const PUBMED_CURSOR_KEY = "pubmed_sweep_cursor";
export const PUBMED_CYCLE_COMPLETED_AT_KEY = "pubmed_sweep_cycle_completed_at";
const SETTINGS_UPDATED_BY = "ingest-pubmed-orcid";

// ~25 minutes, leaving headroom inside the real 30-minute CI timeout to
// write the cursor and exit cleanly rather than being killed mid-write.
// Test-injectable via RunOptions.wallClockCeilingMs — a real 25-minute
// ceiling can't be exercised directly in a unit test.
const DEFAULT_WALL_CLOCK_CEILING_MS = 25 * 60 * 1000;

export interface RunOptions {
  dryRun: boolean;
  facultyWpId: string | null;
  wallClockCeilingMs?: number;
}

export async function readCursor(client: Client, key: string): Promise<string | null> {
  const raw = await getSetting(client, key);
  return raw && raw.length > 0 ? raw : null;
}

// null clears the cursor (settings.value is NOT NULL, so "cleared" is
// represented as an empty string — readCursor treats "" the same as absent).
async function writeCursor(client: Client, key: string, wpId: string | null): Promise<void> {
  await setSetting(client, key, wpId ?? "", SETTINGS_UPDATED_BY);
}

// Position is re-derived from the CURRENT roster every call, never trusted
// from a stored index — a roster re-sort or a removed person never corrupts
// this. A cursor pointing at someone no longer in `pool` (left the roster,
// or this is a first-ever run) falls back to the start, same as no cursor at
// all — deliberately the same branch, not a special case.
export function queueFromCursor<T extends { wp_id: string | null }>(pool: T[], cursorWpId: string | null): T[] {
  const idx = cursorWpId ? pool.findIndex((f) => f.wp_id === cursorWpId) : -1;
  const startIdx = idx === -1 ? 0 : idx + 1;
  return pool.slice(startIdx);
}

// Phase 5 hardening (docs/phase5-findings.md #22-adjacent finding from this
// session's own diagnosis): applyCandidate's existingList SELECT was
// reloading the ENTIRE publications table — 5,797 rows and growing — on
// EVERY candidate, PubMed or ORCID. Measured against production: ~65-190ms
// per round trip, 4-7 round trips per candidate once match/insert writes are
// counted. For a faculty member whose PubMed search returns a large
// candidate set (a common surname near PubMed's retmax=250 ceiling — the
// diagnosis's own worked example), that's minutes of redundant network
// traffic that a resume cursor alone does nothing to fix, since it recurs
// identically every time that person is swept.
//
// Cache lifetime is deliberately narrow — ONE faculty member's ONE sweep
// (ORCID or PubMed, never shared between the two, never shared across
// people): a fresh ExistingListCache is created at the start of each
// sweepOrcidForFaculty/sweepPubmedForFaculty call and discarded at the end.
// Invalidated by this run's own writes via upsert(), called after every
// real (non-dry-run) insert or merge so a second candidate for the same new
// paper later in the SAME sweep still matches instead of duplicating.
export interface ExistingListCache {
  get(client: Client): Promise<MatchableExisting[]>;
  upsert(entry: MatchableExisting): void;
}

export function createExistingListCache(): ExistingListCache {
  let cached: MatchableExisting[] | null = null;
  return {
    async get(client: Client): Promise<MatchableExisting[]> {
      if (cached === null) {
        cached = (await client.execute("SELECT id, doi, title_normalized FROM publications")).rows as unknown as MatchableExisting[];
      }
      return cached;
    },
    upsert(entry: MatchableExisting): void {
      if (cached === null) return; // get() always runs first in practice; a no-op here is safe, not silently wrong
      const idx = cached.findIndex((e) => e.id === entry.id);
      if (idx === -1) cached.push(entry);
      else cached[idx] = entry;
    },
  };
}

type PubRowDetail = MergeableExisting & { status: PublicationStatus };

// docs/phase5-findings.md #2 (Session 14): applyCandidate's MATCH branch
// read a matched publication's full row + its authors from the database
// on EVERY candidate, unconditionally — even in dry-run, since only the
// eventual write is gated. Measured against production: 79% of a
// diagnostic run's wall-clock, dominated by faculty whose PubMed hits
// mostly already existed in the table — an all-merge candidate set near
// the retmax=250 cap cost 30+ seconds of nothing but this. Same shape of
// fix as ExistingListCache above, one level deeper: batch the read
// (preloadMergeDetails), keep it fresh via upsert() after each real write
// so a SECOND candidate in the SAME sweep matching the SAME
// publication_id still sees the first candidate's merge result, not a
// stale pre-fetched snapshot — this is what makes the batching a pure
// performance change rather than a behavior change; the old per-candidate
// fresh read had that same self-consistency property, just by accident of
// re-querying every time.
export interface MergeDetailCache {
  get(client: Client, publicationId: number): Promise<{ pubRow: PubRowDetail; authorRows: ExistingAuthor[] }>;
  upsert(publicationId: number, pubRow: PubRowDetail, authorRows: ExistingAuthor[]): void;
}

export function createMergeDetailCache(): MergeDetailCache {
  const pubRows = new Map<number, PubRowDetail>();
  const authorRows = new Map<number, ExistingAuthor[]>();
  return {
    async get(client: Client, publicationId: number) {
      if (!pubRows.has(publicationId)) {
        // Fallback for an id that preloadMergeDetails somehow didn't cover
        // (shouldn't happen in practice — callers preload every matched id
        // before this is ever called) — correct either way, just without
        // the batching win for this one id.
        const pubRow = (
          await client.execute({
            sql: "SELECT doi, title, url, journal, year, volume, issue, pages, source, status FROM publications WHERE id = ?",
            args: [publicationId],
          })
        ).rows[0] as unknown as PubRowDetail;
        const authors = (
          await client.execute({
            sql: "SELECT id, faculty_id, name, role, role_set_by, role_set_at, position FROM publication_authors WHERE publication_id = ? ORDER BY position",
            args: [publicationId],
          })
        ).rows as unknown as ExistingAuthor[];
        pubRows.set(publicationId, pubRow);
        authorRows.set(publicationId, authors);
      }
      return { pubRow: pubRows.get(publicationId)!, authorRows: authorRows.get(publicationId)! };
    },
    upsert(publicationId: number, pubRow: PubRowDetail, authors: ExistingAuthor[]): void {
      pubRows.set(publicationId, pubRow);
      authorRows.set(publicationId, authors);
    },
  };
}

// A single person's PubMed candidate set is capped at retmax=250 (§13
// item 10), well under SQLite/libSQL's ~999 bound-parameter limit — this
// couldn't overflow a single IN (...) clause today. Chunked anyway rather
// than assumed: retmax is this file's own constant, not a database limit,
// and a future change to it (or a caller batching across multiple people)
// must not silently break by exceeding the real DB-imposed ceiling.
const MERGE_DETAIL_CHUNK_SIZE = 200;

async function preloadMergeDetails(client: Client, cache: MergeDetailCache, publicationIds: number[]): Promise<void> {
  const uniqueIds = [...new Set(publicationIds)];
  for (let i = 0; i < uniqueIds.length; i += MERGE_DETAIL_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + MERGE_DETAIL_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");

    const pubRowsResult = await client.execute({
      sql: `SELECT id, doi, title, url, journal, year, volume, issue, pages, source, status FROM publications WHERE id IN (${placeholders})`,
      args: chunk,
    });
    const authorRowsResult = await client.execute({
      sql: `SELECT id, publication_id, faculty_id, name, role, role_set_by, role_set_at, position FROM publication_authors WHERE publication_id IN (${placeholders}) ORDER BY publication_id, position`,
      args: chunk,
    });

    const authorsByPubId = new Map<number, ExistingAuthor[]>();
    for (const row of authorRowsResult.rows as unknown as (ExistingAuthor & { publication_id: number })[]) {
      const list = authorsByPubId.get(row.publication_id) ?? [];
      list.push(row);
      authorsByPubId.set(row.publication_id, list);
    }
    for (const row of pubRowsResult.rows as unknown as (PubRowDetail & { id: number })[]) {
      cache.upsert(row.id, row, authorsByPubId.get(row.id) ?? []);
    }
  }
}

export function parseArgs(argv: string[]): RunOptions {
  const dryRun = argv.includes("--dry-run");
  const facultyFlag = argv.find((a) => a === "--faculty" || a.startsWith("--faculty="));
  let facultyWpId: string | null = null;
  if (facultyFlag) {
    facultyWpId = facultyFlag.includes("=") ? facultyFlag.split("=")[1] : (argv[argv.indexOf(facultyFlag) + 1] ?? null);
  }
  return { dryRun, facultyWpId };
}

export interface SkippedFaculty {
  wpId: string | null;
  displayName: string;
  source: "orcid" | "pubmed";
  error: string;
}

export interface RunSummary {
  facultyWithOrcidProcessed: number;
  orcidWorksFetched: number;
  resolvedViaDoi: number;
  resolvedViaTitleFallback: number;
  orcidNeedsMetadata: number;
  facultyProcessedViaPubmed: number;
  pubmedRecordsFetched: number;
  // §13 item 10: which name source built each PubMed query — full_name is
  // preferred (richer), display_name is a fallback that produced the
  // confirmed real over-broad-query bug for at least one faculty member.
  // Surfaced so a human can verify/backfill full_name for anyone landing in
  // the fallback bucket, rather than the noise going unnoticed again.
  pubmedQueriedViaFullName: number;
  pubmedQueriedViaDisplayNameFallback: number;
  merged: number;
  insertedNew: number;
  // docs/phase5-findings.md #2 (Session 12): classified only for genuinely
  // new PubMed candidates (a match/merge never needs an affiliation check —
  // we already trust the row it's merging into). "confirmed" candidates
  // insert exactly as before; "not_ucf"/"ambiguous" ALSO still insert (a
  // plausibility signal, never a hard exclusion) — these three counts exist
  // so a human can see the split before deciding whether a real run is
  // safe, not to gate anything in this script.
  pubmedAffiliationConfirmed: number;
  pubmedAffiliationNotUcf: number;
  pubmedAffiliationAmbiguous: number;
  skipped: SkippedFaculty[];
  dryRun: boolean;
  // Resumability (docs/phase5-findings.md #3) — unset when this run was
  // scoped to a single faculty member via --faculty, which bypasses the
  // cursor entirely (unchanged from this script's pre-existing manual-debug
  // behavior).
  orcidCursorAdvancedTo: string | null;
  orcidCycleCompleted: boolean;
  pubmedCursorAdvancedTo: string | null;
  pubmedCycleCompleted: boolean;
  pubmedCycleCompletedAt: string | null;
  stoppedByWallClockCeiling: { orcid: boolean; pubmed: boolean };
}

interface Candidate {
  doi: string | null;
  title: string;
  url: string;
  journal: string | null;
  year: number | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  authors: CrossrefResolutionAuthor[];
}

// Runs one ORCID- or PubMed-sourced candidate through the existing merge
// engine (§7) exactly like Crossref candidates do — findMatch, then
// merge-into or insert-new. Both sources always arrive with complete
// metadata by the time they reach here (ORCID's DOI/title resolution
// already ran through Crossref; PubMed is complete on its own) — a new
// insert is always pending_merge, never needs_metadata, same as Crossref.
async function applyCandidate(
  client: Client,
  candidate: Candidate,
  roster: Faculty[],
  nowIso: string,
  dryRun: boolean,
  source: PublicationSource,
  existingListCache: ExistingListCache,
  mergeDetailCache: MergeDetailCache
): Promise<"merged" | "inserted"> {
  const existingList = await existingListCache.get(client);
  const matchResult = findCandidateMatch(candidate.title, candidate.doi, existingList);
  const incomingMetadata: PublicationMetadata = {
    doi: candidate.doi, title: candidate.title, url: candidate.url, journal: candidate.journal,
    year: candidate.year, volume: candidate.volume, issue: candidate.issue, pages: candidate.pages,
  };
  const incomingAuthors = buildAuthorInputs(candidate.authors, roster, nowIso);

  if (matchResult.type === "MATCH") {
    const { pubRow, authorRows } = await mergeDetailCache.get(client, matchResult.publicationId);

    const mergedMetadata = mergeMetadata(pubRow, incomingMetadata, source);
    const mergedAuthors = mergeAuthors(authorRows, incomingAuthors, source);
    const promotion = promoteFromNeedsMetadata(pubRow.status, mergedMetadata.doi);

    if (!dryRun) {
      await client.execute({
        sql: `UPDATE publications SET doi=?, title=?, title_normalized=?, url=?, journal=?, year=?, volume=?, issue=?, pages=?, status=?, first_seen_at = COALESCE(?, first_seen_at) WHERE id=?`,
        args: [
          mergedMetadata.doi, mergedMetadata.title, mergedMetadata.title_normalized, mergedMetadata.url,
          mergedMetadata.journal, mergedMetadata.year, mergedMetadata.volume, mergedMetadata.issue,
          mergedMetadata.pages, promotion.status, promotion.promoted ? nowIso : null, matchResult.publicationId,
        ],
      });
      // Captures each new author's real id (lastInsertRowid), not just
      // reusing the placeholder null MergedAuthor carried — the upserted
      // cache entry below must hold real ExistingAuthor rows, or a LATER
      // candidate in this sweep matching this same publication would see
      // an author it can't correctly resolve as update-vs-insert.
      const updatedAuthorRows: ExistingAuthor[] = [];
      for (const a of mergedAuthors) {
        if (a.id === null) {
          const result = await client.execute({
            sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [matchResult.publicationId, a.faculty_id, a.name, a.role, a.role_set_by, a.role_set_at, a.position],
          });
          updatedAuthorRows.push({ ...a, id: Number(result.lastInsertRowid) });
        } else {
          await client.execute({
            sql: `UPDATE publication_authors SET faculty_id=?, role=?, role_set_by=?, role_set_at=? WHERE id=?`,
            args: [a.faculty_id, a.role, a.role_set_by, a.role_set_at, a.id],
          });
          updatedAuthorRows.push({ ...a, id: a.id });
        }
      }
      // The matched row's own doi/title_normalized may have just changed
      // (mergeMetadata can fill or upgrade either) — keep the cache's
      // findMatch-relevant fields current so a LATER candidate in this same
      // sweep matches against the row's new identity, not its stale one.
      existingListCache.upsert({ id: matchResult.publicationId, doi: mergedMetadata.doi, title_normalized: mergedMetadata.title_normalized });
      // Same reasoning, one level deeper: a LATER candidate in this sweep
      // matching this SAME publication_id must see THIS merge's result,
      // not the pre-loaded snapshot from before the loop started.
      mergeDetailCache.upsert(matchResult.publicationId, { ...mergedMetadata, source: pubRow.source, status: promotion.status }, updatedAuthorRows);
    }
    return "merged";
  }

  if (!dryRun) {
    const titleNormalized = normalizeTitle(candidate.title);
    const result = await client.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, journal, year, volume, issue, pages, status, source, first_seen_at, date_added, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_merge', ?, ?, ?, ?)`,
      args: [
        candidate.doi, candidate.title, titleNormalized, candidate.url, candidate.journal,
        candidate.year, candidate.volume, candidate.issue, candidate.pages, source, nowIso, nowIso.slice(0, 10), nowIso,
      ],
    });
    const publicationId = Number(result.lastInsertRowid);
    for (const a of incomingAuthors) {
      await client.execute({
        sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [publicationId, a.faculty_id, a.name, a.role, a.role_set_by, a.role_set_at, a.position],
      });
    }
    // The load-bearing part of the cache: a LATER candidate in this same
    // sweep for the same real-world paper (a real, observed shape — e.g. the
    // same DOI surfacing via both an ORCID work and a PubMed record) must
    // see this row without a fresh SELECT, or it would insert a duplicate.
    existingListCache.upsert({ id: publicationId, doi: candidate.doi, title_normalized: titleNormalized });
  }
  return "inserted";
}

// An ORCID work that resolved via neither DOI nor title fallback (§5a.8's
// posture, applied to ORCID — expected to be rare, since ORCID is richer
// than Scholar). ORCID's works list carries no author data at all (unlike
// Scholar, which at least names the discovering faculty in its footer link,
// this endpoint gives title/type/date/external-ids only) — mirrors
// lib/scholar-ingest.ts's insert_needs_metadata: no publication_authors rows,
// just a discovered_by_faculty_id pointer for a human to complete later (§8c
// Tab 4).
async function applyOrcidNeedsMetadata(
  client: Client,
  work: OrcidWork,
  facultyId: number,
  nowIso: string,
  dryRun: boolean,
  existingListCache: ExistingListCache
): Promise<"merged" | "inserted"> {
  const existingList = await existingListCache.get(client);
  const matchResult = findCandidateMatch(work.title, null, existingList);

  if (matchResult.type === "MATCH") {
    // §9 idempotency: a second sighting of a paper we still can't resolve.
    // Nothing new to contribute — acknowledge, create nothing.
    return "merged";
  }

  if (!dryRun) {
    const titleNormalized = normalizeTitle(work.title);
    const result = await client.execute({
      sql: `INSERT INTO publications (title, title_normalized, url, year, status, source, discovered_by_faculty_id, first_seen_at, date_added, created_at)
            VALUES (?, ?, ?, ?, 'needs_metadata', 'orcid', ?, ?, ?, ?)`,
      args: [work.title, titleNormalized, work.url, work.year, facultyId, nowIso, nowIso.slice(0, 10), nowIso],
    });
    existingListCache.upsert({ id: Number(result.lastInsertRowid), doi: null, title_normalized: titleNormalized });
  }
  return "inserted";
}

function applyOutcome(summary: RunSummary, outcome: "merged" | "inserted"): void {
  if (outcome === "merged") summary.merged++;
  else summary.insertedNew++;
}

async function sweepOrcid(
  client: Client,
  f: Faculty,
  roster: Faculty[],
  nowIso: string,
  dryRun: boolean,
  summary: RunSummary,
  crossref: typeof import("../lib/crossref"),
  runStartedAt: number,
  ceilingMs: number
): Promise<void> {
  if (!f.orcid) return;
  summary.facultyWithOrcidProcessed++;
  const existingListCache = createExistingListCache(); // fresh per person, never shared — see the cache's own header comment
  // No upfront preloadMergeDetails here: unlike PubMed's candidate set,
  // ORCID's isn't known until each work is resolved via Crossref inside
  // the loop below, one network call at a time — nothing to batch ahead
  // of time. Session 10's own diagnosis measured ORCID+Crossref at ~40s
  // total for all 47 real holders, never the bottleneck; this cache still
  // gives ORCID the same per-sweep self-consistency PubMed's gets (a
  // second work matching the same publication sees the first's merge),
  // just via its lazy per-id fallback path rather than a batch preload.
  const mergeDetailCache = createMergeDetailCache();

  let works: OrcidWork[];
  try {
    works = await getOrcidWorks(f.orcid);
  } catch (err) {
    if (err instanceof OrcidUnavailableError) {
      summary.skipped.push({ wpId: f.wp_id, displayName: f.display_name, source: "orcid", error: err.message });
      return;
    }
    throw err;
  }
  summary.orcidWorksFetched += works.length;

  const surnameHint = f.display_name.split(",")[0].trim();

  // docs/phase5-findings.md #2 (Session 14): the wall-clock ceiling used to
  // only ever gate STARTING a new faculty member — a single person's own
  // work could run uninterrupted regardless of how far over budget it went
  // (Session 13 measured up to ~39s of uninterruptible per-person cost
  // before this fix). Checked once per work/record, not just once per
  // person — the person's own cursor still advances afterward (the same
  // "attempted, however far it got" philosophy every other stop condition
  // here already uses), so nothing here changes what "resumable" means.
  for (let i = 0; i < works.length; i++) {
    if (Date.now() - runStartedAt > ceilingMs) {
      summary.stoppedByWallClockCeiling.orcid = true;
      summary.skipped.push({
        wpId: f.wp_id,
        displayName: f.display_name,
        source: "orcid",
        error: `wall-clock ceiling hit mid-sweep — ${works.length - i} of ${works.length} ORCID work(s) not evaluated this cycle`,
      });
      break;
    }
    const work = works[i];
    try {
      let resolution = work.doi ? await crossref.resolveByDoi(work.doi) : null;
      if (resolution) summary.resolvedViaDoi++;

      if (!resolution) {
        resolution = await crossref.resolveByTitle(work.title, work.year, surnameHint);
        if (resolution) summary.resolvedViaTitleFallback++;
      }

      if (resolution) {
        const candidate: Candidate = {
          doi: resolution.doi, title: resolution.title, url: resolution.url, journal: resolution.journal,
          year: resolution.year, volume: resolution.volume, issue: resolution.issue, pages: resolution.pages,
          authors: resolution.authors,
        };
        applyOutcome(summary, await applyCandidate(client, candidate, roster, nowIso, dryRun, "orcid", existingListCache, mergeDetailCache));
      } else {
        summary.orcidNeedsMetadata++;
        applyOutcome(summary, await applyOrcidNeedsMetadata(client, work, f.id, nowIso, dryRun, existingListCache));
      }
    } catch (err) {
      if (err instanceof crossref.CrossrefUnavailableError) {
        summary.skipped.push({ wpId: f.wp_id, displayName: f.display_name, source: "orcid", error: `resolving "${work.title}": ${err.message}` });
        continue; // one bad work never aborts the rest of this person's ORCID sweep
      }
      throw err;
    }
  }
}

async function sweepPubmed(
  client: Client,
  f: Faculty,
  roster: Faculty[],
  nowIso: string,
  dryRun: boolean,
  summary: RunSummary,
  runStartedAt: number,
  ceilingMs: number
): Promise<void> {
  summary.facultyProcessedViaPubmed++;
  const existingListCache = createExistingListCache(); // fresh per person, never shared with the ORCID sweep or any other person
  const mergeDetailCache = createMergeDetailCache(); // fresh per person — preloaded below, before the candidate loop

  const query = buildPubmedAuthorQuery(f);
  if (query.source === "full_name") {
    summary.pubmedQueriedViaFullName++;
  } else {
    summary.pubmedQueriedViaDisplayNameFallback++;
    console.warn(`[pubmed-query-fallback] ${f.display_name} (wp_id ${f.wp_id ?? "?"}): full_name missing or unparseable — queried the sparser display_name instead. Verify/backfill full_name for this person.`);
  }

  // docs/phase5-findings.md (Session 13 diagnostic): reset once per person
  // so getPubmedDiagnostics() below reflects only THIS person's PubMed
  // calls, not a running total — the whole point is a per-person
  // distribution, not just a run-wide sum. wrapped in try/finally so the
  // line logs unconditionally, including when this person is skipped.
  resetPubmedDiagnostics();
  const personStartedAt = Date.now();
  try {
    const pmids = await searchPubmedByAuthor(query.queryName, UCF_AFFILIATION_HINT);
    const records = await getPubmedRecords(pmids);
    summary.pubmedRecordsFetched += records.length;

    // Affiliation only ever informs the INSERT decision, never a merge — a
    // record that already matches something in the table is trusted by
    // virtue of matching, so fetching efetch for it would be pure waste.
    // This pre-pass is also the Session 12 cost fix: measured against
    // production, efetching every fetched record (not just the new ones)
    // added enough wall-clock to threaten the 25-minute ceiling.
    //
    // Session 14 extends this SAME pre-pass one step further: it already
    // computes every record's match status once, so the set of matched
    // publicationIds is free to collect here too — preloading them in one
    // or two batched queries (preloadMergeDetails) instead of the
    // per-candidate queries applyCandidate used to run itself is the fix
    // for docs/phase5-findings.md #2's measured 79%-of-wall-clock finding.
    const existingList = await existingListCache.get(client);
    const newPmids = new Set<string>();
    const matchedPublicationIds: number[] = [];
    for (const r of records) {
      const matchResult = findCandidateMatch(r.title, r.doi, existingList);
      if (matchResult.type === "MATCH") matchedPublicationIds.push(matchResult.publicationId);
      else newPmids.add(r.pmid);
    }
    await preloadMergeDetails(client, mergeDetailCache, matchedPublicationIds);

    let affiliationsByPmid = new Map<string, string[]>();
    if (newPmids.size > 0) {
      try {
        affiliationsByPmid = await getPubmedAffiliations([...newPmids]);
      } catch (err) {
        // Affiliation is a signal, not a gate — if efetch itself is down,
        // every new candidate this person just falls into "ambiguous"
        // (empty affiliation list) below, not a skipped person. Only
        // esearch/esummary failures (below) should skip the whole person.
        if (!(err instanceof PubmedUnavailableError)) throw err;
      }
    }

    // docs/phase5-findings.md #2 (Session 14): same reasoning as sweepOrcid's
    // identical check above — this is the loop the ceiling previously had
    // no way to intervene in mid-person. Checked once per record, after the
    // batching fix above already collapsed the dominant per-record cost;
    // this is now defense-in-depth against whatever's left (the per-record
    // WRITEs in a real run are still O(records) — batching only fixed the
    // reads, since dry-run, the only thing measured so far, never reaches
    // the write path at all).
    for (let i = 0; i < records.length; i++) {
      if (Date.now() - runStartedAt > ceilingMs) {
        summary.stoppedByWallClockCeiling.pubmed = true;
        summary.skipped.push({
          wpId: f.wp_id,
          displayName: f.display_name,
          source: "pubmed",
          error: `wall-clock ceiling hit mid-sweep — ${records.length - i} of ${records.length} PubMed record(s) not evaluated this cycle`,
        });
        break;
      }
      const record = records[i];
      const candidate: Candidate = {
        doi: record.doi, title: record.title, url: record.url, journal: record.journal,
        year: record.year, volume: record.volume, issue: record.issue, pages: record.pages,
        authors: record.authors,
      };
      if (newPmids.has(record.pmid)) {
        const bucket: AffiliationPlausibility = classifyAffiliationPlausibility(affiliationsByPmid.get(record.pmid) ?? []);
        if (bucket === "confirmed") summary.pubmedAffiliationConfirmed++;
        else if (bucket === "not_ucf") summary.pubmedAffiliationNotUcf++;
        else summary.pubmedAffiliationAmbiguous++;
        console.log(`[pubmed-affiliation] ${f.display_name} (wp_id ${f.wp_id ?? "?"}): pmid ${record.pmid} -> ${bucket}`);
      }
      applyOutcome(summary, await applyCandidate(client, candidate, roster, nowIso, dryRun, "pubmed", existingListCache, mergeDetailCache));
    }
  } catch (err) {
    if (err instanceof PubmedUnavailableError) {
      summary.skipped.push({ wpId: f.wp_id, displayName: f.display_name, source: "pubmed", error: err.message });
      return;
    }
    throw err;
  } finally {
    const totalMs = Date.now() - personStartedAt;
    const d = getPubmedDiagnostics();
    const accountedMs = (["esearch", "esummary", "efetch"] as const).reduce((sum, t) => sum + d[t].fetchMs + d[t].backoffMs + d[t].rateLimitWaitMs, 0);
    // "Other" is deliberately a residual, not a separately-measured bucket —
    // JSON/XML parsing, DB round trips inside applyCandidate, and any event-
    // loop scheduling delay all land here. A large "other" would mean the
    // bottleneck is OUR code, not NCBI; this run's whole point was ruling
    // that out before proposing a fix.
    console.log(`[pubmed-timing] ${f.display_name} (wp_id ${f.wp_id ?? "?"}): total=${totalMs}ms, other=${totalMs - accountedMs}ms — ${formatPubmedDiagnostics(d)}`);
  }
}

function emptySummary(dryRun: boolean): RunSummary {
  return {
    facultyWithOrcidProcessed: 0,
    orcidWorksFetched: 0,
    resolvedViaDoi: 0,
    resolvedViaTitleFallback: 0,
    orcidNeedsMetadata: 0,
    facultyProcessedViaPubmed: 0,
    pubmedRecordsFetched: 0,
    pubmedQueriedViaFullName: 0,
    pubmedQueriedViaDisplayNameFallback: 0,
    merged: 0,
    insertedNew: 0,
    pubmedAffiliationConfirmed: 0,
    pubmedAffiliationNotUcf: 0,
    pubmedAffiliationAmbiguous: 0,
    skipped: [],
    dryRun,
    orcidCursorAdvancedTo: null,
    orcidCycleCompleted: false,
    pubmedCursorAdvancedTo: null,
    pubmedCycleCompleted: false,
    pubmedCycleCompletedAt: null,
    stoppedByWallClockCeiling: { orcid: false, pubmed: false },
  };
}

// One faculty member's attempt, wrapped so the cursor ALWAYS advances past
// them afterward — success, a specifically-anticipated Unavailable error
// (already caught inside sweepOrcid/sweepPubmed), or a genuinely unexpected
// error alike. This is what makes "a persistently-failing faculty member is
// skipped forward, not retried indefinitely" true: the cursor has no notion
// of retry count to exhaust, it simply never re-targets someone whose
// attempt already completed, however it completed.
async function attemptOrcidSweep(
  client: Client,
  f: Faculty,
  roster: Faculty[],
  nowIso: string,
  dryRun: boolean,
  summary: RunSummary,
  crossref: typeof import("../lib/crossref"),
  runStartedAt: number,
  ceilingMs: number
): Promise<void> {
  try {
    await sweepOrcid(client, f, roster, nowIso, dryRun, summary, crossref, runStartedAt, ceilingMs);
  } catch (err) {
    summary.skipped.push({ wpId: f.wp_id, displayName: f.display_name, source: "orcid", error: `unexpected error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

async function attemptPubmedSweep(
  client: Client,
  f: Faculty,
  roster: Faculty[],
  nowIso: string,
  dryRun: boolean,
  summary: RunSummary,
  runStartedAt: number,
  ceilingMs: number
): Promise<void> {
  try {
    await sweepPubmed(client, f, roster, nowIso, dryRun, summary, runStartedAt, ceilingMs);
  } catch (err) {
    summary.skipped.push({ wpId: f.wp_id, displayName: f.display_name, source: "pubmed", error: `unexpected error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

export async function runIngestPubmedOrcid(client: Client, opts: RunOptions): Promise<RunSummary> {
  const crossref = await import("../lib/crossref");

  const nowIso = new Date().toISOString();
  const roster = (await client.execute("SELECT * FROM faculty WHERE active = 1")).rows as unknown as Faculty[];
  const summary = emptySummary(opts.dryRun);

  // --faculty is a manual, single-person debug override — bypasses the
  // cursor and wall-clock ceiling entirely, exactly this script's
  // pre-existing behavior. The cursor/resume machinery below only ever
  // engages for a real, unscoped sweep (how production actually runs it).
  if (opts.facultyWpId) {
    const f = roster.find((r) => r.wp_id === opts.facultyWpId);
    if (f) {
      // Infinity, not DEFAULT_WALL_CLOCK_CEILING_MS — this path bypasses
      // the ceiling entirely, per the comment above; the mid-sweep check
      // both functions now do must never trigger here either.
      await sweepOrcid(client, f, roster, nowIso, opts.dryRun, summary, crossref, Date.now(), Infinity);
      await sweepPubmed(client, f, roster, nowIso, opts.dryRun, summary, Date.now(), Infinity);
    }
    return summary;
  }

  const runStartedAt = Date.now();
  const ceilingMs = opts.wallClockCeilingMs ?? DEFAULT_WALL_CLOCK_CEILING_MS;

  // --- ORCID sweep: its own cursor, independent of PubMed's. Given ORCID's
  // real measured cost (~40s total for all 47 real holders — see the Session
  // 10 diagnosis), this runs to completion in every real invocation; the
  // cursor exists as a defensive resume mechanism (same mechanics as
  // PubMed's, not a special case) in case that assumption is ever wrong, not
  // because ORCID is expected to need it in practice. Runs BEFORE PubMed so
  // the highest-trust source is never hostage to PubMed's own budget.
  const orcidHolders = roster.filter((f) => f.orcid);
  const orcidCursor = await readCursor(client, ORCID_CURSOR_KEY);
  const orcidQueue = queueFromCursor(orcidHolders, orcidCursor);

  for (const f of orcidQueue) {
    if (Date.now() - runStartedAt > ceilingMs) {
      summary.stoppedByWallClockCeiling.orcid = true;
      break;
    }
    await attemptOrcidSweep(client, f, roster, nowIso, opts.dryRun, summary, crossref, runStartedAt, ceilingMs);
    summary.orcidCursorAdvancedTo = f.wp_id;
    if (!opts.dryRun) await writeCursor(client, ORCID_CURSOR_KEY, f.wp_id);
  }
  if (!summary.stoppedByWallClockCeiling.orcid && orcidQueue.length > 0) {
    summary.orcidCycleCompleted = true;
    if (!opts.dryRun) await writeCursor(client, ORCID_CURSOR_KEY, null); // wrap — next run starts this source's cycle over
  }

  // --- PubMed sweep: its own cursor, resumes independently of ORCID's progress. ---
  const pubmedCursor = await readCursor(client, PUBMED_CURSOR_KEY);
  const pubmedQueue = queueFromCursor(roster, pubmedCursor);

  for (const f of pubmedQueue) {
    if (Date.now() - runStartedAt > ceilingMs) {
      summary.stoppedByWallClockCeiling.pubmed = true;
      break;
    }
    await attemptPubmedSweep(client, f, roster, nowIso, opts.dryRun, summary, runStartedAt, ceilingMs);
    summary.pubmedCursorAdvancedTo = f.wp_id;
    if (!opts.dryRun) await writeCursor(client, PUBMED_CURSOR_KEY, f.wp_id);
  }
  if (!summary.stoppedByWallClockCeiling.pubmed && pubmedQueue.length > 0) {
    summary.pubmedCycleCompleted = true;
    summary.pubmedCycleCompletedAt = nowIso;
    if (!opts.dryRun) {
      await writeCursor(client, PUBMED_CURSOR_KEY, null);
      await setSetting(client, PUBMED_CYCLE_COMPLETED_AT_KEY, nowIso, SETTINGS_UPDATED_BY);
    }
    console.log(`[pubmed-cycle-complete] Full PubMed sweep cycle completed at ${nowIso} — every active faculty member reached this cycle.`);
  }

  return summary;
}

function printSummary(s: RunSummary): void {
  if (s.dryRun) console.log("--dry-run: no writes will be issued.\n");
  console.log(
    `${s.facultyWithOrcidProcessed} faculty with ORCID processed · ${s.orcidWorksFetched} ORCID work(s) fetched · ` +
      `${s.resolvedViaDoi} resolved via DOI · ${s.resolvedViaTitleFallback} resolved via title fallback · ${s.orcidNeedsMetadata} landed as needs_metadata`
  );
  console.log(`${s.facultyProcessedViaPubmed} faculty processed via PubMed · ${s.pubmedRecordsFetched} PubMed record(s) fetched`);
  console.log(`${s.pubmedQueriedViaFullName} faculty queried via full_name, ${s.pubmedQueriedViaDisplayNameFallback} via display_name fallback (review these)`);
  console.log(`${s.merged} merged into existing records · ${s.insertedNew} new pending_merge/needs_metadata rows created`);
  const pubmedNewTotal = s.pubmedAffiliationConfirmed + s.pubmedAffiliationNotUcf + s.pubmedAffiliationAmbiguous;
  if (pubmedNewTotal > 0) {
    console.log(
      `New PubMed candidates by affiliation plausibility: ${s.pubmedAffiliationConfirmed} confirmed UCF · ${s.pubmedAffiliationNotUcf} plausibly not UCF · ${s.pubmedAffiliationAmbiguous} ambiguous (no affiliation data) — of ${pubmedNewTotal} total`
    );
  }

  if (s.orcidCursorAdvancedTo !== null || s.pubmedCursorAdvancedTo !== null) {
    console.log(
      `\nORCID cursor: ${s.orcidCycleCompleted ? "completed this cycle, wrapped" : `stopped after wp_id ${s.orcidCursorAdvancedTo ?? "(none)"}${s.stoppedByWallClockCeiling.orcid ? " — wall-clock ceiling" : ""}`}`
    );
    console.log(
      `PubMed cursor: ${s.pubmedCycleCompleted ? "completed this cycle, wrapped" : `stopped after wp_id ${s.pubmedCursorAdvancedTo ?? "(none)"}${s.stoppedByWallClockCeiling.pubmed ? " — wall-clock ceiling" : ""}`}`
    );
  }

  if (s.skipped.length > 0) {
    console.log(`\n${s.skipped.length} error(s)/skip(s) this run:`);
    for (const sk of s.skipped) console.log(`  [${sk.source}] ${sk.displayName} (wp_id ${sk.wpId ?? "?"}): ${sk.error}`);
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");

  const opts = parseArgs(process.argv.slice(2));
  if (opts.dryRun) console.log("--dry-run: parsing, resolving, and deciding only. Nothing will be written.\n");

  const client = createClient({ url, authToken });
  const summary = await runIngestPubmedOrcid(client, opts);
  printSummary(summary);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
