// Roster-driven Crossref author search (§5 Layer 2, §9, §13 Phase 3 item 8).
// For each active faculty member, searches Crossref by author name and runs
// every candidate through the existing merge engine (§7) — the same
// findMatch/mergeMetadata/mergeAuthors primitives and the same
// buildAuthorInputs/matchAuthorNameToFaculty author-linking ingest-scholar
// uses (lib/scholar-ingest.ts). No new matching or name-formatting logic
// here. Closes part of §11's "no Scholar coverage" gap: faculty with no
// Google Scholar profile are otherwise only discoverable this way. Run with:
//   npm run ingest:crossref -- --dry-run
//   npm run ingest:crossref -- --faculty <wp_id>   (still useful to scope which people get SEARCHED — no longer required for safety, see assertConfirmationGateWired)
import { config } from "dotenv";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { getAlertCoverage } from "../lib/coverage";
import { mergeAuthors, mergeMetadata, normalizeTitle, promoteFromNeedsMetadata, type ExistingAuthor, type MatchableExisting, type MergeableExisting } from "../lib/matching";
import { buildAuthorInputs, findCandidateMatch } from "../lib/scholar-ingest";
import type { CrossrefResolution, Faculty, PublicationStatus } from "../lib/types";

config({ path: path.join(__dirname, "..", ".env.local") });

const DEFAULT_LOOKBACK_DAYS = 720; // ~2 years — generous catch-up; the merge engine is idempotent, so overlap across runs is harmless
const UCF_AFFILIATION_HINT = "University of Central Florida";

function readLookbackDays(): number {
  const raw = process.env.CROSSREF_AUTHOR_SEARCH_LOOKBACK_DAYS;
  if (!raw) {
    console.error(`⚠ CROSSREF_AUTHOR_SEARCH_LOOKBACK_DAYS not set — defaulting to ${DEFAULT_LOOKBACK_DAYS}`);
    return DEFAULT_LOOKBACK_DAYS;
  }
  return Number(raw);
}

function sincePubDate(lookbackDays: number, now: Date): string {
  return new Date(now.getTime() - lookbackDays * 86400000).toISOString().slice(0, 10);
}

export interface RunOptions {
  dryRun: boolean;
  facultyWpId: string | null;
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
  error: string;
}

export interface SurnameGateRejection {
  wpId: string | null;
  displayName: string;
  count: number;
}

// §15.11: a faculty member who was swept and genuinely found nothing must
// not be indistinguishable from one where the sweep worked as intended and
// simply found nothing NEW this run — those look identical as a bare count
// otherwise. One entry per swept faculty member (excluding anyone skipped
// outright for CrossrefUnavailableError — they never got a real outcome).
export interface FacultySweepOutcome {
  wpId: string | null;
  displayName: string;
  candidatesSeen: number; // post-surname-gate candidates for THIS person's own search
  linked: boolean; // did at least one of those candidates link an author to this faculty member
  noScholarCoverage: boolean; // §11: this sweep is their only automated discovery path
}

export interface RunSummary {
  facultySwept: number;
  candidatesSeen: number;
  merged: number;
  insertedNew: number;
  rejectedBySurnameGate: number;
  rejectedBySurnameGateByFaculty: SurnameGateRejection[];
  skippedFaculty: SkippedFaculty[];
  facultySweepOutcomes: FacultySweepOutcome[];
  // §13 item 8 follow-up (ops-notes.md §3): aggregate visibility into how
  // many of this run's candidate author-links the confirmation gate
  // (buildAuthorInputs, lib/scholar-ingest.ts) actually confirmed vs. left
  // unconfirmed — the empirical check a full-roster dry-run needs to prove
  // the gate is wired into this call path, without resurrecting the old
  // flagNameOnlyMatches per-row console spam (durable detail lives in
  // scripts/report-unconfirmed-matches.ts instead).
  confirmedFacultyLinks: number;
  unconfirmedFacultyLinks: number;
  dryRun: boolean;
}

