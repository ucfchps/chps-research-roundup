// Session 19 (§8c Tab 4): a manual, CLI-only safety net for the one
// irreversible write in this system (lib/roundup-finalize.ts::finalizeRoundup).
// Not a substitute for Tab 5's eventual proper archive/un-stamp screen — just
// insurance until that exists, same posture as every other admin capability
// that shipped as a script before its UI (sync-roster, campaign-status,
// settings-email). Clears roundup_id on every publication tied to this
// roundup and DELETES the roundups row itself (a full reversal, not a
// "marked reversed" soft-delete — see lib/roundup-finalize.ts::unstampRoundup).
//
// Run with:
//   npm run roundup:unstamp -- --roundup-id <id> --dry-run
//   npm run roundup:unstamp -- --roundup-id <id>
import { config } from "dotenv";
import path from "node:path";
import { createClient } from "@libsql/client";
import { unstampRoundup } from "../lib/roundup-finalize";

config({ path: path.join(__dirname, "..", ".env.local") });

export function parseArgs(argv: string[]): { roundupId: number | null; dryRun: boolean } {
  const idFlag = argv.find((a) => a === "--roundup-id" || a.startsWith("--roundup-id="));
  let roundupId: number | null = null;
  if (idFlag) {
    const raw = idFlag.includes("=") ? idFlag.split("=")[1] : argv[argv.indexOf(idFlag) + 1];
    roundupId = raw ? Number(raw) : null;
  }

  return { roundupId, dryRun: argv.includes("--dry-run") };
}

async function main() {
  const { roundupId, dryRun } = parseArgs(process.argv.slice(2));
  if (!roundupId) throw new Error("Usage: npm run roundup:unstamp -- --roundup-id <id> [--dry-run]");

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");
  const client = createClient({ url, authToken });

  const summary = await unstampRoundup(client, roundupId, { dryRun });

  console.log(`Roundup #${summary.roundupId} ("${summary.label}") — ${summary.publicationIds.length} publication(s): ${summary.publicationIds.join(", ") || "(none)"}`);
  if (dryRun) {
    console.log("Dry run — no changes made.");
  } else {
    console.log("Reversed: roundup_id cleared on all listed publications, roundups row deleted.");
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
