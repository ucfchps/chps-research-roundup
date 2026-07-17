// Roster-driven Crossref author search (§5 Layer 2, §9, §13 Phase 3 item 8).
// For each active faculty member, searches Crossref by author name and runs
// every candidate through the existing merge engine (§7) — the same
// findMatch/mergeMetadata/mergeAuthors primitives and the same
// buildAuthorInputs/matchAuthorNameToFaculty author-linking ingest-scholar
// uses (lib/scholar-ingest.ts). No new matching or name-formatting logic
// here. Closes part of §11's "no Scholar coverage" gap: faculty with no
// Google Scholar profile are otherwise only discoverable this way. Run with:
//   npm run ingest:crossref -- --dry-run
//   npm run ingest:crossref -- --faculty <wp_id>   (required before an unscoped run)
//   npm run ingest:crossref
import { config } from "dotenv";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { getAlertCoverage } from "../lib/coverage";
import { mergeAuthors, mergeMetadata, normalizeTitle, promoteFromNeedsMetadata, type AuthorInput, type ExistingAuthor, type MatchableExisting, type MergeableExisting } from "../lib/matching";
import { buildAuthorInputs, findCandidateMatch } from "../lib/scholar-ingest";
import type { CrossrefResolution, Faculty, PublicationStatus } from "../lib/types";
// isUcfAffiliation comes from lib/crossref.ts, which throws at import time if
// CROSSREF_MAILTO is unset — imported dynamically alongside searchByAuthor
// inside runIngestCrossref (same reason as everywhere else in this file),
// then threaded into applyCandidate as a parameter.
type IsUcfAffiliation = (affiliation: string | null | undefined) => boolean;

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

// A chps_faculty link this candidate produced via matchAuthorNameToFaculty —
// family + first-initial only, no ORCID cross-check exists anywhere in this
// pipeline yet. Not a gate (§5's "affiliation is a tiebreaker, never a
// requirement" applies here too — sparse/missing affiliation data is common
// and must not cost a real paper): purely informational, so whoever's
// watching early sweeps has a prioritized list of likely mismatches. Real
// case this would have caught immediately: a marine-fisheries paper's
// "Adams, A." author matched Alauna Adams (School of Social Work) by
// initials alone; that author's own Crossref affiliation string, if present,
// almost certainly doesn't mention UCF.
export interface NameOnlyMatchFlag {
  publicationTitle: string;
  facultyWpId: string | null;
  facultyDisplayName: string;
  affiliation: string | null; // null = Crossref gave no affiliation string for this author at all
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
  nameOnlyMatchUnconfirmed: NameOnlyMatchFlag[];
  skippedFaculty: SkippedFaculty[];
  facultySweepOutcomes: FacultySweepOutcome[];
  dryRun: boolean;
}

// Checks each newly name-matched author from THIS candidate's own resolution
// (not previously-linked authors already sitting on an existing record —
// those were already checked, if at all, the run they were first linked) —
// so a re-run over the same DOI doesn't re-flag someone every day forever.
function flagNameOnlyMatches(
  incomingAuthors: AuthorInput[],
  resolutionAuthors: CrossrefResolution["authors"],
  publicationTitle: string,
  roster: Faculty[],
  isUcfAffiliation: IsUcfAffiliation
): NameOnlyMatchFlag[] {
  const flags: NameOnlyMatchFlag[] = [];
  for (const author of incomingAuthors) {
    if (author.role !== "chps_faculty" || author.faculty_id === null) continue;
    const resolutionAuthor = resolutionAuthors.find((ra) => ra.position === author.position);
    const affiliation = resolutionAuthor?.affiliation ?? null;
    if (isUcfAffiliation(affiliation)) continue; // confirmed — nothing to flag

    const matchedFaculty = roster.find((f) => f.id === author.faculty_id);
    flags.push({
      publicationTitle,
      facultyWpId: matchedFaculty?.wp_id ?? null,
      facultyDisplayName: matchedFaculty?.display_name ?? `faculty_id ${author.faculty_id}`,
      affiliation,
    });
  }
  return flags;
}

// Runs one Crossref candidate through the existing merge engine (§7) exactly
// like any other source — findMatch, then merge-into or insert-new. Crossref
// always arrives with complete metadata, so a new insert is always
// pending_merge, never needs_metadata.
async function applyCandidate(
  client: Client,
  resolution: CrossrefResolution,
  roster: Faculty[],
  nowIso: string,
  dryRun: boolean,
  isUcfAffiliation: IsUcfAffiliation,
  sweptFacultyId: number
): Promise<{ outcome: "merged" | "inserted"; nameOnlyMatchFlags: NameOnlyMatchFlag[]; linkedSweptFaculty: boolean }> {
  const existingList = (await client.execute("SELECT id, doi, title_normalized FROM publications")).rows as unknown as MatchableExisting[];
  const matchResult = findCandidateMatch(resolution.title, resolution.doi, existingList);
  const incomingMetadata = {
    doi: resolution.doi, title: resolution.title, url: resolution.url, journal: resolution.journal,
    year: resolution.year, volume: resolution.volume, issue: resolution.issue, pages: resolution.pages,
  };
  const incomingAuthors = buildAuthorInputs(resolution.authors, roster, nowIso);
  const nameOnlyMatchFlags = flagNameOnlyMatches(incomingAuthors, resolution.authors, resolution.title, roster, isUcfAffiliation);
  const linkedSweptFaculty = incomingAuthors.some((a) => a.faculty_id === sweptFacultyId && a.role === "chps_faculty");

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
    return { outcome: "merged", nameOnlyMatchFlags, linkedSweptFaculty };
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
  return { outcome: "inserted", nameOnlyMatchFlags, linkedSweptFaculty };
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
    nameOnlyMatchUnconfirmed: [],
    skippedFaculty: [],
    facultySweepOutcomes: [],
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
      const { outcome, nameOnlyMatchFlags, linkedSweptFaculty } = await applyCandidate(
        client, resolution, roster, nowIso, opts.dryRun, crossref.isUcfAffiliation, f.id
      );
      if (outcome === "merged") summary.merged++;
      else summary.insertedNew++;
      summary.nameOnlyMatchUnconfirmed.push(...nameOnlyMatchFlags);
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

  if (s.nameOnlyMatchUnconfirmed.length > 0) {
    console.log(
      `\n${s.nameOnlyMatchUnconfirmed.length} name-only match(es), affiliation unconfirmed — linked by family+initial alone (no ORCID cross-check exists yet), and the matched author's own Crossref affiliation string doesn't confirm UCF. Not blocked; prioritize these for a human look:`
    );
    for (const flag of s.nameOnlyMatchUnconfirmed) {
      console.log(`  "${flag.publicationTitle}" -> ${flag.facultyDisplayName} (wp_id ${flag.facultyWpId ?? "?"}) — affiliation: ${flag.affiliation ?? "(none given)"}`);
    }
  }

  if (s.skippedFaculty.length > 0) {
    console.log(`\n${s.skippedFaculty.length} faculty skipped this run (Crossref unavailable) — will retry next run:`);
    for (const f of s.skippedFaculty) console.log(`  ${f.displayName} (wp_id ${f.wpId ?? "?"}): ${f.error}`);
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");

  const opts = parseArgs(process.argv.slice(2));
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
