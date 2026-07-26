// Session 21 (§13.24 operational backfill) — Task C: finalize the 2025
// edition into PRODUCTION. This is the one irreversible write in the whole
// system (lib/roundup-finalize.ts::finalizeRoundup) — ONLY run this after
// Task A (scripts/backfill-reconcile-2025.ts) and Task B
// (scripts/backfill-verify-production-2025.ts) both report clean.
//
// Chen, X.S.'s 5 papers (2060, 2061, 2062, 2544, 2549) are deliberately
// EXCLUDED from the stamped set — Chen is left unlinked (no faculty_id), so
// these derive no unit and never appear in the generated HTML at all.
// finalizeRoundup has no unit-awareness of its own (see lib/roundup-finalize.ts
// and app/admin/publications/FinalizePanel.tsx — a checked-by-default
// checkbox is the ONLY thing that keeps a zero-unit publication out of the
// stamped set in the web UI); since this is a CLI run with no such
// checkbox, EXCLUDED_PUBLICATION_IDS below is this script's own equivalent —
// built and asserted explicitly, not left to fall out of some other query.
// Master plan §6 ROLES, "Open follow-up (Session 21): Chen, X.S.'s identity
// is unresolved" tracks getting these 5 into a future edition once Chen is
// properly linked.
//
// Requires the exact edition label typed back via --confirm-label, mirroring
// the admin UI's "type it back to confirm" gate (app/admin/publications/
// finalize-shared.ts::parseFinalizeFormData) — the CLI has no checkbox UI to
// review before submitting, so this is the only thing standing between a
// stray invocation and a permanent write.
//
// --dry-run is the DEFAULT (writes nothing) — pass --real AND
// --confirm-label "<exact edition label>" to actually finalize.
//
// Run with:
//   npx tsx scripts/backfill-finalize-2025.ts                                                  (dry run)
//   npx tsx scripts/backfill-finalize-2025.ts --real --confirm-label "Spring and Summer 2025"   (writes)
import { config } from "dotenv";
import path from "node:path";
config({ path: path.join(__dirname, "..", ".env.local") });
import { createClient } from "@libsql/client";
import { loadGroundTruth } from "../lib/backfill-seed";
import { queryPublications } from "../lib/publications";
import { finalizeRoundup } from "../lib/roundup-finalize";

const CUTOFF_DATE = "2025-06-30";
const GENERATED_BY = "backfill-finalize-2025 CLI (Session 21)";

// Chen, X.S. is deliberately unlinked (no faculty_id) — see the file-level
// comment above and master plan §6 ROLES. Each of these derives zero units
// and must NOT be stamped into this edition.
const EXCLUDED_PUBLICATION_IDS = [2060, 2061, 2062, 2544, 2549];

export function parseArgs(argv: string[]): { real: boolean; confirmLabel: string | null } {
  const real = argv.includes("--real");
  const flagIndex = argv.findIndex((a) => a === "--confirm-label");
  const confirmLabel = flagIndex !== -1 ? (argv[flagIndex + 1] ?? null) : null;
  return { real, confirmLabel };
}

