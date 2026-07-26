// Session 21 (§13.24 operational backfill) — promotes the remaining
// non-published fixture-matched publications to 'published', per explicit
// user direction ("Promote all 46 to 'published' as part of this backfill").
//
// 43 are 'pending_merge' with complete metadata already (they were fully
// resolved by real ingest, just sitting past the merge buffer) — status
// flip only, nothing else to fill in.
//
// 3 are 'needs_metadata' with null journal/volume/issue/pages in production;
// the fixture (ground-truth-2025.json, human-verified) has complete values
// for two of them. The third (the SBM position statement, id 116) has no
// volume/issue/pages in the fixture either — confirmed independently by the
// user as legitimate: policy statements aren't paginated that way, this
// isn't missing data. Journal is filled in; volume/issue/pages stay null.
//
// --dry-run is the DEFAULT (writes nothing) — pass --real to actually write.
// Idempotent: a second run finds these already 'published' and reports
// "already promoted" rather than erroring.
//
// Usage:
//   npx tsx scripts/backfill-promote-2025.ts             (dry run)
//   npx tsx scripts/backfill-promote-2025.ts --real      (writes)
import { config } from "dotenv";
import path from "node:path";
config({ path: path.join(__dirname, "..", ".env.local") });
import { createClient, type Client } from "@libsql/client";

const PENDING_MERGE_IDS = [
  1228, 1184, 1186, 1332, 1430, 1582, 1337, 1334, 1255, 1331, 1361, 1201, 1506, 1460, 1464, 1497, 1309, 1369, 1443, 1363, 1204, 1437, 1362, 1402, 1440,
  1445, 1203, 1199, 1467, 1465, 1469, 1588, 1100, 1426, 1696, 1695, 2061, 2060, 2062, 1691, 1259, 1398, 1209,
];

interface MetadataFill {
  id: number;
  journal: string;
  volume: string | null;
  issue: string | null;
  pages: string | null;
}

const NEEDS_METADATA_FILLS: MetadataFill[] = [
  { id: 116, journal: "Society of Behavioral Medicine Position Statement", volume: null, issue: null, pages: null },
  { id: 131, journal: "Advances in Geriatric Medicine and Research", volume: "7", issue: "2", pages: "e250010" },
  { id: 136, journal: "Journal of Applied Physiology", volume: "139", issue: "1", pages: "81-90" },
];

async function fetchStatus(client: Client, id: number): Promise<string | null> {
  const result = await client.execute({ sql: "SELECT status FROM publications WHERE id = ?", args: [id] });
  const row = result.rows[0] as unknown as { status: string } | undefined;
  return row?.status ?? null;
}

async function main() {
  const real = process.argv.includes("--real");
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");
  const client = createClient({ url, authToken });

  let promoted = 0;
  let alreadyDone = 0;
  let unexpected = 0;

  console.log(`--- pending_merge -> published (${PENDING_MERGE_IDS.length} publications) ---`);
  for (const id of PENDING_MERGE_IDS) {
    const status = await fetchStatus(client, id);
    if (status === null) {
      console.log(`✗ pub ${id}: not found — SKIPPING`);
      unexpected++;
      continue;
    }
    if (status === "published") {
      console.log(`~ pub ${id}: already published`);
      alreadyDone++;
      continue;
    }
    if (status !== "pending_merge") {
      console.log(`✗ pub ${id}: expected pending_merge, found "${status}" — SKIPPING`);
      unexpected++;
      continue;
    }
    console.log(`${real ? "APPLYING" : "would apply"} pub ${id}: pending_merge -> published`);
    if (real) {
      await client.execute({ sql: "UPDATE publications SET status = 'published' WHERE id = ?", args: [id] });
    }
    promoted++;
  }

  console.log(`\n--- needs_metadata -> published, with metadata fill (${NEEDS_METADATA_FILLS.length} publications) ---`);
  for (const fill of NEEDS_METADATA_FILLS) {
    const status = await fetchStatus(client, fill.id);
    if (status === null) {
      console.log(`✗ pub ${fill.id}: not found — SKIPPING`);
      unexpected++;
      continue;
    }
    if (status === "published") {
      console.log(`~ pub ${fill.id}: already published`);
      alreadyDone++;
      continue;
    }
    if (status !== "needs_metadata") {
      console.log(`✗ pub ${fill.id}: expected needs_metadata, found "${status}" — SKIPPING`);
      unexpected++;
      continue;
    }
    console.log(
      `${real ? "APPLYING" : "would apply"} pub ${fill.id}: needs_metadata -> published, ` +
        `journal="${fill.journal}", volume=${fill.volume}, issue=${fill.issue}, pages=${fill.pages}`
    );
    if (real) {
      await client.execute({
        sql: "UPDATE publications SET status = 'published', journal = ?, volume = ?, issue = ?, pages = ? WHERE id = ?",
        args: [fill.journal, fill.volume, fill.issue, fill.pages, fill.id],
      });
    }
    promoted++;
  }

  console.log("─".repeat(72));
  console.log(`${real ? "Promoted" : "Would promote"}: ${promoted}, already published: ${alreadyDone}, unexpected: ${unexpected}`);
  if (unexpected > 0) process.exitCode = 1;
  if (!real) console.log("This was a dry run — nothing was written. Re-run with --real to apply.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
