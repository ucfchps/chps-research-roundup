// Session 19 (§6b, §8c Tab 4): the one action in this system that's supposed
// to be permanent. Every eligibility decision here is re-derived server-side
// via lib/publications.ts::queryPublications — the exact same query the
// browsing page uses — never a second, parallel implementation that could
// drift. A client-supplied publicationIds list is never trusted on its own:
// it's intersected against a fresh eligibility query, so a stale or
// tampered id list can never stamp something it shouldn't.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { queryPublications } from "../lib/publications";
import { finalizeRoundup, unstampRoundup } from "../lib/roundup-finalize";

describe("finalizeRoundup / unstampRoundup", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "roundup-finalize-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  async function seedFaculty(displayName: string, unit: string): Promise<number> {
    const result = await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, unit, active) VALUES (?, ?, ?, ?, 1)`,
      args: [displayName, displayName, displayName, unit],
    });
    return Number(result.lastInsertRowid);
  }

  async function seedPublication(overrides: {
    title: string;
    dateAdded: string;
    status?: string;
    roundupId?: number | null;
  }): Promise<number> {
    const now = new Date().toISOString();
    const result = await client.execute({
      sql: `INSERT INTO publications (title, title_normalized, url, status, source, first_seen_at, date_added, created_at, roundup_id)
            VALUES (?, ?, 'https://example.com', ?, 'crossref', ?, ?, ?, ?)`,
      args: [overrides.title, overrides.title.toLowerCase(), overrides.status ?? "published", now, overrides.dateAdded, now, overrides.roundupId ?? null],
    });
    return Number(result.lastInsertRowid);
  }

  async function seedAuthor(pubId: number, facultyId: number | null, name: string, role: string, position: number): Promise<void> {
    await client.execute({
      sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, position) VALUES (?, ?, ?, ?, ?)`,
      args: [pubId, facultyId, name, role, position],
    });
  }

  const BASE_PARAMS = {
    label: "Spring and Summer 2026",
    generatedBy: "Test User",
    cutoffDate: "2026-06-30",
    title: "Research Roundup",
    intro: "Intro paragraph.",
    legendLine: "Legend line.",
  };

  describe("eligibility — identical to queryPublications's default, no second implementation", () => {
    it("stamps a publication only when checked AND published AND unposted AND within the cutoff", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const eligible = await seedPublication({ title: "Eligible Paper", dateAdded: "2026-01-01" });
      await seedAuthor(eligible, facultyId, "Stock, M.", "chps_faculty", 0);

      const afterCutoff = await seedPublication({ title: "After Cutoff Paper", dateAdded: "2026-07-15" });
      await seedAuthor(afterCutoff, facultyId, "Stock, M.", "chps_faculty", 0);

      const pending = await seedPublication({ title: "Pending Paper", dateAdded: "2026-01-01", status: "pending_merge" });
      await seedAuthor(pending, facultyId, "Stock, M.", "chps_faculty", 0);

      await client.execute(`INSERT INTO roundups (label, generated_at, pub_count, html) VALUES ('Old Edition', datetime('now'), 1, '<html></html>')`);
      const alreadyPosted = await seedPublication({ title: "Already Posted Paper", dateAdded: "2026-01-01", roundupId: 1 });
      await seedAuthor(alreadyPosted, facultyId, "Stock, M.", "chps_faculty", 0);

      // All four "checked" — only the truly eligible one should actually stamp.
      const result = await finalizeRoundup(client, { ...BASE_PARAMS, publicationIds: [eligible, afterCutoff, pending, alreadyPosted] });

      expect(result.pubCount).toBe(1);
      const stampedByThisRun = (
        await client.execute({ sql: "SELECT id FROM publications WHERE roundup_id = ?", args: [result.roundupId] })
      ).rows as unknown as Array<{ id: number }>;
      expect(stampedByThisRun.map((r) => r.id)).toEqual([eligible]);
    });
  });

  describe("checked-set stamping", () => {
    it("stamps exactly the checked publications and provably does not touch unchecked ones in the same batch", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const a = await seedPublication({ title: "Paper A", dateAdded: "2026-01-01" });
      await seedAuthor(a, facultyId, "Stock, M.", "chps_faculty", 0);
      const b = await seedPublication({ title: "Paper B", dateAdded: "2026-01-01" });
      await seedAuthor(b, facultyId, "Stock, M.", "chps_faculty", 0);
      const c = await seedPublication({ title: "Paper C (left unchecked)", dateAdded: "2026-01-01" });
      await seedAuthor(c, facultyId, "Stock, M.", "chps_faculty", 0);

      await finalizeRoundup(client, { ...BASE_PARAMS, publicationIds: [a, b] });

      const rows = (await client.execute("SELECT id, roundup_id FROM publications ORDER BY id")).rows as unknown as Array<{
        id: number;
        roundup_id: number | null;
      }>;
      const byId = new Map(rows.map((r) => [r.id, r.roundup_id]));
      expect(byId.get(a)).not.toBeNull();
      expect(byId.get(b)).not.toBeNull();
      expect(byId.get(c)).toBeNull(); // untouched — stays eligible
    });

    it("a zero-linked-author (zero-unit) checked publication still gets stamped, even though it renders in no unit section", async () => {
      const orphan = await seedPublication({ title: "Orphan Paper", dateAdded: "2026-01-01" });
      await seedAuthor(orphan, null, "Somebody, S.", "external", 0);

      const result = await finalizeRoundup(client, { ...BASE_PARAMS, publicationIds: [orphan] });

      expect(result.pubCount).toBe(1);
      const row = (await client.execute({ sql: "SELECT roundup_id FROM publications WHERE id = ?", args: [orphan] })).rows[0] as unknown as {
        roundup_id: number | null;
      };
      expect(row.roundup_id).toBe(result.roundupId);
    });
  });

  describe("the roundups row", () => {
    it("creates exactly one roundups row with the correct label, generated_by, pub_count, and html", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const pub = await seedPublication({ title: "Some Paper", dateAdded: "2026-01-01" });
      await seedAuthor(pub, facultyId, "Stock, M.", "chps_faculty", 0);

      const result = await finalizeRoundup(client, { ...BASE_PARAMS, publicationIds: [pub] });

      const roundupsRows = (await client.execute("SELECT * FROM roundups")).rows as unknown as Array<{
        id: number;
        label: string;
        generated_by: string;
        pub_count: number;
        html: string;
      }>;
      expect(roundupsRows).toHaveLength(1);
      expect(roundupsRows[0].id).toBe(result.roundupId);
      expect(roundupsRows[0].label).toBe("Spring and Summer 2026");
      expect(roundupsRows[0].generated_by).toBe("Test User");
      expect(roundupsRows[0].pub_count).toBe(1);
      expect(roundupsRows[0].html).toContain("Some Paper");
    });
  });

  describe("the double-post guarantee", () => {
    it("a publication stamped by finalize no longer appears in a subsequent eligibility query, in the same test run", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const pub = await seedPublication({ title: "Some Paper", dateAdded: "2026-01-01" });
      await seedAuthor(pub, facultyId, "Stock, M.", "chps_faculty", 0);

      await finalizeRoundup(client, { ...BASE_PARAMS, publicationIds: [pub] });

      const stillEligible = await queryPublications(client, { status: ["published"], excludeAlreadyPosted: true, dateAddedTo: BASE_PARAMS.cutoffDate });
      expect(stillEligible.map((r) => r.publication.id)).not.toContain(pub);
    });
  });

  describe("error cases", () => {
    it("throws rather than creating an empty roundups row when nothing in the checked set is actually eligible", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const pending = await seedPublication({ title: "Pending Paper", dateAdded: "2026-01-01", status: "pending_merge" });
      await seedAuthor(pending, facultyId, "Stock, M.", "chps_faculty", 0);

      await expect(finalizeRoundup(client, { ...BASE_PARAMS, publicationIds: [pending] })).rejects.toThrow();

      const roundupsCount = (await client.execute("SELECT COUNT(*) as c FROM roundups")).rows[0] as unknown as { c: number };
      expect(roundupsCount.c).toBe(0);
    });
  });

  describe("unstampRoundup — the CLI safety net round-trips correctly", () => {
    it("clears roundup_id on every publication tied to the roundup and removes the roundups row, making the publications eligible again", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const a = await seedPublication({ title: "Paper A", dateAdded: "2026-01-01" });
      await seedAuthor(a, facultyId, "Stock, M.", "chps_faculty", 0);
      const b = await seedPublication({ title: "Paper B", dateAdded: "2026-01-01" });
      await seedAuthor(b, facultyId, "Stock, M.", "chps_faculty", 0);

      const { roundupId } = await finalizeRoundup(client, { ...BASE_PARAMS, publicationIds: [a, b] });

      await unstampRoundup(client, roundupId, { dryRun: false });

      const roundupsCount = (await client.execute("SELECT COUNT(*) as c FROM roundups")).rows[0] as unknown as { c: number };
      expect(roundupsCount.c).toBe(0);

      const stillEligible = await queryPublications(client, { status: ["published"], excludeAlreadyPosted: true });
      expect(stillEligible.map((r) => r.publication.id).sort()).toEqual([a, b].sort());
    });

    it("dry-run makes no changes", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const pub = await seedPublication({ title: "Some Paper", dateAdded: "2026-01-01" });
      await seedAuthor(pub, facultyId, "Stock, M.", "chps_faculty", 0);
      const { roundupId } = await finalizeRoundup(client, { ...BASE_PARAMS, publicationIds: [pub] });

      const summary = await unstampRoundup(client, roundupId, { dryRun: true });

      expect(summary.publicationIds).toEqual([pub]);
      const roundupsCount = (await client.execute("SELECT COUNT(*) as c FROM roundups")).rows[0] as unknown as { c: number };
      expect(roundupsCount.c).toBe(1);
      const row = (await client.execute({ sql: "SELECT roundup_id FROM publications WHERE id = ?", args: [pub] })).rows[0] as unknown as {
        roundup_id: number | null;
      };
      expect(row.roundup_id).toBe(roundupId);
    });

    it("throws for a roundup id that doesn't exist", async () => {
      await expect(unstampRoundup(client, 999999, { dryRun: false })).rejects.toThrow();
    });
  });
});