// Runs one Crossref candidate through the existing merge engine (§7) exactly
// like any other source — findMatch, then merge-into or insert-new. Crossref
// always arrives with complete metadata, so a new insert is always
// pending_merge, never needs_metadata.
//
// ★ ops-notes.md §5/§6: buildAuthorInputs (lib/scholar-ingest.ts) is now the
// structural confirmation gate — a name match (family + first initial, no
// ORCID cross-check) only becomes role='chps_faculty' when its Crossref
// affiliation string corroborates UCF. Otherwise it writes role='unknown'
// with a role_set_by tag identifying it as an unconfirmed match, durably
// (scripts/report-unconfirmed-matches.ts reads these back). This retires the
// old flagNameOnlyMatches, which only ever logged the same risk to one run's
// console output without blocking the write — a parallel, driftable
// implementation of the same check the shared gate now owns.
async function applyCandidate(
  client: Client,
  resolution: CrossrefResolution,
  roster: Faculty[],
  nowIso: string,
  dryRun: boolean,
  sweptFacultyId: number
): Promise<{ outcome: "merged" | "inserted"; linkedSweptFaculty: boolean; confirmedFacultyLinks: number; unconfirmedFacultyLinks: number }> {
  const existingList = (await client.execute("SELECT id, doi, title_normalized FROM publications")).rows as unknown as MatchableExisting[];
  const matchResult = findCandidateMatch(resolution.title, resolution.doi, existingList);
  const incomingMetadata = {
    doi: resolution.doi, title: resolution.title, url: resolution.url, journal: resolution.journal,
    year: resolution.year, volume: resolution.volume, issue: resolution.issue, pages: resolution.pages,
  };
  const incomingAuthors = buildAuthorInputs(resolution.authors, roster, nowIso);
  const linkedSweptFaculty = incomingAuthors.some((a) => a.faculty_id === sweptFacultyId && a.role === "chps_faculty");
  const confirmedFacultyLinks = incomingAuthors.filter((a) => a.role === "chps_faculty").length;
  const unconfirmedFacultyLinks = incomingAuthors.filter((a) => a.role_set_by?.startsWith("ingest:unconfirmed")).length;

  if (matchResult.type === "MATCH") {
    const pubRow = (
      await client.execute({
        sql: "SELECT doi, title, url, journal, year, volume, issue, pages, source, status FROM publications WHERE id = ?",
        args: [matchResult.publicationId],
      })
    ).rows[0] as unknown as MergeableExisting & { status: PublicationStatus };
    const authorRows = (
      await client.execute({
        sql: "SELECT id, faculty_id, name, role, role_set_by, role_set_at, position FROM publication_authors WHERE publication_id = ? ORDER BY position",
        args: [matchResult.publicationId],
      })
    ).rows as unknown as ExistingAuthor[];

    const mergedMetadata = mergeMetadata(pubRow, incomingMetadata, "crossref");
    const mergedAuthors = mergeAuthors(authorRows, incomingAuthors, "crossref");
    // §15.11 promotion rule — see promoteFromNeedsMetadata in lib/matching.ts.
    const promotion = promoteFromNeedsMetadata(pubRow.status, mergedMetadata.doi);

    if (!dryRun) {
      // first_seen_at = COALESCE(?, first_seen_at): only reset when this
      // merge just promoted the record out of needs_metadata (§7) — a fresh
      // buffer window for a record only now becoming mergeable. Null (the
      // normal case) leaves the column untouched.
      await client.execute({
        sql: `UPDATE publications SET doi=?, title=?, title_normalized=?, url=?, journal=?, year=?, volume=?, issue=?, pages=?, status=?, first_seen_at = COALESCE(?, first_seen_at) WHERE id=?`,
        args: [
          mergedMetadata.doi, mergedMetadata.title, mergedMetadata.title_normalized, mergedMetadata.url,
          mergedMetadata.journal, mergedMetadata.year, mergedMetadata.volume, mergedMetadata.issue,
          mergedMetadata.pages, promotion.status, promotion.promoted ? nowIso : null, matchResult.publicationId,
        ],
      });
      for (const a of mergedAuthors) {
        if (a.id === null) {
          await client.execute({
            sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [matchResult.publicationId, a.faculty_id, a.name, a.role, a.role_set_by, a.role_set_at, a.position],
          });
        } else {
          await client.execute({
            sql: `UPDATE publication_authors SET faculty_id=?, role=?, role_set_by=?, role_set_at=? WHERE id=?`,
            args: [a.faculty_id, a.role, a.role_set_by, a.role_set_at, a.id],
          });
        }
      }
    }
    return { outcome: "merged", linkedSweptFaculty, confirmedFacultyLinks, unconfirmedFacultyLinks };
  }

  // NEEDS_FUZZY is treated as "no match" this session — findCandidateMatch's
  // own documented convention, same as ingest-scholar — so this is genuinely
  // new.
  if (!dryRun) {
    const result = await client.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, journal, year, volume, issue, pages, status, source, first_seen_at, date_added, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_merge', 'crossref', ?, ?, ?)`,
      args: [
        resolution.doi, resolution.title, normalizeTitle(resolution.title), resolution.url, resolution.journal,
        resolution.year, resolution.volume, resolution.issue, resolution.pages, nowIso, nowIso.slice(0, 10), nowIso,
      ],
    });
    const publicationId = Number(result.lastInsertRowid);
    for (const a of incomingAuthors) {
      await client.execute({
        sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [publicationId, a.faculty_id, a.name, a.role, a.role_set_by, a.role_set_at, a.position],
      });
    }
  }
  return { outcome: "inserted", linkedSweptFaculty, confirmedFacultyLinks, unconfirmedFacultyLinks };
}

