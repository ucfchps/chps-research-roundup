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
import { finalizeRoundup, unstampRoundup, listRoundups } from "../lib/roundup-finalize";

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

    it("rejects a zero-linked-author (zero-unit) checked publication unless explicitly acknowledged (Session 22, Bug 2)", async () => {
      const orphan = await seedPublication({ title: "Orphan Paper", dateAdded: "2026-01-01" });
      await seedAuthor(orphan, null, "Somebody, S.", "external", 0);

      await expect(finalizeRoundup(client, { ...BASE_PARAMS, publicationIds: [orphan] })).rejects.toThrow(/no linked CHPS faculty author/);

      const roundupsCount = (await client.execute("SELECT COUNT(*) as c FROM roundups")).rows[0] as unknown as { c: number };
      expect(roundupsCount.c).toBe(0);
      const row = (await client.execute({ sql: "SELECT roundup_id FROM publications WHERE id = ?", args: [orphan] })).rows[0] as unknown as {
        roundup_id: number | null;
      };
      expect(row.roundup_id).toBeNull();
    });

    it("stamps a zero-unit publication when its id is explicitly listed in acknowledgedZeroUnitIds", async () => {
      const orphan = await seedPublication({ title: "Orphan Paper", dateAdded: "2026-01-01" });
      await seedAuthor(orphan, null, "Somebody, S.", "external", 0);

      const result = await finalizeRoundup(client, { ...BASE_PARAMS, publicationIds: [orphan], acknowledgedZeroUnitIds: [orphan] });

      expect(result.pubCount).toBe(1);
      const row = (await client.execute({ sql: "SELECT roundup_id FROM publications WHERE id = ?", args: [orphan] })).rows[0] as unknown as {
        roundup_id: number | null;
      };
      expect(row.roundup_id).toBe(result.roundupId);
    });

    it("a real acknowledgment does not accidentally acknowledge OTHER zero-unit publications not explicitly listed", async () => {
      const orphanA = await seedPublication({ title: "Orphan A", dateAdded: "2026-01-01" });
      await seedAuthor(orphanA, null, "Somebody, S.", "external", 0);
      const orphanB = await seedPublication({ title: "Orphan B", dateAdded: "2026-01-01" });
      await seedAuthor(orphanB, null, "Someone, S.", "external", 0);

      await expect(
        finalizeRoundup(client, { ...BASE_PARAMS, publicationIds: [orphanA, orphanB], acknowledgedZeroUnitIds: [orphanA] })
      ).rejects.toThrow(/Orphan B/);

      const roundupsCount = (await client.execute("SELECT COUNT(*) as c FROM roundups")).rows[0] as unknown as { c: number };
      expect(roundupsCount.c).toBe(0); // all-or-nothing — orphanA must not get stamped either
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

    it("a nonexistent roundup id is a clean no-op, not a throw (Session 24, Tab 5)", async () => {
      const summary = await unstampRoundup(client, 999999, { dryRun: false });
      expect(summary).toEqual({ roundupId: 999999, label: null, publicationIds: [], dryRun: false, noop: true });
    });

    it("un-stamping the same roundup twice — the second call is a clean no-op, first call's reversal stands", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const pub = await seedPublication({ title: "Some Paper", dateAdded: "2026-01-01" });
      await seedAuthor(pub, facultyId, "Stock, M.", "chps_faculty", 0);
      const { roundupId } = await finalizeRoundup(client, { ...BASE_PARAMS, publicationIds: [pub] });

      const first = await unstampRoundup(client, roundupId, { dryRun: false });
      expect(first.noop).toBe(false);
      expect(first.publicationIds).toEqual([pub]);

      const second = await unstampRoundup(client, roundupId, { dryRun: false });
      expect(second).toEqual({ roundupId, label: null, publicationIds: [], dryRun: false, noop: true });

      // The first call's reversal isn't undone by the second, no-op call.
      const row = (await client.execute({ sql: "SELECT roundup_id FROM publications WHERE id = ?", args: [pub] })).rows[0] as unknown as {
        roundup_id: number | null;
      };
      expect(row.roundup_id).toBeNull();
    });

    it("un-stamping edition A leaves every publication stamped to edition B untouched (isolation)", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const a = await seedPublication({ title: "Edition A Paper", dateAdded: "2026-01-01" });
      await seedAuthor(a, facultyId, "Stock, M.", "chps_faculty", 0);
      const b = await seedPublication({ title: "Edition B Paper", dateAdded: "2026-01-01" });
      await seedAuthor(b, facultyId, "Stock, M.", "chps_faculty", 0);

      const editionA = await finalizeRoundup(client, { ...BASE_PARAMS, label: "Edition A", publicationIds: [a] });
      const editionB = await finalizeRoundup(client, { ...BASE_PARAMS, label: "Edition B", publicationIds: [b] });

      await unstampRoundup(client, editionA.roundupId, { dryRun: false });

      const bRow = (await client.execute({ sql: "SELECT roundup_id FROM publications WHERE id = ?", args: [b] })).rows[0] as unknown as {
        roundup_id: number | null;
      };
      expect(bRow.roundup_id).toBe(editionB.roundupId);
      const roundupsCount = (await client.execute("SELECT COUNT(*) as c FROM roundups")).rows[0] as unknown as { c: number };
      expect(roundupsCount.c).toBe(1); // only edition A's row was removed
    });
  });

  describe("listRoundups — the archive's read side (Session 24, Tab 5)", () => {
    it("returns editions newest-first", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const a = await seedPublication({ title: "Paper A", dateAdded: "2026-01-01" });
      await seedAuthor(a, facultyId, "Stock, M.", "chps_faculty", 0);
      const b = await seedPublication({ title: "Paper B", dateAdded: "2026-01-01" });
      await seedAuthor(b, facultyId, "Stock, M.", "chps_faculty", 0);

      await finalizeRoundup(client, { ...BASE_PARAMS, label: "Older Edition", publicationIds: [a] });
      await new Promise((r) => setTimeout(r, 5)); // ensure a distinct generated_at
      const newer = await finalizeRoundup(client, { ...BASE_PARAMS, label: "Newer Edition", publicationIds: [b] });

      const list = await listRoundups(client);
      expect(list.map((r) => r.label)).toEqual(["Newer Edition", "Older Edition"]);
      expect(list[0].id).toBe(newer.roundupId);
    });

    it("reports the live stamped count separately from the stored pub_count when a publication is edited (not un-stamped) after finalize", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const a = await seedPublication({ title: "Paper A", dateAdded: "2026-01-01" });
      await seedAuthor(a, facultyId, "Stock, M.", "chps_faculty", 0);
      const b = await seedPublication({ title: "Paper B", dateAdded: "2026-01-01" });
      await seedAuthor(b, facultyId, "Stock, M.", "chps_faculty", 0);

      const { roundupId } = await finalizeRoundup(client, { ...BASE_PARAMS, publicationIds: [a, b] });
      // Simulate a later edit that detaches one publication from the edition
      // without going through unstampRoundup — pub_count stays what it was
      // at finalize time (2); the live count should reflect reality (1).
      await client.execute({ sql: "UPDATE publications SET roundup_id = NULL WHERE id = ?", args: [a] });

      const list = await listRoundups(client);
      const entry = list.find((r) => r.id === roundupId)!;
      expect(entry.pub_count).toBe(2);
      expect(entry.live_stamped_count).toBe(1);
    });
  });
});
