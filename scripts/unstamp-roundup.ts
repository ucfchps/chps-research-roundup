// Session 19 (§8c Tab 4), still current after Session 24's Tab 5 archive UI
// shipped: a CLI entry point for reversing the one irreversible write in this
// system (lib/roundup-finalize.ts::finalizeRoundup). Tab 5 (app/admin/archive)
// now offers the same reversal through a guarded UI — both call
// lib/roundup-finalize.ts::unstampRoundup, the one implementation, so this
// script and the UI can never drift on the inverse of the double-post
// guarantee. Clears roundup_id on every publication tied to this roundup and
// DELETES the roundups row itself (a full reversal, not a "marked reversed"
// soft-delete). Idempotent: a nonexistent or already-reversed id is a clean
// no-op, not an error.
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

  if (summary.noop) {
    console.log(`No roundup found with id ${summary.roundupId} — nothing to do.`);
    return;
  }

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
