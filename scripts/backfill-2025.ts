// Session 20 (§13.24): the whole-system acceptance test, runnable as a
// human-readable CLI report. Everything this script does also runs as real
// vitest assertions in tests/backfill.test.ts (npm test) — this file is the
// same story, printed for a person instead of asserted for CI.
//
// CLEAN-ROOM ONLY. This script creates/uses a local scratch libSQL file
// (.scratch/backfill-2025.db, gitignored) and NEVER reads TURSO_DATABASE_URL
// / TURSO_AUTH_TOKEN or otherwise touches production. Safe to delete
// .scratch/ and re-run at any time — seedGroundTruth resets its own tables
// on every run.
//
// Run with: npm run backfill:test
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { loadGroundTruth, seedGroundTruth } from "../lib/backfill-seed";
import { queryPublications } from "../lib/publications";
import { buildExportHtml } from "../lib/roundup-export";
import { finalizeRoundup, unstampRoundup } from "../lib/roundup-finalize";
import { compareEditions, parseEditionHtml } from "../lib/backfill-diff";
import { UNITS } from "../lib/types";

const CUTOFF_DATE = "2025-06-30";
const SCRATCH_DIR = path.join(__dirname, "..", ".scratch");
const SCRATCH_DB_PATH = path.join(SCRATCH_DIR, "backfill-2025.db");

function line() {
  console.log("─".repeat(72));
}

async function main() {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const client = createClient({ url: `file:${SCRATCH_DB_PATH}` });
  await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));

  const fixture = loadGroundTruth();
  const seedSummary = await seedGroundTruth(client, fixture);

  console.log("Session 20 backfill acceptance test (§13.24) — clean-room, scratch DB only");
  console.log("Scratch DB:", SCRATCH_DB_PATH);
  line();
  console.log(
    `Seeded: ${seedSummary.facultyCount} faculty, ${seedSummary.publicationCount} publications, ${seedSummary.authorCount} authors`
  );

  const eligible = await queryPublications(client, {
    status: ["published"],
    excludeAlreadyPosted: true,
    dateAddedTo: CUTOFF_DATE,
  });
  const generatedHtml = buildExportHtml({
    title: fixture.edition.title,
    intro: fixture.edition.intro,
    legend: fixture.edition.legend,
    publications: eligible,
  });

  const livePostHtml = readFileSync(path.join(__dirname, "..", "tests", "fixtures", "backfill", "live-post-2025.html"), "utf-8");
  const report = compareEditions(parseEditionHtml(generatedHtml), parseEditionHtml(livePostHtml), fixture);

  line();
  console.log("TASK B — reproduce & diff");
  line();
  const canonicalPresent = UNITS.filter((u) => report.unitsInGenerated.includes(u));
  console.log(`Units reproduced: ${report.unitsInGenerated.length}/${report.unitsInLivePost.length} (canonical order: ${
    report.unitsInGenerated.length === canonicalPresent.length ? "yes" : "NO"
  })`);
  for (const u of report.unitsInGenerated) console.log(`  ✓ ${u}`);
  for (const m of report.missingUnitsKnown) console.log(`  ⚠ ${m.unit} — KNOWN GAP: ${m.reason}`);
  for (const u of report.missingUnitsUnexplained) console.log(`  ✗ ${u} — UNEXPLAINED (hard failure)`);

  console.log(`\nPublications reproduced: ${eligible.length - report.noFacultyPapers.length}/${eligible.length}`);
  console.log(`§6a "no CHPS author" cases (correctly excluded, not silently dropped): ${report.noFacultyPapers.length}`);
  for (const p of report.noFacultyPapers) console.log(`  - ${p.pubKey}: ${p.title}`);

  console.log(`\nMulti-unit papers (§6a identical-bolding guarantee): ${report.multiUnitPapers.length}`);
  for (const p of report.multiUnitPapers) console.log(`  ${p.consistent ? "✓" : "✗"} ${p.pubKey}`);

  console.log(`\nAwan same-unit duplicate (§7 dedup guarantee): renders ${report.awanDuplicateCount} time(s) (expect 1)`);

  console.log(`\nExpected diffs confirmed (both directions): ${report.expectedDiffsConfirmed.length}`);
  console.log(`Expected diffs NOT confirmed (fixture claims a diff reality doesn't match): ${report.expectedDiffsNotConfirmed.length}`);
  for (const d of report.expectedDiffsNotConfirmed) console.log(`  ✗ ${d.pubKey} [${d.unit}] ${d.field}: generated=${d.generated} post=${d.postSaid}`);

  console.log(`\nUNEXPECTED DIFFS: ${report.unexpectedDiffs.length} (must be zero to pass)`);
  for (const d of report.unexpectedDiffs) console.log(`  ✗ ${d.pubKey} [${d.unit}] ${d.field}: generated=${JSON.stringify(d.generated)} post=${JSON.stringify(d.postSaid)}`);

  line();
  console.log("TASK C — finalize / unstamp round-trip");
  line();
  const includedIds = eligible.map((r) => r.publication.id);
  const finalizeResult = await finalizeRoundup(client, {
    label: fixture.edition.label,
    generatedBy: "backfill-2025 CLI",
    cutoffDate: CUTOFF_DATE,
    title: fixture.edition.title,
    intro: fixture.edition.intro,
    legendLine: fixture.edition.legend,
    publicationIds: includedIds,
  });
  const htmlMatches = (await client.execute({ sql: "SELECT html FROM roundups WHERE id = ?", args: [finalizeResult.roundupId] }))
    .rows[0]?.html === generatedHtml;
  console.log(`Finalized: roundup #${finalizeResult.roundupId}, ${finalizeResult.pubCount} publications stamped, html matches Task B output: ${htmlMatches}`);

  const stillEligible = await queryPublications(client, { status: ["published"], excludeAlreadyPosted: true, dateAddedTo: CUTOFF_DATE });
  console.log(`Double-post guarantee: ${stillEligible.length} publications still eligible after finalize (expect 0)`);

  const dryRun = await unstampRoundup(client, finalizeResult.roundupId, { dryRun: true });
  console.log(`Unstamp --dry-run: reports ${dryRun.publicationIds.length} publication(s), no changes made`);

  await unstampRoundup(client, finalizeResult.roundupId, { dryRun: false });
  const reEligible = await queryPublications(client, { status: ["published"], excludeAlreadyPosted: true, dateAddedTo: CUTOFF_DATE });
  console.log(`Unstamp for real: ${reEligible.length}/${includedIds.length} publications eligible again (safety net ${
    reEligible.length === includedIds.length ? "WORKS" : "FAILED"
  })`);

  line();
  const pass =
    report.missingUnitsUnexplained.length === 0 &&
    report.expectedDiffsNotConfirmed.length === 0 &&
    report.unexpectedDiffs.length === 0 &&
    report.multiUnitPapers.every((p) => p.consistent) &&
    report.awanDuplicateCount === 1 &&
    htmlMatches &&
    stillEligible.length === 0 &&
    reEligible.length === includedIds.length;

  console.log(pass ? "PASS — the generator reproduces the real post, and finalize/unstamp round-trips cleanly." : "FAIL — see findings above.");
  client.close();
  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
