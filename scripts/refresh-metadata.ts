// Keeps already-ingested citations from going stale or shipping permanently
// incomplete (§9). Run with: npm run refresh:metadata
// Exits non-zero if any record hit CrossrefUnavailableError — a transient
// Crossref outage must never be mistaken for "nothing to update."
import { config } from "dotenv";
import path from "node:path";
import { createClient } from "@libsql/client";

config({ path: path.join(__dirname, "..", ".env.local") });

function printList(title: string, items: { id: number; title: string }[]) {
  if (items.length === 0) return;
  console.log(`\n${title}:`);
  for (const item of items) console.log(`  [${item.id}] ${item.title}`);
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");
  }

  const client = createClient({ url, authToken });

  // Dynamic import: lib/refresh-metadata.ts pulls in lib/crossref.ts, which
  // reads CROSSREF_MAILTO at import time — a static import here would be
  // hoisted above config() (same reason scripts/check-ai.ts does this).
  const { refreshMetadata } = await import("../lib/refresh-metadata");
  const result = await refreshMetadata(client);

  console.log(`Checked ${result.checkedIncomplete} incomplete record(s); filled ${result.updatedIncomplete}.`);
  console.log(`Checked ${result.checkedPopulated} already-populated record(s); flagged ${result.flaggedMismatches.length} mismatch(es).`);
  console.log(`${result.stillIncomplete.length} still incomplete after this run.`);
  console.log(`${result.errored.length} errored (Crossref unavailable).`);

  printList("Still incomplete — may publish truncated", result.stillIncomplete);
  printList("Newly flagged volume, issue, or pages mismatches — review before publishing", result.flaggedMismatches);
  printList("Errored — Crossref unavailable, will retry next run", result.errored);

  if (result.errored.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