export async function runIngestCrossref(client: Client, opts: RunOptions): Promise<RunSummary> {
  // lib/crossref.ts throws at import time if CROSSREF_MAILTO is unset — a
  // static import here would be hoisted above config() (same reason
  // scripts/refresh-metadata.ts and scripts/ingest-scholar.ts do this).
  const crossref = await import("../lib/crossref");

  const lookbackDays = readLookbackDays();
  const now = new Date();
  const nowIso = now.toISOString();
  const since = sincePubDate(lookbackDays, now);

  const roster = (await client.execute("SELECT * FROM faculty WHERE active = 1")).rows as unknown as Faculty[];
  const scoped = opts.facultyWpId ? roster.filter((f) => f.wp_id === opts.facultyWpId) : roster;
  // Crossref's author-field search needs a natural-order name; can't search
  // for someone the directory never gave us a full_name for.
  const searchable = scoped.filter((f) => f.full_name);

  const coverage = await getAlertCoverage(client);
  const noScholarCoverageIds = new Set([...coverage.not_google_scholar, ...coverage.no_profile_at_all].map((f) => f.id));

  const summary: RunSummary = {
    facultySwept: 0,
    candidatesSeen: 0,
    merged: 0,
    insertedNew: 0,
    rejectedBySurnameGate: 0,
    rejectedBySurnameGateByFaculty: [],
    skippedFaculty: [],
    facultySweepOutcomes: [],
    confirmedFacultyLinks: 0,
    unconfirmedFacultyLinks: 0,
    dryRun: opts.dryRun,
  };

  for (const f of searchable) {
    summary.facultySwept++;
    const noScholarCoverage = noScholarCoverageIds.has(f.id);

    // display_name is citation-form "Family, G.I." (§6) — the part before
    // the comma is the surname, same convention scripts/ingest-scholar.ts
    // uses to build its own Crossref surnameHint.
    const surnameHint = f.display_name.split(",")[0].trim();

    let resolutions: CrossrefResolution[];
    try {
      const result = await crossref.searchByAuthor({
        authorName: f.full_name as string,
        affiliationHint: UCF_AFFILIATION_HINT,
        sincePubDate: since,
        surnameHint,
      });
      resolutions = result.resolutions;
      if (result.rejectedBySurnameGate > 0) {
        summary.rejectedBySurnameGate += result.rejectedBySurnameGate;
        summary.rejectedBySurnameGateByFaculty.push({ wpId: f.wp_id, displayName: f.display_name, count: result.rejectedBySurnameGate });
      }
    } catch (err) {
      if (err instanceof crossref.CrossrefUnavailableError) {
        console.error(`[unavailable] ${f.display_name} (wp_id ${f.wp_id}): ${err.message}`);
        summary.skippedFaculty.push({ wpId: f.wp_id, displayName: f.display_name, error: err.message });
        continue; // one person's outage never aborts the sweep
      }
      throw err;
    }

    summary.candidatesSeen += resolutions.length;

    let linkedThisFaculty = false;
    for (const resolution of resolutions) {
      const { outcome, linkedSweptFaculty, confirmedFacultyLinks, unconfirmedFacultyLinks } = await applyCandidate(client, resolution, roster, nowIso, opts.dryRun, f.id);
      if (outcome === "merged") summary.merged++;
      else summary.insertedNew++;
      summary.confirmedFacultyLinks += confirmedFacultyLinks;
      summary.unconfirmedFacultyLinks += unconfirmedFacultyLinks;
      if (linkedSweptFaculty) linkedThisFaculty = true;
      console.log(`[${outcome}] "${resolution.title}" (via ${f.display_name})`);
    }

    summary.facultySweepOutcomes.push({
      wpId: f.wp_id, displayName: f.display_name, candidatesSeen: resolutions.length, linked: linkedThisFaculty, noScholarCoverage,
    });
  }

  return summary;
}

