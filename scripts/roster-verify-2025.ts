// Session 21 (§13.24 operational backfill): the executable form of
// roster-verify-2025.sql — turso CLI login wasn't available in this
// session, so this runs the same checks via this project's own
// TURSO_DATABASE_URL/TURSO_AUTH_TOKEN (production), read-only. Confirms
// every ground-truth-2025.json faculty member exists in the real roster
// (no active=1 filter — departed faculty can still be a 2025 paper's real
// author) and specifically re-checks the five home-unit assignments
// Session 20 resolved without production access.
import { config } from "dotenv";
import path from "node:path";
config({ path: path.join(__dirname, "..", ".env.local") });
import { createClient } from "@libsql/client";
import { loadGroundTruth } from "../lib/backfill-seed";

const AMBIGUOUS_KEYS = ["anderson-aw", "anderson-km", "brazendale", "jeune", "neely", "yalim"];

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");
  const client = createClient({ url, authToken });

  const fixture = loadGroundTruth();

  console.log("=== The five ambiguous home-unit assignments (Session 20 resolved without production access) ===");
  for (const key of AMBIGUOUS_KEYS) {
    const f = fixture.faculty.find((f) => f.key === key);
    if (!f) continue;
    const rows = (
      await client.execute({ sql: "SELECT display_name, unit, active FROM faculty WHERE display_name = ?", args: [f.display_name] })
    ).rows as unknown as Array<{ display_name: string; unit: string | null; active: number }>;
    const match = rows[0];
    const agree = match && match.unit === f.unit;
    console.log(
      `${key}: fixture says "${f.unit}" — production ${match ? `says "${match.unit}" (active=${match.active}) ${agree ? "✓ agrees" : "✗ DISAGREES"}` : "✗ NO MATCHING ROW"}`
    );
  }

  console.log("\n=== Full fixture faculty roster check (no active filter) ===");
  let missing = 0;
  let unitMismatch = 0;
  for (const f of fixture.faculty) {
    const rows = (
      await client.execute({ sql: "SELECT display_name, unit, active FROM faculty WHERE display_name = ?", args: [f.display_name] })
    ).rows as unknown as Array<{ display_name: string; unit: string | null; active: number }>;
    if (rows.length === 0) {
      console.log(`  ✗ MISSING: "${f.display_name}" (fixture unit: ${f.unit})`);
      missing++;
      continue;
    }
    if (rows[0].unit !== f.unit) {
      console.log(`  ⚠ UNIT MISMATCH: "${f.display_name}" — fixture says "${f.unit}", production says "${rows[0].unit}"`);
      unitMismatch++;
    }
  }
  console.log(`\n${fixture.faculty.length - missing} of ${fixture.faculty.length} fixture faculty found in production; ${missing} missing, ${unitMismatch} unit mismatches.`);

  console.log("\n=== CARD faculty currently in production ===");
  const card = (
    await client.execute("SELECT display_name, unit, active FROM faculty WHERE unit = 'Center for Autism and Related Disabilities'")
  ).rows;
  console.log(card);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
