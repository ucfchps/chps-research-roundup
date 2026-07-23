// Read-only review surface, mirroring scripts/report-unconfirmed-matches.ts's
// shape. §8b's "This isn't my paper" (lib/review-actions.ts::rejectAuthorAttribution)
// writes role_set_by = 'faculty:{id}:rejected' whenever a faculty member
// unlinks a wrong attribution — this is the surface that makes those visible
// to COMMS, since the row itself just quietly reverts to an anonymous,
// unlinked 'unknown' author stub.
// Run with: npm run report:rejected-attributions
import { config } from "dotenv";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";

config({ path: path.join(__dirname, "..", ".env.local") });

export interface RejectedAttributionRow {
  publicationId: number;
  title: string;
  doi: string | null;
  url: string;
  authorName: string;
  roleSetBy: string;
  roleSetAt: string | null;
}

export async function fetchRejectedAttributions(client: Client): Promise<RejectedAttributionRow[]> {
  return (
    await client.execute(
      `SELECT p.id as publicationId, p.title, p.doi, p.url,
              pa.name as authorName, pa.role_set_by as roleSetBy, pa.role_set_at as roleSetAt
       FROM publication_authors pa
       JOIN publications p ON p.id = pa.publication_id
       WHERE pa.role_set_by LIKE 'faculty:%:rejected'
       ORDER BY pa.role_set_at DESC`
    )
  ).rows as unknown as RejectedAttributionRow[];
}

function printReport(rows: RejectedAttributionRow[]): void {
  if (rows.length === 0) {
    console.log("No rejected attributions found.");
    return;
  }
  console.log(`${rows.length} rejected attribution(s):\n`);
  for (const r of rows) {
    console.log(`"${r.title}" (publication ${r.publicationId})`);
    console.log(`  "${r.authorName}" rejected via ${r.roleSetBy} at ${r.roleSetAt}`);
    console.log(`  ${r.doi ? `https://doi.org/${r.doi}` : r.url}\n`);
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");

  const client = createClient({ url, authToken });
  const rows = await fetchRejectedAttributions(client);
  printReport(rows);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