// §15.11: "swept" alone collapses three genuinely different states into one
// indistinguishable number. Split them so a human can tell "nothing to find"
// from "something's off with matching" from "working as intended."
function bucketOutcome(f: FacultySweepOutcome): "no_candidates" | "candidates_no_link" | "linked" {
  if (f.linked) return "linked";
  return f.candidatesSeen === 0 ? "no_candidates" : "candidates_no_link";
}

function printSummary(s: RunSummary): void {
  if (s.dryRun) console.log("--dry-run: no writes will be issued.\n");
  console.log(`${s.facultySwept} faculty swept · ${s.candidatesSeen} Crossref candidate(s) seen · ${s.merged} merged · ${s.insertedNew} inserted new`);
  console.log(
    `${s.confirmedFacultyLinks} chps_faculty link(s) confirmed by affiliation · ${s.unconfirmedFacultyLinks} unconfirmed name-only match(es) ` +
      `(see npm run report:unconfirmed-matches for detail)`
  );

  const noCandidates = s.facultySweepOutcomes.filter((f) => bucketOutcome(f) === "no_candidates");
  const candidatesNoLink = s.facultySweepOutcomes.filter((f) => bucketOutcome(f) === "candidates_no_link");
  const linked = s.facultySweepOutcomes.filter((f) => bucketOutcome(f) === "linked");
  console.log(
    `Per-faculty outcome: ${noCandidates.length} found zero candidates at all, ` +
      `${candidatesNoLink.length} found candidates but none linked to them, ${linked.length} linked at least one.`
  );

  const noScholarCoverageSwept = s.facultySweepOutcomes.filter((f) => f.noScholarCoverage);
  if (noScholarCoverageSwept.length > 0) {
    const ncNoCandidates = noScholarCoverageSwept.filter((f) => bucketOutcome(f) === "no_candidates").length;
    const ncNoLink = noScholarCoverageSwept.filter((f) => bucketOutcome(f) === "candidates_no_link").length;
    const ncLinked = noScholarCoverageSwept.filter((f) => bucketOutcome(f) === "linked").length;
    console.log(
      `\n${noScholarCoverageSwept.length} of the faculty swept this run have no Scholar coverage at all (§11) — this sweep is their only ` +
        `automated discovery path. Of those: ${ncNoCandidates} found nothing, ${ncNoLink} found candidates but none linked, ${ncLinked} linked at least one:`
    );
    for (const f of noScholarCoverageSwept) {
      const label = bucketOutcome(f) === "no_candidates" ? "no candidates" : bucketOutcome(f) === "candidates_no_link" ? "candidates, none linked" : "linked";
      console.log(`  ${f.displayName} (wp_id ${f.wpId ?? "?"}): ${label}`);
    }
  }

  if (s.rejectedBySurnameGate > 0) {
    console.log(`\n${s.rejectedBySurnameGate} candidate(s) rejected by the surname gate (author list didn't contain the searched surname) — never reached the merge engine:`);
    for (const f of s.rejectedBySurnameGateByFaculty) console.log(`  ${f.displayName} (wp_id ${f.wpId ?? "?"}): ${f.count}`);
  }

  // Unconfirmed name-only matches (ops-notes.md §5/§6) are no longer
  // reported here — buildAuthorInputs writes them durably as
  // role='unknown', role_set_by='ingest:unconfirmed_name_match(...)'.
  // Run `npm run report:unconfirmed-matches` for the current list.

  if (s.skippedFaculty.length > 0) {
    console.log(`\n${s.skippedFaculty.length} faculty skipped this run (Crossref unavailable) — will retry next run:`);
    for (const f of s.skippedFaculty) console.log(`  ${f.displayName} (wp_id ${f.wpId ?? "?"}): ${f.error}`);
  }
}

// ★ ops-notes.md §3 step 2 — retired assertScopeIsSafe's scope-based
// blocking. The empirical investigation that produced §3 found scope never
// protected against the actual harm: applyCandidate always matches every
// co-author against the FULL active roster regardless of --faculty, so an
// unscoped run and a --faculty-looped sweep produce identical risk. What
// actually prevents an unconfirmed name match from writing chps_faculty is
// the confirmation gate in buildAuthorInputs (lib/scholar-ingest.ts,
// ops-notes.md §5/§6) — structural, and independent of scope. A fresh
// full-129-faculty unscoped dry-run against this exact gate (ops-notes.md
// §3, re-check) confirmed it clean: 544 chps_faculty links, all affiliation-
// confirmed by construction; 66 name-only matches correctly routed to
// role='unknown' instead of silently confirmed — matching the original
// pre-gate investigation's 66 nameOnlyMatchUnconfirmed count exactly.
//
// What replaces the guard is a cheap runtime self-test, not a scope
// restriction: prove buildAuthorInputs is still wired into this call path
// and still correctly refuses BOTH unconfirmed shapes (no affiliation data
// at all — the common case, 54 of the 60 unconfirmed rows in the ops-notes
// §6 sweep; and affiliation present but conflicting — the rarer, higher-
// severity case, 6 of 60) before every run. Defense-in-depth against a
// future refactor silently bypassing the gate, not a barrier to running at all.

