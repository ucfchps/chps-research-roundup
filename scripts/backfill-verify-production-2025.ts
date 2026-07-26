// Session 21 (§13.24 operational backfill) — Task B: generate the 2025
// edition from PRODUCTION (real queryPublications + buildExportHtml, same
// as the admin generator would) and compare it against a FRESH Session 20
// clean-room reproduction (same fixture, throwaway scratch DB). Any
// difference means production carries data the fixture didn't — this
// script lists it and never finalizes anything; that's Task C, gated on a
// human reading this report.
//
// Read-only against production (only SELECTs — queryPublications never
// writes). The clean-room half uses its own throwaway temp-file DB, seeded
// and discarded within this run.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "dotenv";
config({ path: path.join(__dirname, "..", ".env.local") });
import { createClient } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { loadGroundTruth, seedGroundTruth, type GroundTruthPublication } from "../lib/backfill-seed";
import { queryPublications } from "../lib/publications";
import { buildExportHtml } from "../lib/roundup-export";
import {
  parseEditionHtml,
  isProductionMetadataUpgradeField,
  normalizeTitleForMatch,
  applyAuthorDedupOverridesToText,
  type RawCitation,
} from "../lib/backfill-diff";
import { normalizeAuthorName } from "../lib/matching";

const CUTOFF_DATE = "2025-06-30";

function citationKey(c: RawCitation): string {
  return `${normalizeTitleForMatch(c.title)}::${c.unitName}`;
}

interface FieldDiff {
  field: string;
  cleanRoom: string;
  production: string;
}

// Author segment (plain, tags stripped) and year are content — a
// difference there means a real disagreement (wrong match, wrong data) and
// is never allowlisted. journal/url/tail/title differences, once author
// and year both agree, are the expected shape of "production's real
// Crossref/PubMed data is more complete than the human-transcribed
// fixture" (§13.24 Task B) — see isProductionMetadataUpgradeField. The
// clean room's author text is first rewritten through
// AUTHOR_DEDUP_OVERRIDES (same map Task A's reconcile uses) so a name-FORMAT
// difference for an already-verified same person doesn't show up as a
// content diff — a genuine author-list difference (addition, removal,
// reorder) still will. Author equality itself uses normalizeAuthorName
// (lib/matching.ts) applied to the whole joined segment — the exact same
// whitespace/case-insensitive comparison Task A's mergeAuthors already
// trusts for deduping, so a citation that's ALL CAPS in production (a
// pre-existing ingest data-quality quirk) or has different internal initial
// spacing doesn't read as a content disagreement.
function diffCitationFields(pubKey: string, cr: RawCitation, prod: RawCitation): FieldDiff[] {
  const crAuthorText = applyAuthorDedupOverridesToText(pubKey, cr.authorSegmentHtml.replace(/<[^>]+>/g, ""));
  const prodAuthorText = prod.authorSegmentHtml.replace(/<[^>]+>/g, "");
  const fields: Array<{ field: string; cleanRoom: string; production: string; equal: boolean }> = [
    { field: "author", cleanRoom: crAuthorText, production: prodAuthorText, equal: normalizeAuthorName(crAuthorText) === normalizeAuthorName(prodAuthorText) },
    { field: "year", cleanRoom: cr.year, production: prod.year, equal: cr.year === prod.year },
    { field: "title", cleanRoom: cr.title, production: prod.title, equal: cr.title === prod.title },
    { field: "url", cleanRoom: cr.href, production: prod.href, equal: cr.href === prod.href },
    { field: "journal", cleanRoom: cr.journal, production: prod.journal, equal: cr.journal === prod.journal },
    { field: "tail", cleanRoom: cr.tail, production: prod.tail, equal: cr.tail === prod.tail },
  ];
  return fields.filter((f) => !f.equal);
}

// The fixture documents the two genuine author-LIST differences this
// backfill found (a real co-author the live post omitted, confirmed by
// directly fetching the post — pubs 96 and 1398) as an `expected_diffs`
// entry with field: "authors". Only two publications in the whole fixture
// carry one; both were individually verified against the live post before
// being recorded (§13.24 remediation), so any "author" diff on one of these
// two is that already-reviewed case, not a new finding.
function isConfirmedAuthorsDiff(pub: GroundTruthPublication | undefined): boolean {
  return (pub?.expected_diffs ?? []).some((d) => d.field === "authors");
}

