// Session 21 (§13.24 operational backfill) — Task A: reconcile
// ground-truth-2025.json into PRODUCTION Turso. Production is NOT empty
// (cron ingesters have been discovering 2025 papers since Session 8), so
// this is a match/merge/insert pass, not a bulk seed — unlike Session 20's
// clean-room script, which this deliberately does not reuse (that one
// wipes and reinserts; that would be catastrophic here).
//
// Reuses the real §7 ladder verbatim: lib/matching.ts::findMatch for
// publication matching, lib/matching.ts::mergeAuthors for the author merge
// (extended in this same session to accept a 'manual' incoming source that
// may set ANY role, not just chps_faculty — see lib/matching.ts and
// tests/matching.test.ts), and lib/scholar-ingest.ts::matchAuthorNameToFaculty
// for linking a chps_faculty author to its real production faculty row.
//
// --dry-run is the DEFAULT (writes nothing) — pass --real to actually write.
// Idempotent: a second real run finds nothing left to change.
//
// Run with:
//   npx tsx scripts/backfill-reconcile-2025.ts            (dry run)
//   npx tsx scripts/backfill-reconcile-2025.ts --real      (writes)
import { config } from "dotenv";
import path from "node:path";
config({ path: path.join(__dirname, "..", ".env.local") });
import { createClient, type Client } from "@libsql/client";
import { loadGroundTruth, type GroundTruthFixture, type GroundTruthPublication } from "../lib/backfill-seed";
import { findMatch, mergeAuthors, isHumanSet, normalizeTitle, type AuthorInput, type ExistingAuthor, type MatchableExisting } from "../lib/matching";
import { matchAuthorNameToFaculty } from "../lib/scholar-ingest";
import { resolveAuthorDedupName } from "../lib/backfill-diff";
import type { Faculty } from "../lib/types";

const BACKFILL_DATE_ADDED = "2025-06-30";
const ROLE_SET_BY = "manual:backfill-2025";

// Two real people whose WordPress post TITLE shows their current surname but
// whose underlying structured last-name field was never updated after a
// name change — production's faculty.display_name is stuck on the stale
// surname until that WordPress field itself is fixed (out of scope here).
// This maps the fixture's (current, correct) author name to the name
// string that will actually FIND their row for LINKING purposes only — the
// printed citation still renders the fixture's own name string
// ("Starling-Smith, J. M.") since formatAuthor renders publication_authors.name,
// never faculty.display_name.
const LINK_NAME_OVERRIDES: Record<string, string> = {
  "Starling-Smith, J. M.": "Renziehausen, J.",
  "Dawson, N.": "Loughran, N.D.",
  // Session 20 used Crossref's byline spelling ("Gurnurkar") for the printed
  // citation on the Brazendale paper; the roster's own historical spelling
  // (now inserted as a departed faculty row, Session 21) is "Gurnukar" —
  // same person, two spellings, neither wrong so much as two different
  // sources of truth (publisher byline vs. institutional record).
  "Gurnurkar, S.": "Gurnukar, S.",
  // Xiayu Summer Chen (production faculty id=8, School of Social Work) — the
  // directory and sync-roster both did their job; her WordPress profile's
  // profile_F_name field is simply "Summer" with no second initial captured
  // anywhere queryable ("Xiayu" appears only in prose inside her biography
  // field). matchAuthorNameToFaculty is comparing correctly; the data it's
  // comparing against is incomplete at the source. This override closes the
  // gap for this backfill's 5 publications only — it does NOT fix future
  // ingestion of any new Chen paper, which will hit this identical mismatch
  // again. See master plan §6 ROLES, "Open follow-up (Session 21): Chen,
  // X.S." — a durable alias mechanism and/or a WordPress data fix are still
  // open, tracked separately.
  "Chen, X. S.": "Chen, S.",
};

function resolveFacultyLink(authorName: string, facultyRows: Faculty[]): Faculty | null {
  const lookupName = LINK_NAME_OVERRIDES[authorName] ?? authorName;
  return matchAuthorNameToFaculty(lookupName, facultyRows);
}

