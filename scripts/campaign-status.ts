// Stand-in for §8c Tab 3's response dashboard until the /admin UI (build-order
// item 15) exists — same role as coverage-report.ts / report-unconfirmed-matches.ts
// for their respective screens. Prints, for a given cycle: total sent, opened,
// completed, and who hasn't opened yet (the input a single targeted reminder,
// §8b, would be built from later — sending that reminder is not this script's job).
//
// Run with: npm run campaign:status -- --cycle-label "<label>"
import { config } from "dotenv";
import path from "node:path";
import { createClient } from "@libsql/client";
import { getCampaignStatus, type CampaignStatus } from "../lib/campaigns";

config({ path: path.join(__dirname, "..", ".env.local") });

export function parseArgs(argv: string[]): { cycleLabel: string | null } {
  const cycleLabelFlag = argv.find((a) => a === "--cycle-label" || a.startsWith("--cycle-label="));
  if (!cycleLabelFlag) return { cycleLabel: null };
  const cycleLabel = cycleLabelFlag.includes("=") ? cycleLabelFlag.split("=")[1] : (argv[argv.indexOf(cycleLabelFlag) + 1] ?? null);
  return { cycleLabel };
}

function printStatus(s: CampaignStatus): void {
  console.log(`Cycle: "${s.cycleLabel}"`);
  console.log(`Sent: ${s.totalSent}`);
  console.log(`Opened: ${s.openedCount}`);
  console.log(`Completed: ${s.completedCount}`);

  if (s.totalSent > 0 && s.openedCount === 0 && s.completedCount === 0) {
    console.log(`\n★ 0 opened and 0 completed — this is an honest read of opened_at/completed_at, not a tracking bug.`);
  }

  if (s.notYetOpened.length > 0) {
    console.log(`\n${s.notYetOpened.length} sent a link but haven't opened it yet:`);
    for (const e of s.notYetOpened) console.log(`  ${e.displayName} (${e.email ?? "no email on file"})`);
  }
}

async function main() {
  const { cycleLabel } = parseArgs(process.argv.slice(2));
  if (!cycleLabel) throw new Error('Usage: npm run campaign:status -- --cycle-label "<label>"');

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");

  const client = createClient({ url, authToken });
  const status = await getCampaignStatus(client, cycleLabel);
  printStatus(status);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