// Injectable so tests can prove this self-test would actually CATCH a
// broken/bypassed gate (not just that the real one currently passes) —
// see tests/ingest-crossref.test.ts.
export function runConfirmationGateSelfTest(buildAuthorInputsFn: typeof buildAuthorInputs = buildAuthorInputs): string[] {
  // A synthetic candidate + synthetic roster row, fully disconnected from
  // the real DB. If the probe name didn't genuinely MATCH its own roster
  // row (faculty_id stayed null), the role/role_set_by checks below would
  // pass vacuously without the affiliation check ever running at all — the
  // "never matched" check catches exactly that.
  const probeFaculty: Faculty = {
    id: -1, wp_id: null, slug: null, display_name: "Gate Probe, T.", full_name: null, email: null,
    unit: null, research_profile_url: null, scholar_user_id: null, orcid: null, classification: null,
    active: 1, last_alert_seen_at: null, last_synced_at: null,
  };
  const nowIso = new Date().toISOString();

  const noAffiliation = buildAuthorInputsFn([{ name: "Gate Probe, T.", position: 0 }], [probeFaculty], nowIso)[0];
  const conflictingAffiliation = buildAuthorInputsFn(
    // Deliberately NOT "...UCF..." anywhere in this string — isUcfAffiliation
    // matches a bare "UCF" token regardless of surrounding words, so a probe
    // string containing that substring would pass by accident, not by
    // actually exercising a non-UCF affiliation. Confirmed the hard way: an
    // earlier version of this probe used "Definitely Not UCF University" and
    // its own \bUCF\b correctly matched, silently defeating the test.
    [{ name: "Gate Probe, T.", position: 0, affiliation: "Unaffiliated Research Institute, Nowhere" }],
    [probeFaculty],
    nowIso
  )[0];

  const failures: string[] = [];

  if (noAffiliation?.faculty_id !== -1 || conflictingAffiliation?.faculty_id !== -1) {
    failures.push("probe name never matched its own synthetic roster entry (faculty_id) — this self-test is not exercising the confirmation gate at all");
  }
  if (noAffiliation?.role !== "unknown" || noAffiliation?.role_set_by !== "ingest:unconfirmed_name_match") {
    failures.push(
      `no-affiliation-data probe: expected role='unknown'/role_set_by='ingest:unconfirmed_name_match', got role='${noAffiliation?.role}'/role_set_by='${noAffiliation?.role_set_by}'`
    );
  }
  if (conflictingAffiliation?.role !== "unknown" || conflictingAffiliation?.role_set_by !== "ingest:unconfirmed_name_match_conflicting_affiliation") {
    failures.push(
      `conflicting-affiliation probe: expected role='unknown'/role_set_by='ingest:unconfirmed_name_match_conflicting_affiliation', got role='${conflictingAffiliation?.role}'/role_set_by='${conflictingAffiliation?.role_set_by}'`
    );
  }

  return failures;
}

export function assertConfirmationGateWired(buildAuthorInputsFn: typeof buildAuthorInputs = buildAuthorInputs): void {
  const failures = runConfirmationGateSelfTest(buildAuthorInputsFn);
  if (failures.length > 0) {
    throw new Error(`Confirmation gate self-test failed — buildAuthorInputs may have been bypassed or altered:\n  ${failures.join("\n  ")}\nRefusing to run.`);
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");

  const opts = parseArgs(process.argv.slice(2));
  // Runs unconditionally (dry-run or real, scoped or not) — cheap, pure,
  // in-memory, and it's the one thing standing between a silently-bypassed
  // confirmation gate and a wrong chps_faculty link. See the comment above
  // runConfirmationGateSelfTest.
  assertConfirmationGateWired();
  if (opts.dryRun) console.log("--dry-run: parsing, resolving, and deciding only. Nothing will be written.\n");

  const client = createClient({ url, authToken });
  const summary = await runIngestCrossref(client, opts);
  printSummary(summary);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