// Author-name dedup overrides (fixture post-literal spelling -> production's
// canonical spelling for the same real person) now live in
// lib/backfill-diff.ts::AUTHOR_DEDUP_OVERRIDES — shared with Task B's
// citation comparison (scripts/backfill-verify-production-2025.ts), which
// needs the exact same equivalences.

export function parseArgs(argv: string[]): { real: boolean } {
  return { real: argv.includes("--real") };
}

export interface AuthorChange {
  name: string;
  before: string;
  after: string;
}

export interface HumanConflict {
  name: string;
  fixtureRole: string;
  productionRole: string;
  roleSetBy: string;
}

export interface ReconcileFinding {
  pubKey: string;
  title: string;
  matchType: "doi" | "title" | "ambiguous" | "new";
  productionId: number | null;
  authorChanges: AuthorChange[];
  newAuthors: string[];
  humanConflicts: HumanConflict[];
  unlinkedChpsFaculty: string[];
  dateAddedCorrected: boolean;
}

export interface ReconcileSummary {
  matched: number;
  toInsert: number;
  ambiguous: number;
  totalAuthorChanges: number;
  totalNewAuthors: number;
  totalHumanConflicts: number;
  totalUnlinkedChpsFaculty: number;
  totalDateAddedCorrected: number;
}

function describeAuthor(role: string, facultyId: number | null): string {
  return facultyId !== null ? `${role} (faculty #${facultyId})` : role;
}

async function reconcilePublication(
  client: Client,
  pub: GroundTruthPublication,
  facultyRows: Faculty[],
  real: boolean
): Promise<ReconcileFinding> {
  const existingPubs = (
    await client.execute("SELECT id, doi, title_normalized FROM publications")
  ).rows as unknown as MatchableExisting[];

  const matchResult = findMatch({ doi: pub.doi, title: pub.title }, existingPubs);

  if (matchResult.type === "NEEDS_FUZZY") {
    return {
      pubKey: pub.key,
      title: pub.title,
      matchType: "ambiguous",
      productionId: null,
      authorChanges: [],
      newAuthors: [],
      humanConflicts: [],
      unlinkedChpsFaculty: [],
      dateAddedCorrected: false,
    };
  }

  const pubId = matchResult.publicationId;
  const existingAuthors = (
    await client.execute({ sql: "SELECT * FROM publication_authors WHERE publication_id = ? ORDER BY position", args: [pubId] })
  ).rows as unknown as ExistingAuthor[];

  // A MATCHED (already-ingested) publication keeps whatever date_added the
  // real cron pipeline stamped it with — its actual DISCOVERY time, which
  // for papers ingested well after mid-2025 is nowhere near this edition's
  // boundary. §6's own schema comment defines backfill date_added as "publish
  // date of the roundup post it came from," for every publication in this
  // backfill, not just newly-inserted ones — otherwise Task C's §6b
  // eligibility query silently excludes an already-ingested paper from the
  // very edition it's supposed to belong to.
  const currentDateAdded = (
    await client.execute({ sql: "SELECT date_added FROM publications WHERE id = ?", args: [pubId] })
  ).rows[0] as unknown as { date_added: string };
  const dateAddedCorrected = currentDateAdded.date_added !== BACKFILL_DATE_ADDED;
  if (dateAddedCorrected && real) {
    await client.execute({ sql: "UPDATE publications SET date_added = ? WHERE id = ?", args: [BACKFILL_DATE_ADDED, pubId] });
  }

  const now = new Date().toISOString();
  const unlinkedChpsFaculty: string[] = [];
  const incoming: AuthorInput[] = pub.authors.map((a) => {
    let facultyId: number | null = null;
    if (a.role === "chps_faculty") {
      const facultyMatch = resolveFacultyLink(a.name, facultyRows);
      if (facultyMatch) facultyId = facultyMatch.id;
      else unlinkedChpsFaculty.push(a.name);
    }
    return {
      name: resolveAuthorDedupName(pub.key, a.name),
      faculty_id: facultyId,
      role: a.role,
      role_set_by: ROLE_SET_BY,
      role_set_at: now,
      position: a.position,
    };
  });

  const merged = mergeAuthors(existingAuthors, incoming, "manual");

  const authorChanges: AuthorChange[] = [];
  const humanConflicts: HumanConflict[] = [];
  const newAuthors: string[] = [];

  for (const m of merged) {
    if (m.id === null) {
      newAuthors.push(`${m.name} (${describeAuthor(m.role, m.faculty_id)})`);
      continue;
    }
    const orig = existingAuthors.find((e) => e.id === m.id)!;

    // A conflict is a fact about EXISTING production data vs. the fixture —
    // true whether or not mergeAuthors changed anything (a correctly-BLOCKED
    // conflict leaves merged === existing, so this can't be detected by
    // diffing the two; it has to be asked independently, per fixture author).
    if (isHumanSet(orig.role_set_by)) {
      const fixtureAuthor = pub.authors.find((a) => resolveAuthorDedupName(pub.key, a.name) === orig.name);
      if (fixtureAuthor && fixtureAuthor.role !== orig.role) {
        humanConflicts.push({ name: orig.name, fixtureRole: fixtureAuthor.role, productionRole: orig.role, roleSetBy: orig.role_set_by! });
      }
      continue;
    }

    if (orig.role === m.role && orig.faculty_id === m.faculty_id) continue; // mergeAuthors made no change

    authorChanges.push({
      name: orig.name,
      before: describeAuthor(orig.role, orig.faculty_id),
      after: describeAuthor(m.role, m.faculty_id),
    });
  }

  if (real) {
    for (const m of merged) {
      if (m.id === null) {
        await client.execute({
          sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [pubId, m.faculty_id, m.name, m.role, m.role_set_by, m.role_set_at, m.position],
        });
      } else {
        const orig = existingAuthors.find((e) => e.id === m.id)!;
        if (orig.role === m.role && orig.faculty_id === m.faculty_id) continue;
        await client.execute({
          sql: `UPDATE publication_authors SET role = ?, faculty_id = ?, role_set_by = ?, role_set_at = ? WHERE id = ?`,
          args: [m.role, m.faculty_id, m.role_set_by, m.role_set_at, m.id],
        });
      }
    }
  }

  return {
    pubKey: pub.key,
    title: pub.title,
    matchType: matchResult.reason,
    productionId: pubId,
    authorChanges,
    newAuthors,
    humanConflicts,
    unlinkedChpsFaculty,
    dateAddedCorrected,
  };
}