async function main() {
  const { real, confirmLabel } = parseArgs(process.argv.slice(2));

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");
  const client = createClient({ url, authToken });

  const fixture = loadGroundTruth();

  const eligible = await queryPublications(client, { status: ["published"], excludeAlreadyPosted: true, dateAddedTo: CUTOFF_DATE });
  const eligibleIds = eligible.map((r) => r.publication.id);

  const excludedFoundInEligible = EXCLUDED_PUBLICATION_IDS.filter((id) => eligibleIds.includes(id));
  const publicationIds = eligibleIds.filter((id) => !EXCLUDED_PUBLICATION_IDS.includes(id));

  console.log("─".repeat(72));
  console.log(`Edition: "${fixture.edition.label}"`);
  console.log(`Eligible publications (§6b, cutoff ${CUTOFF_DATE}): ${eligibleIds.length}`);
  console.log(`Excluded (Chen, X.S. unlinked — no unit, see master plan §6 ROLES): ${excludedFoundInEligible.length} — ${excludedFoundInEligible.join(", ")}`);
  console.log(`Will be stamped into this edition: ${publicationIds.length}`);
  console.log(`Full excluded id list: [${EXCLUDED_PUBLICATION_IDS.join(", ")}]`);
  console.log(`Full publicationIds (${publicationIds.length}): [${[...publicationIds].sort((a, b) => a - b).join(", ")}]`);
  console.log("─".repeat(72));

  if (excludedFoundInEligible.length !== EXCLUDED_PUBLICATION_IDS.length) {
    throw new Error(
      `Expected all ${EXCLUDED_PUBLICATION_IDS.length} excluded ids to be present in the eligible set (sanity check that they're still where Task B found them); ` +
        `found ${excludedFoundInEligible.length}. ABORTING — investigate before running again.`
    );
  }
  if (publicationIds.length !== 150) {
    throw new Error(`Expected exactly 150 publications to stamp (155 eligible - 5 excluded), got ${publicationIds.length}. ABORTING.`);
  }
  for (const id of EXCLUDED_PUBLICATION_IDS) {
    if (publicationIds.includes(id)) throw new Error(`Excluded id ${id} leaked into publicationIds — ABORTING, this must never happen.`);
  }

  if (!real) {
    console.log("DRY RUN — would call finalizeRoundup with the above publicationIds. Nothing written.");
    console.log('Re-run with --real --confirm-label "<exact edition label>" to actually finalize.');
    return;
  }

  if (confirmLabel !== fixture.edition.label) {
    throw new Error(
      `--confirm-label must exactly match the edition label ("${fixture.edition.label}"). Got: ${confirmLabel === null ? "(not provided)" : `"${confirmLabel}"`}. ABORTING — nothing written.`
    );
  }

  console.log("Confirmation matched. Finalizing for real...");
  const result = await finalizeRoundup(client, {
    label: fixture.edition.label,
    generatedBy: GENERATED_BY,
    cutoffDate: CUTOFF_DATE,
    title: fixture.edition.title,
    intro: fixture.edition.intro,
    legendLine: fixture.edition.legend,
    publicationIds,
  });

  console.log(`Finalized: roundup #${result.roundupId}, ${result.pubCount} publications stamped.`);
  if (result.pubCount !== 150) {
    console.log(`✗ WARNING: expected 150 stamped, got ${result.pubCount} — investigate before trusting this roundup.`);
  }

  const roundupsCountRow = (await client.execute("SELECT COUNT(*) as c FROM roundups")).rows[0] as unknown as { c: number };
  console.log(`roundups table now has ${roundupsCountRow.c} row(s) total.`);

  const stampedRows = (await client.execute({ sql: "SELECT id FROM publications WHERE roundup_id = ?", args: [result.roundupId] })).rows as unknown as Array<{
    id: number;
  }>;
  const stampedIds = stampedRows.map((r) => r.id).sort((a, b) => a - b);
  const expectedIds = [...publicationIds].sort((a, b) => a - b);
  const stampedMatchesExpected = JSON.stringify(stampedIds) === JSON.stringify(expectedIds);
  console.log(`Stamped set equals the intended publicationIds: ${stampedMatchesExpected}`);

  const stillEligible = await queryPublications(client, { status: ["published"], excludeAlreadyPosted: true, dateAddedTo: CUTOFF_DATE });
  const anyStampedStillEligible = stillEligible.some((r) => stampedIds.includes(r.publication.id));
  console.log(`Any just-stamped publication still eligible (§6b re-query — must be false): ${anyStampedStillEligible}`);
  console.log(`Chen's 5 excluded ids still eligible for a future edition: ${EXCLUDED_PUBLICATION_IDS.every((id) => stillEligible.some((r) => r.publication.id === id))}`);

  console.log("─".repeat(72));
  console.log("To reverse this finalize:");
  console.log(`  npm run roundup:unstamp -- --roundup-id ${result.roundupId} --dry-run`);
  console.log(`  npm run roundup:unstamp -- --roundup-id ${result.roundupId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