// Four publications' `year` display field genuinely differs from the live
// post: production's current Crossref-sourced record now reflects a final
// print-issue year assigned after the post was written (epub-ahead-of-print
// drift), independently verified against the live post + DOI-embedded years
// for all four (§13.24 remediation). Requires an EXACT match against the
// fixture's recorded post_said/corrected values, unlike the looser
// isConfirmedAuthorsDiff check above — a year is a single unambiguous
// value, so there's no reason to accept anything less than an exact match.
function isConfirmedYearDiff(pub: GroundTruthPublication | undefined, cleanRoomYear: string, productionYear: string): boolean {
  const expected = pub?.expected_diffs?.find((d) => d.field === "year");
  if (!expected) return false;
  return String(expected.post_said) === cleanRoomYear && String(expected.corrected) === productionYear;
}

async function generateCleanRoom(): Promise<{ html: string; title: string }> {
  const dbDir = mkdtempSync(path.join(tmpdir(), "backfill-verify-cleanroom-"));
  const client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
  try {
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
    const fixture = loadGroundTruth();
    await seedGroundTruth(client, fixture);
    const eligible = await queryPublications(client, { status: ["published"], excludeAlreadyPosted: true, dateAddedTo: CUTOFF_DATE });
    const html = buildExportHtml({ title: fixture.edition.title, intro: fixture.edition.intro, legend: fixture.edition.legend, publications: eligible });
    return { html, title: fixture.edition.title };
  } finally {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
}

async function generateProduction(): Promise<{
  html: string;
  eligibleCount: number;
  unknownRoleCount: number;
  noFacultyPapers: Array<{ id: number; title: string }>;
}> {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");
  const client = createClient({ url, authToken });

  const fixture = loadGroundTruth();
  const eligible = await queryPublications(client, { status: ["published"], excludeAlreadyPosted: true, dateAddedTo: CUTOFF_DATE });
  const html = buildExportHtml({ title: fixture.edition.title, intro: fixture.edition.intro, legend: fixture.edition.legend, publications: eligible });

  const unknownRoleCount = eligible.filter((r) => r.authors.some((a) => a.role === "unknown")).length;
  const noFacultyPapers = eligible.filter((r) => r.units.length === 0).map((r) => ({ id: r.publication.id, title: r.publication.title }));

  return { html, eligibleCount: eligible.length, unknownRoleCount, noFacultyPapers };
}

async function main() {
  const fixture = loadGroundTruth();
  const fixtureByNormTitle = new Map(fixture.publications.map((p) => [normalizeTitleForMatch(p.title), p]));

  console.log("Generating Session 20 clean-room reproduction (fresh, throwaway DB)...");
  const cleanRoom = await generateCleanRoom();

  console.log("Generating from PRODUCTION (read-only)...");
  const production = await generateProduction();

  const noFacultyNormTitles = new Set(production.noFacultyPapers.map((p) => normalizeTitleForMatch(p.title)));

  console.log("─".repeat(72));
  console.log("§8c Tab 4 pre-flight warnings");
  console.log(`Production eligible publications: ${production.eligibleCount}`);
  console.log(`  with unreviewed (unknown-role) co-authors: ${production.unknownRoleCount}`);
  console.log(`  with no linked CHPS faculty author (will not appear in any unit section): ${production.noFacultyPapers.length}`);
  for (const p of production.noFacultyPapers) console.log(`    - [id ${p.id}] ${p.title}`);
  if (production.noFacultyPapers.length > 0) {
    console.log(
      "    These are excluded from every unit heading in the generated HTML below (Chen, X.S. is their only CHPS-faculty\n" +
        "    author and is deliberately left unlinked — see master plan §6 ROLES, 'Open follow-up: Chen identity resolution').\n" +
        "    Task C must NOT stamp these into this edition's roundup_id — they need to remain eligible for a future edition."
    );
  }
  console.log("─".repeat(72));

  const cleanRoomCitations = parseEditionHtml(cleanRoom.html);
  const productionCitations = parseEditionHtml(production.html);

  const cleanRoomByKey = new Map(cleanRoomCitations.map((c) => [citationKey(c), c]));
  const productionByKey = new Map(productionCitations.map((c) => [citationKey(c), c]));

  const cleanRoomUnits = [...new Set(cleanRoomCitations.map((c) => c.unitName))];
  const productionUnits = [...new Set(productionCitations.map((c) => c.unitName))];

  console.log(`Units — clean room: ${cleanRoomUnits.length}, production: ${productionUnits.length}`);
  const missingFromProduction = cleanRoomUnits.filter((u) => !productionUnits.includes(u));
  const extraInProduction = productionUnits.filter((u) => !cleanRoomUnits.includes(u));
  if (missingFromProduction.length > 0) console.log(`  units in clean room but NOT production: ${missingFromProduction.join(", ")}`);
  if (extraInProduction.length > 0) console.log(`  units in production but NOT clean room: ${extraInProduction.join(", ")}`);

  const unexpectedDiffs: string[] = [];
  const allowedMetadataDiffs: string[] = [];
  const knownExclusions: string[] = [];
  const confirmedAuthorDiffs: string[] = [];
  const confirmedYearDiffs: string[] = [];

  for (const [key, cr] of cleanRoomByKey) {
    const prod = productionByKey.get(key);
    const isKnownExclusion = noFacultyNormTitles.has(normalizeTitleForMatch(cr.title));

    if (!prod) {
      const msg = `[${key}]: "${cr.title.slice(0, 70)}"`;
      if (isKnownExclusion) knownExclusions.push(msg);
      else unexpectedDiffs.push(`MISSING FROM PRODUCTION ${msg}`);
      continue;
    }

    const fixturePub = fixtureByNormTitle.get(normalizeTitleForMatch(cr.title));
    const fieldDiffs = diffCitationFields(fixturePub?.key ?? "", cr, prod);
    if (fieldDiffs.length === 0) continue;

    const authorDiff = fieldDiffs.find((d) => d.field === "author");
    const yearDiff = fieldDiffs.find((d) => d.field === "year");
    const otherStrict = fieldDiffs.filter((d) => d.field !== "author" && d.field !== "year" && !isProductionMetadataUpgradeField(d.field));
    const allowed = fieldDiffs.filter((d) => isProductionMetadataUpgradeField(d.field));

    if (yearDiff && isConfirmedYearDiff(fixturePub, yearDiff.cleanRoom, yearDiff.production)) {
      confirmedYearDiffs.push(`[${key}]: clean room="${yearDiff.cleanRoom}" | production="${yearDiff.production}"`);
    } else if (yearDiff) {
      otherStrict.unshift(yearDiff);
    }

    if (authorDiff && isConfirmedAuthorsDiff(fixturePub)) {
      confirmedAuthorDiffs.push(`[${key}]:\n    author: clean room="${authorDiff.cleanRoom}" | production="${authorDiff.production}"`);
    } else if (authorDiff) {
      otherStrict.unshift(authorDiff);
    }

    if (otherStrict.length > 0) {
      const detail = otherStrict.map((d) => `${d.field}: clean room="${d.cleanRoom}" | production="${d.production}"`).join("\n    ");
      unexpectedDiffs.push(`DIFFERS [${key}]:\n    ${detail}`);
    } else if (allowed.length > 0) {
      const detail = allowed.map((d) => `${d.field}: clean room="${d.cleanRoom}" | production="${d.production}"`).join("\n    ");
      allowedMetadataDiffs.push(`[${key}]:\n    ${detail}`);
    }
  }

  for (const [key, prod] of productionByKey) {
    if (!cleanRoomByKey.has(key)) {
      unexpectedDiffs.push(`EXTRA IN PRODUCTION [${key}]: "${prod.title.slice(0, 70)}" — production has data the fixture doesn't`);
    }
  }

  console.log(`\nKnown exclusions (no linked CHPS faculty, absent from every unit — see pre-flight warning above): ${knownExclusions.length}`);
  for (const d of knownExclusions) console.log(`  ~ ${d}`);

  console.log(`\nConfirmed author-list differences (real co-author the live post omitted — see fixture's expected_diffs): ${confirmedAuthorDiffs.length}`);
  for (const d of confirmedAuthorDiffs) console.log(`  ~ ${d}`);

  console.log(`\nConfirmed year differences (post's snapshot vs. production's current Crossref record — see fixture's expected_diffs): ${confirmedYearDiffs.length}`);
  for (const d of confirmedYearDiffs) console.log(`  ~ ${d}`);

  console.log(
    `\nAllowed metadata differences (production's Crossref/PubMed data is more complete than the post-derived fixture — journal/url/pages/title-casing only): ${allowedMetadataDiffs.length}`
  );
  for (const d of allowedMetadataDiffs) console.log(`  ~ ${d}`);

  console.log(`\nUNEXPECTED DIFFERENCES: ${unexpectedDiffs.length} (must be zero to proceed to Task C)`);
  for (const d of unexpectedDiffs) console.log(`  ✗ ${d}`);

  console.log("─".repeat(72));
  if (unexpectedDiffs.length === 0) {
    console.log("PASS — production reproduces the Session 20 clean-room edition's content (author lists, years, units), modulo known exclusions and allowed metadata upgrades.");
  } else {
    console.log("STOP — unexpected differences found. Do not proceed to Task C until these are understood.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
