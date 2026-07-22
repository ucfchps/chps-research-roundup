// Read-only sweep (ops-notes.md §5/§6 step 6): re-runs the shared
// confirmation gate (buildAuthorInputs, lib/scholar-ingest.ts) against every
// existing role='chps_faculty', role_set_by='ingest' row, regardless of
// publications.source — the real blast-radius number for the gate added in
// this session, not an extrapolation from the one manually-found case
// (publication 96, "Zhu, Y."). Never writes — that's a separate, deliberate
// per-row decision (see the publication-96 UPDATE in ops-notes.md §5).
// Run with: npm run sweep:role-confirmations
import { config } from "dotenv";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { buildAuthorInputs } from "../lib/scholar-ingest";
import type { CrossrefResolution, Faculty } from "../lib/types";

config({ path: path.join(__dirname, "..", ".env.local") });

export interface RoleConfirmationInput {
  publicationId: number;
  title: string;
  doi: string | null;
  source: string;
  facultyId: number;
  facultyDisplayName: string;
}

export type RoleConfirmationOutcome = "still_confirmed" | "no_doi" | "doi_unresolvable" | "no_longer_matched" | "now_unconfirmed";

export interface RoleConfirmationResult {
  input: RoleConfirmationInput;
  outcome: RoleConfirmationOutcome;
  roleSetBy?: string;
}

// Pure-ish: resolveByDoi is injected so this is testable without a network
// call, and so the real script can cache one lookup per unique DOI instead
// of re-resolving it once per author on that DOI.
export async function checkRoleConfirmation(
  row: RoleConfirmationInput,
  roster: Faculty[],
  resolveByDoi: (doi: string) => Promise<CrossrefResolution | null>,
  nowIso: string
): Promise<RoleConfirmationResult> {
  if (!row.doi) return { input: row, outcome: "no_doi" };

  let resolution: CrossrefResolution | null;
  try {
    resolution = await resolveByDoi(row.doi);
  } catch {
    return { input: row, outcome: "doi_unresolvable" };
  }
  if (!resolution) return { input: row, outcome: "doi_unresolvable" };

  const rebuilt = buildAuthorInputs(resolution.authors, roster, nowIso);
  const match = rebuilt.find((a) => a.faculty_id === row.facultyId);
  if (!match) return { input: row, outcome: "no_longer_matched" };
  if (match.role === "chps_faculty") return { input: row, outcome: "still_confirmed" };
  return { input: row, outcome: "now_unconfirmed", roleSetBy: match.role_set_by ?? undefined };
}

async function fetchConfirmedRows(client: Client): Promise<RoleConfirmationInput[]> {
  return (
    await client.execute(
      `SELECT p.id as publicationId, p.title, p.doi, p.source, pa.faculty_id as facultyId, f.display_name as facultyDisplayName
       FROM publication_authors pa
       JOIN publications p ON p.id = pa.publication_id
       JOIN faculty f ON f.id = pa.faculty_id
       WHERE pa.role = 'chps_faculty' AND pa.role_set_by = 'ingest'`
    )
  ).rows as unknown as RoleConfirmationInput[];
}

export async function sweepRoleConfirmations(client: Client, resolveByDoi: (doi: string) => Promise<CrossrefResolution | null>): Promise<RoleConfirmationResult[]> {
  const rows = await fetchConfirmedRows(client);
  const roster = (await client.execute("SELECT * FROM faculty")).rows as unknown as Faculty[];
  const nowIso = new Date().toISOString();

  // Cache one resolution per unique DOI — many rows share a DOI (multiple
  // linked co-authors on the same paper), and Crossref doesn't need asking twice.
  const cache = new Map<string, Promise<CrossrefResolution | null>>();
  function cachedResolve(doi: string): Promise<CrossrefResolution | null> {
    let p = cache.get(doi);
    if (!p) {
      p = resolveByDoi(doi);
      cache.set(doi, p);
    }
    return p;
  }

  const results: RoleConfirmationResult[] = [];
  for (const row of rows) {
    // checkRoleConfirmation short-circuits on !row.doi before ever calling
    // this, so cachedResolve is always safe to pass.
    results.push(await checkRoleConfirmation(row, roster, cachedResolve, nowIso));
  }
  return results;
}

function printReport(results: RoleConfirmationResult[]): void {
  const bySource: Record<string, RoleConfirmationResult[]> = {};
  for (const r of results) (bySource[r.input.source] ??= []).push(r);

  console.log(`${results.length} existing 'chps_faculty'/'ingest' row(s) re-checked against the current confirmation gate.\n`);

  for (const [source, rs] of Object.entries(bySource)) {
    const counts: Record<RoleConfirmationOutcome, number> = { still_confirmed: 0, no_doi: 0, doi_unresolvable: 0, no_longer_matched: 0, now_unconfirmed: 0 };
    for (const r of rs) counts[r.outcome]++;
    // Split now_unconfirmed by WHY — no affiliation data at all (weak/no
    // signal either way) vs. affiliation present but doesn't mention UCF
    // (stronger evidence of a wrong match) are very different urgency
    // levels, and must not be collapsed into one undifferentiated count.
    const noData = rs.filter((r) => r.roleSetBy === "ingest:unconfirmed_name_match").length;
    const conflicting = rs.filter((r) => r.roleSetBy === "ingest:unconfirmed_name_match_conflicting_affiliation").length;
    console.log(
      `[${source}] ${rs.length} checked — ${counts.still_confirmed} still confirmed, ${counts.now_unconfirmed} now unconfirmed ` +
        `(${noData} no affiliation data, ${conflicting} conflicting affiliation), ` +
        `${counts.no_doi} no DOI (unconfirmable), ${counts.doi_unresolvable} DOI unresolvable, ${counts.no_longer_matched} no longer matched`
    );
  }

  const flagged = results.filter((r) => r.outcome === "now_unconfirmed" || r.outcome === "no_doi" || r.outcome === "no_longer_matched");
  if (flagged.length > 0) {
    console.log(`\n${flagged.length} row(s) that would NOT pass the gate today:`);
    for (const r of flagged) {
      const reason = r.roleSetBy ? ` [${r.roleSetBy}]` : "";
      console.log(`  [${r.outcome}]${reason} "${r.input.title}" -> ${r.input.facultyDisplayName} (publication ${r.input.publicationId}, source: ${r.input.source})`);
    }
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");

  const { resolveByDoi } = await import("../lib/crossref");
  const client = createClient({ url, authToken });
  const results = await sweepRoleConfirmations(client, resolveByDoi);
  printReport(results);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
