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
import { resolveFacultyLink } from "./backfill-reconcile-2025";
import type { Faculty } from "../lib/types";

const AMBIGUOUS_KEYS = ["anderson-aw", "anderson-km", "brazendale", "jeune", "neely", "yalim"];

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");
  const client = createClient({ url, authToken });

  const fixture = loadGroundTruth();
  // One fetch, reused for every lookup below — resolveFacultyLink (the same
  // tolerant matcher — initials, diacritics, LINK_NAME_OVERRIDES — that the
  // reconcile script and live ingestion use) replaces the raw exact-string
  // `display_name = ?` query this script used to run per fixture entry,
  // which overstated real roster gaps by counting extra-initial and
  // diacritic name-form differences as missing rows.
  const facultyRows = (await client.execute("SELECT * FROM faculty")).rows as unknown as Faculty[];

  console.log("=== The five ambiguous home-unit assignments (Session 20 resolved without production access) ===");
  for (const key of AMBIGUOUS_KEYS) {
    const f = fixture.faculty.find((f) => f.key === key);
    if (!f) continue;
    const match = resolveFacultyLink(f.display_name, facultyRows);
    const agree = match && match.unit === f.unit;
    console.log(
      `${key}: fixture says "${f.unit}" — production ${match ? `says "${match.unit}" (active=${match.active}) ${agree ? "✓ agrees" : "✗ DISAGREES"}` : "✗ NO MATCHING ROW"}`
    );
  }

  console.log("\n=== Full fixture faculty roster check (no active filter) ===");
  let missing = 0;
  let unitMismatch = 0;
  for (const f of fixture.faculty) {
    const match = resolveFacultyLink(f.display_name, facultyRows);
    if (!match) {
      console.log(`  ✗ MISSING: "${f.display_name}" (fixture unit: ${f.unit})`);
      missing++;
      continue;
    }
    if (match.unit !== f.unit) {
      console.log(`  ⚠ UNIT MISMATCH: "${f.display_name}" — fixture says "${f.unit}", production says "${match.unit}"`);
      unitMismatch++;
    }
  }
  console.log(`\n${fixture.faculty.length - missing} of ${fixture.faculty.length} fixture faculty found in production; ${missing} missing, ${unitMismatch} unit mismatches.`);

  console.log("\n=== CARD faculty currently in production ===");
  const card = facultyRows
    .filter((f) => f.unit === "Center for Autism and Related Disabilities")
    .map((f) => ({ display_name: f.display_name, unit: f.unit, active: f.active }));
  console.log(card);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
