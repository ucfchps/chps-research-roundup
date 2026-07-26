// Full-database backup utility. Connects to TURSO_DATABASE_URL/TURSO_AUTH_TOKEN
// (production, unless overridden) and dumps every real table's complete row
// set to a single timestamped JSON file under backups/ (gitignored — this
// contains real faculty PII). The real rollback for a bulk write like
// Session 21's reconcile; scripts/unstamp-roundup.ts only reverses a single
// finalize, not a bulk merge/insert pass.
//
// Run with: npm run backup:db -- [--out <path>]
import { config } from "dotenv";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";

config({ path: path.join(__dirname, "..", ".env.local") });

// Every real table this project's migrations create, in FK-safe dump order
// (parents before children) — not that order matters for a JSON dump, but
// it matches how a restore script would need to re-insert them.
const TABLES = [
  "faculty",
  "publications",
  "publication_authors",
  "pending_submissions",
  "review_requests",
  "roundups",
  "usage_log",
  "metadata_mismatches",
  "possible_duplicates",
  "citation_edits",
  "settings",
];

export function parseArgs(argv: string[]): { outPath: string | null } {
  const outFlag = argv.find((a) => a === "--out" || a.startsWith("--out="));
  if (!outFlag) return { outPath: null };
  const outPath = outFlag.includes("=") ? outFlag.split("=")[1] : argv[argv.indexOf(outFlag) + 1];
  return { outPath: outPath ?? null };
}

async function main() {
  const { outPath } = parseArgs(process.argv.slice(2));

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");
  const client = createClient({ url, authToken });

  const dump: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    const result = await client.execute(`SELECT * FROM ${table}`);
    dump[table] = result.rows as unknown as unknown[];
    console.log(`${table}: ${result.rows.length} rows`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const finalPath = outPath ?? path.join(__dirname, "..", "backups", `backup-${timestamp}.json`);
  mkdirSync(path.dirname(finalPath), { recursive: true });
  writeFileSync(finalPath, JSON.stringify({ takenAt: new Date().toISOString(), tables: dump }, null, 2), "utf-8");

  console.log(`\nBackup written to ${finalPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
