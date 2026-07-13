// Scholar-alert coverage report. See amended master plan §11. Run with:
// npm run report:coverage
import { config } from "dotenv";
import path from "node:path";
import { createClient } from "@libsql/client";
import { getAlertCoverage, type CoverageReport } from "../lib/coverage";
import type { Faculty } from "../lib/types";

config({ path: path.join(__dirname, "..", ".env.local") });

function printBucket(title: string, faculty: Faculty[]) {
  console.log(`\n${title} (${faculty.length})`);
  for (const f of faculty) {
    console.log(`  ${f.display_name}  (wp_id ${f.wp_id}${f.email ? `, ${f.email}` : ""})`);
  }
}

export function printCoverageReport(report: CoverageReport) {
  // Actionable to-dos first.
  printBucket("Alert likely not created — please verify", report.alert_likely_not_created);
  printBucket("Fix this directory link (broken or unrecognized profile URL)", report.fix_directory_link);

  // Permanent facts, worded as facts — not to-dos (§11).
  printBucket("No Scholar coverage — profile is not Google Scholar (not actionable)", report.not_google_scholar);
  printBucket("No Scholar coverage — no research profile linked in the directory", report.no_profile_at_all);

  console.log(`\nWorking as intended (${report.working.length})`);

  if (report.emptyUnits.length > 0) {
    console.log(`\n⚠ Canonical unit(s) with ZERO roster members — a real gap, not a to-do list item:`);
    for (const unit of report.emptyUnits) console.log(`  ${unit}`);
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");
  }

  const client = createClient({ url, authToken });
  const report = await getAlertCoverage(client);
  printCoverageReport(report);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