async function insertNewPublication(client: Client, pub: GroundTruthPublication, facultyRows: Faculty[], real: boolean): Promise<string[]> {
  const now = new Date().toISOString();
  const unlinkedChpsFaculty: string[] = [];

  // Faculty-link matching is read-only and must run on EVERY pass, dry-run
  // included — this is exactly the information a dry-run exists to surface
  // before the real run. Only the actual INSERTs are gated on `real`.
  const linkedFacultyIds: Array<number | null> = pub.authors.map((a) => {
    if (a.role !== "chps_faculty") return null;
    const facultyMatch = resolveFacultyLink(a.name, facultyRows);
    if (facultyMatch) return facultyMatch.id;
    unlinkedChpsFaculty.push(a.name);
    return null;
  });

  if (!real) return unlinkedChpsFaculty;

  const pubResult = await client.execute({
    sql: `INSERT INTO publications (doi, title, title_normalized, url, journal, year, volume, issue, pages, status, source, first_seen_at, date_added, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 'manual', ?, ?, ?)`,
    args: [
      pub.doi ?? null,
      pub.title,
      normalizeTitle(pub.title),
      pub.url,
      pub.journal || null,
      pub.year ?? null,
      pub.volume ?? null,
      pub.issue ?? null,
      pub.pages ?? null,
      now,
      BACKFILL_DATE_ADDED,
      now,
    ],
  });
  const pubId = Number(pubResult.lastInsertRowid);

  for (let i = 0; i < pub.authors.length; i++) {
    const a = pub.authors[i];
    await client.execute({
      sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [pubId, linkedFacultyIds[i], a.name, a.role, ROLE_SET_BY, now, a.position],
    });
  }
  return unlinkedChpsFaculty;
}

