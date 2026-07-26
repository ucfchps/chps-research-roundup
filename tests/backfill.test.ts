// Session 20 (§13.24): the whole-system acceptance test — if the real
// generator can reproduce the Spring/Summer 2025 post from seeded ground
// truth (structure + roles exactly, metadata only where the post itself was
// wrong), the system works. Clean-room only: a throwaway temp-file DB, the
// same pattern as every other *.test.ts in this repo — this file never
// connects to production Turso.
//
// Every function under test here is the REAL production code path:
// queryPublications (§6b eligibility), buildExportHtml/formatCitation (§6a
// unit derivation + citation format), finalizeRoundup/unstampRoundup
// (Session 19). This file's own code (lib/backfill-diff.ts) only parses
// HTML back out again to compare it — it never formats a citation or
// derives a unit itself.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { loadGroundTruth, seedGroundTruth, type GroundTruthFixture } from "../lib/backfill-seed";
import { queryPublications } from "../lib/publications";
import { buildExportHtml } from "../lib/roundup-export";
import { finalizeRoundup, unstampRoundup } from "../lib/roundup-finalize";
import { compareEditions, parseEditionHtml, isProductionMetadataUpgradeField, type BackfillDiffReport } from "../lib/backfill-diff";
import { UNITS } from "../lib/types";
import type { PublicationWithUnits } from "../lib/publications";

const CUTOFF_DATE = "2025-06-30";
const LIVE_POST_HTML = readFileSync(path.join(__dirname, "fixtures", "backfill", "live-post-2025.html"), "utf-8");

