// Read-only review surface (ops-notes.md §5/§6, §13 item 10 follow-up).
// buildAuthorInputs (lib/scholar-ingest.ts) writes role='unknown' with a
// role_set_by tag starting 'ingest:unconfirmed' whenever a name match
// (family + first initial) couldn't be affiliation-confirmed — durably, in
// the same write, regardless of ingestion source. This is the surface that
// makes those durable: the old flagNameOnlyMatches (ingest-crossref.ts,
// retired) only ever printed the same risk to one run's console output.
// Run with: npm run report:unconfirmed-matches
import { config } from "dotenv";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";

config({ path: path.join(__dirname, "..", ".env.local") });

export interface UnconfirmedMatchRow {
  publicationId: number;
  title: string;
  doi: string | null;
  url: string;
  source: string;
  authorName: string;
  facultyId: number | null;
  facultyDisplayName: string | null;
  roleSetBy: string;
}

export async function fetchUnconfirmedMatches(client: Client): Promise<UnconfirmedMatchRow[]> {
  return (
    await client.execute(
      `SELECT p.id as publicationId, p.title, p.doi, p.url, p.source,
              pa.name as authorName, pa.faculty_id as facultyId, f.display_name as facultyDisplayName, pa.role_set_by as roleSetBy
       FROM publication_authors pa
       JOIN publications p ON p.id = pa.publication_id
       LEFT JOIN faculty f ON f.id = pa.faculty_id
       WHERE pa.role_set_by LIKE 'ingest:unconfirmed%'
       ORDER BY p.created_at DESC`
    )
  ).rows as unknown as UnconfirmedMatchRow[];
}

function printReport(rows: UnconfirmedMatchRow[]): void {
  if (rows.length === 0) {
    console.log("No unconfirmed matches found.");
    return;
  }
  console.log(`${rows.length} unconfirmed match(es):\n`);
  for (const r of rows) {
    console.log(`"${r.title}" (publication ${r.publicationId}, source: ${r.source})`);
    console.log(`  candidate: ${r.facultyDisplayName ?? `faculty_id ${r.facultyId}`} — reason: ${r.roleSetBy}`);
    console.log(`  ${r.doi ? `https://doi.org/${r.doi}` : r.url}\n`);
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");

  const client = createClient({ url, authToken });
  const rows = await fetchUnconfirmedMatches(client);
  printReport(rows);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