export async function runReconcile(client: Client, fixture: GroundTruthFixture, opts: { real: boolean }): Promise<{ findings: ReconcileFinding[]; summary: ReconcileSummary }> {
  const facultyRows = (await client.execute("SELECT * FROM faculty")).rows as unknown as Faculty[];
  const findings: ReconcileFinding[] = [];

  for (const pub of fixture.publications) {
    const finding = await reconcilePublication(client, pub, facultyRows, opts.real);
    if (finding.matchType === "ambiguous") {
      // No match found for this fixture publication — per §13.24, "no match
      // -> insert". Reported as "new" (not left in the "ambiguous" bucket)
      // once we've confirmed there really is nothing to merge into.
      const unlinked = await insertNewPublication(client, pub, facultyRows, opts.real);
      findings.push({ ...finding, matchType: "new", unlinkedChpsFaculty: unlinked });
    } else {
      findings.push(finding);
    }
  }

  const summary: ReconcileSummary = {
    matched: findings.filter((f) => f.matchType === "doi" || f.matchType === "title").length,
    toInsert: findings.filter((f) => f.matchType === "new").length,
    ambiguous: 0, // resolved to "new" above — kept as a summary field for the printed report's shape
    totalAuthorChanges: findings.reduce((n, f) => n + f.authorChanges.length, 0),
    totalNewAuthors: findings.reduce((n, f) => n + f.newAuthors.length, 0),
    totalHumanConflicts: findings.reduce((n, f) => n + f.humanConflicts.length, 0),
    totalUnlinkedChpsFaculty: findings.reduce((n, f) => n + f.unlinkedChpsFaculty.length, 0),
    totalDateAddedCorrected: findings.reduce((n, f) => n + (f.dateAddedCorrected ? 1 : 0), 0),
  };

  return { findings, summary };
}

function printReport(findings: ReconcileFinding[], summary: ReconcileSummary, real: boolean) {
  console.log(`Mode: ${real ? "REAL — writes applied" : "DRY RUN — nothing written"}`);
  console.log("─".repeat(72));
  console.log(`Matched (already in production): ${summary.matched}`);
  console.log(`To insert (no match found):       ${summary.toInsert}`);
  console.log(`Author role/link changes:         ${summary.totalAuthorChanges}`);
  console.log(`New authors added to a match:      ${summary.totalNewAuthors}`);
  console.log(`Human-role conflicts (NOT touched):${summary.totalHumanConflicts}`);
  console.log(`chps_faculty authors that couldn't link to a production faculty row: ${summary.totalUnlinkedChpsFaculty}`);
  console.log(`date_added corrected to the edition boundary (${BACKFILL_DATE_ADDED}): ${summary.totalDateAddedCorrected}`);
  console.log("─".repeat(72));

  for (const f of findings) {
    if (f.authorChanges.length === 0 && f.newAuthors.length === 0 && f.humanConflicts.length === 0 && f.unlinkedChpsFaculty.length === 0) continue;
    console.log(`\n${f.pubKey} [${f.matchType}${f.productionId ? ` #${f.productionId}` : ""}] — ${f.title.slice(0, 70)}`);
    for (const c of f.authorChanges) console.log(`  ~ ${c.name}: ${c.before} -> ${c.after}`);
    for (const n of f.newAuthors) console.log(`  + ${n}`);
    for (const c of f.humanConflicts) console.log(`  ! CONFLICT: ${c.name} — production has "${c.productionRole}" (set by ${c.roleSetBy}), fixture says "${c.fixtureRole}" — NOT overwritten`);
    for (const u of f.unlinkedChpsFaculty) console.log(`  ✗ UNLINKED: "${u}" is chps_faculty in the fixture but has no matching production faculty row`);
  }
}

async function main() {
  const { real } = parseArgs(process.argv.slice(2));

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");
  const client = createClient({ url, authToken });

  const fixture = loadGroundTruth();
  const { findings, summary } = await runReconcile(client, fixture, { real });
  printReport(findings, summary, real);

  if (!real) {
    console.log("\nThis was a dry run — nothing was written. Re-run with --real to apply.");
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