describe("Session 20 backfill acceptance test (§13.24)", () => {
  let dbDir: string;
  let client: Client;
  let fixture: GroundTruthFixture;
  let eligible: PublicationWithUnits[];
  let generatedHtml: string;
  let report: BackfillDiffReport;

  beforeAll(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "backfill-acceptance-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));

    fixture = loadGroundTruth();
    await seedGroundTruth(client, fixture);

    // The real generator's own eligibility + citation + unit-derivation path
    // (§6b, §6a) — no shortcut, no reimplementation.
    eligible = await queryPublications(client, {
      status: ["published"],
      excludeAlreadyPosted: true,
      dateAddedTo: CUTOFF_DATE,
    });
    generatedHtml = buildExportHtml({
      title: fixture.edition.title,
      intro: fixture.edition.intro,
      legend: fixture.edition.legend,
      publications: eligible,
    });

    const generatedCitations = parseEditionHtml(generatedHtml);
    const livePostCitations = parseEditionHtml(LIVE_POST_HTML);
    report = compareEditions(generatedCitations, livePostCitations, fixture);
  });

  afterAll(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  describe("Task B — structure", () => {
    it("reproduces every unit from the post's quick-jump — including CARD, once Tayek is linked as CARD staff", () => {
      expect(report.missingUnitsUnexplained).toEqual([]);
      expect(report.missingUnitsKnown).toEqual([]);
      expect(report.unitsInGenerated).toContain("Center for Autism and Related Disabilities");
    });

    it("reproduces units in canonical §6 order", () => {
      const canonicalPresent = UNITS.filter((u) => report.unitsInGenerated.includes(u));
      expect(report.unitsInGenerated).toEqual(canonicalPresent);
    });

    it("renders every multi-unit paper with IDENTICAL author bolding in every section (the §6a guarantee)", () => {
      expect(report.multiUnitPapers.length).toBe(3);
      for (const paper of report.multiUnitPapers) {
        expect(paper.consistent, `${paper.pubKey}: ${JSON.stringify(paper.renders)}`).toBe(true);
      }
    });

    it("renders the Awan same-unit duplicate exactly once (the §7 dedup guarantee)", () => {
      expect(report.awanDuplicateCount).toBe(1);
    });

    it("no publication derives to zero units — CARD's paper is now linked via Tayek", () => {
      expect(report.noFacultyPapers).toEqual([]);
    });
  });

  describe("Task B — expected diffs and the unexpected-diffs bar", () => {
    it("confirms every annotated expected diff in BOTH directions (generated=corrected AND post=post_said)", () => {
      expect(report.expectedDiffsNotConfirmed).toEqual([]);
      expect(report.expectedDiffsConfirmed.length).toBeGreaterThan(0);
    });

    it("has ZERO unexpected diffs — the actual acceptance bar", () => {
      expect(report.unexpectedDiffs).toEqual([]);
    });
  });

  // Runs last, deliberately: it's the one step in this file that writes.
  // Everything above is read-only inspection of the seeded data; this is
  // the real Session 19 finalize/unstamp path exercised end to end on that
  // same seeded edition, proving the irreversible action and its only undo
  // path against known-good data before either ever touches production.
  describe("Task C — finalize / unstamp round-trip on the seeded edition", () => {
    let roundupId: number;
    const includedIds: number[] = [];

    beforeAll(() => {
      includedIds.push(...eligible.map((r) => r.publication.id));
    });

    it("finalize stamps exactly one roundups row whose stored html equals the Task B generated html", async () => {
      const result = await finalizeRoundup(client, {
        label: fixture.edition.label,
        generatedBy: "Session 20 backfill acceptance test",
        cutoffDate: CUTOFF_DATE,
        title: fixture.edition.title,
        intro: fixture.edition.intro,
        legendLine: fixture.edition.legend,
        publicationIds: includedIds,
      });
      roundupId = result.roundupId;
      expect(result.pubCount).toBe(includedIds.length);

      const roundupsRows = (await client.execute("SELECT * FROM roundups")).rows as unknown as Array<{
        id: number;
        label: string;
        pub_count: number;
        html: string;
      }>;
      expect(roundupsRows).toHaveLength(1);
      expect(roundupsRows[0].label).toBe(fixture.edition.label);
      expect(roundupsRows[0].pub_count).toBe(includedIds.length);
      expect(roundupsRows[0].html).toBe(generatedHtml);
    });

    it("stamped roundup_id on exactly the included publications and nothing else", async () => {
      const stamped = (
        await client.execute({ sql: "SELECT id FROM publications WHERE roundup_id = ?", args: [roundupId] })
      ).rows as unknown as Array<{ id: number }>;
      expect(stamped.map((r) => r.id).sort((a, b) => a - b)).toEqual([...includedIds].sort((a, b) => a - b));

      const totalPubs = (await client.execute("SELECT COUNT(*) as c FROM publications")).rows[0] as unknown as { c: number };
      expect(totalPubs.c).toBe(includedIds.length); // every seeded pub was eligible and included
    });

    it("the double-post guarantee: none of the stamped publications appear in a fresh eligibility query", async () => {
      const stillEligible = await queryPublications(client, {
        status: ["published"],
        excludeAlreadyPosted: true,
        dateAddedTo: CUTOFF_DATE,
      });
      expect(stillEligible).toEqual([]);
    });

    it("unstamp --dry-run reports the right rows and changes nothing", async () => {
      const summary = await unstampRoundup(client, roundupId, { dryRun: true });
      expect(summary.publicationIds.sort((a, b) => a - b)).toEqual([...includedIds].sort((a, b) => a - b));

      const roundupsCount = (await client.execute("SELECT COUNT(*) as c FROM roundups")).rows[0] as unknown as { c: number };
      expect(roundupsCount.c).toBe(1); // still there — dry run changed nothing

      const stillStamped = (await client.execute("SELECT COUNT(*) as c FROM publications WHERE roundup_id IS NOT NULL")).rows[0] as unknown as {
        c: number;
      };
      expect(stillStamped.c).toBe(includedIds.length);
    });

    it("unstamp for real fully reverses the finalize — the safety net actually works", async () => {
      await unstampRoundup(client, roundupId, { dryRun: false });

      const roundupsCount = (await client.execute("SELECT COUNT(*) as c FROM roundups")).rows[0] as unknown as { c: number };
      expect(roundupsCount.c).toBe(0);

      const nowEligible = await queryPublications(client, {
        status: ["published"],
        excludeAlreadyPosted: true,
        dateAddedTo: CUTOFF_DATE,
      });
      expect(nowEligible.map((r) => r.publication.id).sort((a, b) => a - b)).toEqual([...includedIds].sort((a, b) => a - b));
    });
  });
});

describe("isProductionMetadataUpgradeField (§13.24 Task B allowlist)", () => {
  it("allows journal, url, tail, and title — production's Crossref data outranks the post-derived fixture on these", () => {
    expect(isProductionMetadataUpgradeField("journal")).toBe(true);
    expect(isProductionMetadataUpgradeField("url")).toBe(true);
    expect(isProductionMetadataUpgradeField("tail")).toBe(true);
    expect(isProductionMetadataUpgradeField("title")).toBe(true);
  });

  it("does not allow author or unit — those are content disagreements, never allowlisted", () => {
    expect(isProductionMetadataUpgradeField("author:Smith, J.")).toBe(false);
    expect(isProductionMetadataUpgradeField("unit")).toBe(false);
    expect(isProductionMetadataUpgradeField("authors")).toBe(false);
  });
});
