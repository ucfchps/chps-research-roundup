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
import { buildPubmedAuthorQuery, getPubmedRecords, PubmedUnavailableError, searchPubmedByAuthor } from "../lib/pubmed";
import { mergeAuthors, mergeMetadata, normalizeTitle, promoteFromNeedsMetadata, type ExistingAuthor, type MatchableExisting, type MergeableExisting, type PublicationMetadata } from "../lib/matching";
import { buildAuthorInputs, findCandidateMatch } from "../lib/scholar-ingest";
import type { CrossrefResolutionAuthor, Faculty, PublicationSource, PublicationStatus } from "../lib/types";
// isUcfAffiliation/resolveByDoi/resolveByTitle come from lib/crossref.ts,
// which throws at import time if CROSSREF_MAILTO is unset — imported
// dynamically inside runIngestPubmedOrcid, same reason ingest-crossref.ts does this.

config({ path: path.join(__dirname, "..", ".env.local") });

const UCF_AFFILIATION_HINT = "University of Central Florida";

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
  skipped: SkippedFaculty[];
  dryRun: boolean;
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
async function applyCandidate(client: Client, candidate: Candidate, roster: Faculty[], nowIso: string, dryRun: boolean, source: PublicationSource): Promise<"merged" | "inserted"> {
  const existingList = (await client.execute("SELECT id, doi, title_normalized FROM publications")).rows as unknown as MatchableExisting[];
  const matchResult = findCandidateMatch(candidate.title, candidate.doi, existingList);
  const incomingMetadata: PublicationMetadata = {
    doi: candidate.doi, title: candidate.title, url: candidate.url, journal: candidate.journal,
    year: candidate.year, volume: candidate.volume, issue: candidate.issue, pages: candidate.pages,
  };
  const incomingAuthors = buildAuthorInputs(candidate.authors, roster, nowIso);

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
    return "merged";
  }

  if (!dryRun) {
    const result = await client.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, journal, year, volume, issue, pages, status, source, first_seen_at, date_added, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_merge', ?, ?, ?, ?)`,
      args: [
        candidate.doi, candidate.title, normalizeTitle(candidate.title), candidate.url, candidate.journal,
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
async function applyOrcidNeedsMetadata(client: Client, work: OrcidWork, facultyId: number, nowIso: string, dryRun: boolean): Promise<"merged" | "inserted"> {
  const existingList = (await client.execute("SELECT id, doi, title_normalized FROM publications")).rows as unknown as MatchableExisting[];
  const matchResult = findCandidateMatch(work.title, null, existingList);

  if (matchResult.type === "MATCH") {
    // §9 idempotency: a second sighting of a paper we still can't resolve.
    // Nothing new to contribute — acknowledge, create nothing.
    return "merged";
  }

  if (!dryRun) {
    await client.execute({
      sql: `INSERT INTO publications (title, title_normalized, url, year, status, source, discovered_by_faculty_id, first_seen_at, date_added, created_at)
            VALUES (?, ?, ?, ?, 'needs_metadata', 'orcid', ?, ?, ?, ?)`,
      args: [work.title, normalizeTitle(work.title), work.url, work.year, facultyId, nowIso, nowIso.slice(0, 10), nowIso],
    });
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
  crossref: typeof import("../lib/crossref")
): Promise<void> {
  if (!f.orcid) return;
  summary.facultyWithOrcidProcessed++;

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

  for (const work of works) {
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
        applyOutcome(summary, await applyCandidate(client, candidate, roster, nowIso, dryRun, "orcid"));
      } else {
        summary.orcidNeedsMetadata++;
        applyOutcome(summary, await applyOrcidNeedsMetadata(client, work, f.id, nowIso, dryRun));
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

async function sweepPubmed(client: Client, f: Faculty, roster: Faculty[], nowIso: string, dryRun: boolean, summary: RunSummary): Promise<void> {
  summary.facultyProcessedViaPubmed++;

  const query = buildPubmedAuthorQuery(f);
  if (query.source === "full_name") {
    summary.pubmedQueriedViaFullName++;
  } else {
    summary.pubmedQueriedViaDisplayNameFallback++;
    console.warn(`[pubmed-query-fallback] ${f.display_name} (wp_id ${f.wp_id ?? "?"}): full_name missing or unparseable — queried the sparser display_name instead. Verify/backfill full_name for this person.`);
  }

  try {
    const pmids = await searchPubmedByAuthor(query.queryName, UCF_AFFILIATION_HINT);
    const records = await getPubmedRecords(pmids);
    summary.pubmedRecordsFetched += records.length;

    for (const record of records) {
      const candidate: Candidate = {
        doi: record.doi, title: record.title, url: record.url, journal: record.journal,
        year: record.year, volume: record.volume, issue: record.issue, pages: record.pages,
        authors: record.authors,
      };
      applyOutcome(summary, await applyCandidate(client, candidate, roster, nowIso, dryRun, "pubmed"));
    }
  } catch (err) {
    if (err instanceof PubmedUnavailableError) {
      summary.skipped.push({ wpId: f.wp_id, displayName: f.display_name, source: "pubmed", error: err.message });
      return;
    }
    throw err;
  }
}

export async function runIngestPubmedOrcid(client: Client, opts: RunOptions): Promise<RunSummary> {
  const crossref = await import("../lib/crossref");

  const nowIso = new Date().toISOString();
  const roster = (await client.execute("SELECT * FROM faculty WHERE active = 1")).rows as unknown as Faculty[];
  const scoped = opts.facultyWpId ? roster.filter((f) => f.wp_id === opts.facultyWpId) : roster;

  const summary: RunSummary = {
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
    skipped: [],
    dryRun: opts.dryRun,
  };

  for (const f of scoped) {
    await sweepOrcid(client, f, roster, nowIso, opts.dryRun, summary, crossref);
    await sweepPubmed(client, f, roster, nowIso, opts.dryRun, summary);
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
