// §8c Tab 4 (partial), Session 18: the publications browser's query layer.
// The unit filter must never drift from lib/citation.ts::unitsForPublication
// — two definitions of "which unit is this in" have already caused a real
// bug once in this project (the Brazendale §6a bolding inconsistency).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { queryPublications } from "../lib/publications";
import { unitsForPublication } from "../lib/citation";
import type { Faculty, PublicationAuthor } from "../lib/types";

describe("queryPublications", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "publications-test-"));
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

  describe("defaults", () => {
    it("defaults to status=['published'] and excludeAlreadyPosted=true", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const eligible = await seedPublication({ title: "Eligible Paper", dateAdded: "2026-01-01" });
      await seedAuthor(eligible, facultyId, "Stock, M.", "chps_faculty", 0);

      const pending = await seedPublication({ title: "Pending Paper", dateAdded: "2026-01-01", status: "pending_merge" });
      await seedAuthor(pending, facultyId, "Stock, M.", "chps_faculty", 0);

      await client.execute(`INSERT INTO roundups (label, generated_at, pub_count, html) VALUES ('Old Edition', datetime('now'), 1, '<html></html>')`);
      const posted = await seedPublication({ title: "Already Posted Paper", dateAdded: "2026-01-01", roundupId: 1 });
      await seedAuthor(posted, facultyId, "Stock, M.", "chps_faculty", 0);

      const results = await queryPublications(client);

      expect(results.map((r) => r.publication.title)).toEqual(["Eligible Paper"]);
    });
  });

  describe("individual filters", () => {
    it("facultyQuery matches against faculty display_name", async () => {
      const stockId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const zhuId = await seedFaculty("Zhu, Y.", "School of Communication Sciences and Disorders");
      const stockPub = await seedPublication({ title: "Stock Paper", dateAdded: "2026-01-01" });
      await seedAuthor(stockPub, stockId, "Stock, M.", "chps_faculty", 0);
      const zhuPub = await seedPublication({ title: "Zhu Paper", dateAdded: "2026-01-01" });
      await seedAuthor(zhuPub, zhuId, "Zhu, Y.", "chps_faculty", 0);

      const results = await queryPublications(client, { facultyQuery: "Stock" });

      expect(results.map((r) => r.publication.title)).toEqual(["Stock Paper"]);
    });

    it("facultyQuery also matches against a raw (unlinked) author name", async () => {
      const pub = await seedPublication({ title: "Unlinked Author Paper", dateAdded: "2026-01-01" });
      await seedAuthor(pub, null, "Torralba, L.", "unknown", 0);

      const results = await queryPublications(client, { facultyQuery: "Torralba" });

      expect(results.map((r) => r.publication.title)).toEqual(["Unlinked Author Paper"]);
    });

    it("dateAddedFrom/dateAddedTo filter on date_added, not publication year", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const early = await seedPublication({ title: "Early Paper", dateAdded: "2026-01-01" });
      await seedAuthor(early, facultyId, "Stock, M.", "chps_faculty", 0);
      const mid = await seedPublication({ title: "Mid Paper", dateAdded: "2026-03-15" });
      await seedAuthor(mid, facultyId, "Stock, M.", "chps_faculty", 0);
      const late = await seedPublication({ title: "Late Paper", dateAdded: "2026-06-01" });
      await seedAuthor(late, facultyId, "Stock, M.", "chps_faculty", 0);

      const results = await queryPublications(client, { dateAddedFrom: "2026-02-01", dateAddedTo: "2026-05-01" });

      expect(results.map((r) => r.publication.title)).toEqual(["Mid Paper"]);
    });

    it("status filter overrides the default", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const pending = await seedPublication({ title: "Pending Paper", dateAdded: "2026-01-01", status: "pending_merge" });
      await seedAuthor(pending, facultyId, "Stock, M.", "chps_faculty", 0);

      const results = await queryPublications(client, { status: ["pending_merge"] });

      expect(results.map((r) => r.publication.title)).toEqual(["Pending Paper"]);
    });

    it("excludeAlreadyPosted=false includes already-posted publications", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      await client.execute(`INSERT INTO roundups (label, generated_at, pub_count, html) VALUES ('Old Edition', datetime('now'), 1, '<html></html>')`);
      const posted = await seedPublication({ title: "Already Posted Paper", dateAdded: "2026-01-01", roundupId: 1 });
      await seedAuthor(posted, facultyId, "Stock, M.", "chps_faculty", 0);

      const results = await queryPublications(client, { excludeAlreadyPosted: false });

      expect(results.map((r) => r.publication.title)).toEqual(["Already Posted Paper"]);
    });
  });

  describe("unit filter", () => {
    it("filters to publications whose derived unit set intersects the selected units", async () => {
      const stockId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const zhuId = await seedFaculty("Zhu, Y.", "School of Communication Sciences and Disorders");
      const stockPub = await seedPublication({ title: "Health Sciences Paper", dateAdded: "2026-01-01" });
      await seedAuthor(stockPub, stockId, "Stock, M.", "chps_faculty", 0);
      const zhuPub = await seedPublication({ title: "CSD Paper", dateAdded: "2026-01-01" });
      await seedAuthor(zhuPub, zhuId, "Zhu, Y.", "chps_faculty", 0);

      const results = await queryPublications(client, { units: ["Department of Health Sciences"] });

      expect(results.map((r) => r.publication.title)).toEqual(["Health Sciences Paper"]);
    });

    it("a co-author's unit does not count if their role isn't chps_faculty (unconfirmed link)", async () => {
      const facultyId = await seedFaculty("Zhu, Y.", "School of Communication Sciences and Disorders");
      const pub = await seedPublication({ title: "Unconfirmed Paper", dateAdded: "2026-01-01" });
      // faculty_id populated but role still 'unknown' — must not count toward unit derivation (§6a / ops-notes.md).
      await seedAuthor(pub, facultyId, "Zhu, Y.", "unknown", 0);

      const results = await queryPublications(client, { units: ["School of Communication Sciences and Disorders"] });

      expect(results).toEqual([]);
    });

    it("★ anti-drift: SQL-level unit filtering agrees with lib/citation.ts::unitsForPublication on the same fixture data, for every unit", async () => {
      // The Brazendale §6a shape: two faculty authors in two different units on the same paper.
      const brazendaleId = await seedFaculty("Brazendale, K.", "Department of Health Sciences");
      const jeuneId = await seedFaculty("Jeune, S.", "Department of Health Sciences");
      const lawrenceId = await seedFaculty("Lawrence, S.", "School of Social Work");
      const gurnukarId = await seedFaculty("Gurnukar, S.", "School of Social Work");
      const pubId = await seedPublication({
        title: "Initial Evidence Comparing Beverage and Snack Dietary Patterns",
        dateAdded: "2026-01-01",
      });
      await seedAuthor(pubId, brazendaleId, "Brazendale, K.", "chps_faculty", 0);
      await seedAuthor(pubId, jeuneId, "Jeune, S.", "chps_faculty", 1);
      await seedAuthor(pubId, null, "Garcia, J.", "unknown", 2);
      await seedAuthor(pubId, lawrenceId, "Lawrence, S.", "chps_faculty", 3);
      await seedAuthor(pubId, gurnukarId, "Gurnukar, S.", "chps_faculty", 4);

      // Also seed an unrelated single-unit paper, to make sure the agreement
      // check isn't trivially true for a dataset with only one publication.
      const stockId = await seedFaculty("Stock, M.", "School of Kinesiology and Rehabilitation Sciences");
      const stockPub = await seedPublication({ title: "Kinesiology Paper", dateAdded: "2026-01-01" });
      await seedAuthor(stockPub, stockId, "Stock, M.", "chps_faculty", 0);

      const allUnits: string[] = [
        "School of Communication Sciences and Disorders",
        "Center for Autism and Related Disabilities",
        "Department of Health Sciences",
        "School of Kinesiology and Rehabilitation Sciences",
        "School of Social Work",
      ];

      const facultyRows = (await client.execute("SELECT * FROM faculty")).rows as unknown as Faculty[];
      const facultyById: Record<number, Faculty> = {};
      for (const f of facultyRows) facultyById[f.id] = f;

      const allPubsUnfiltered = await queryPublications(client, { excludeAlreadyPosted: true });
      const authorsByPubId = new Map<number, PublicationAuthor[]>();
      for (const r of allPubsUnfiltered) authorsByPubId.set(r.publication.id, r.authors);

      for (const unit of allUnits) {
        const sqlResult = await queryPublications(client, { units: [unit as never] });
        const sqlTitles = new Set(sqlResult.map((r) => r.publication.title));

        const pureResult = allPubsUnfiltered.filter((r) => unitsForPublication(r.authors, facultyById).includes(unit as never));
        const pureTitles = new Set(pureResult.map((r) => r.publication.title));

        expect(sqlTitles).toEqual(pureTitles);
      }
    });
  });

  describe("combined filters", () => {
    it("person AND unit AND date range narrow together, not just each in isolation", async () => {
      const stockId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const zhuId = await seedFaculty("Zhu, Y.", "Department of Health Sciences");

      // Matches all three filters.
      const target = await seedPublication({ title: "Target Paper", dateAdded: "2026-03-01" });
      await seedAuthor(target, stockId, "Stock, M.", "chps_faculty", 0);

      // Matches person + unit, wrong date.
      const wrongDate = await seedPublication({ title: "Wrong Date Paper", dateAdded: "2026-09-01" });
      await seedAuthor(wrongDate, stockId, "Stock, M.", "chps_faculty", 0);

      // Matches unit + date, wrong person.
      const wrongPerson = await seedPublication({ title: "Wrong Person Paper", dateAdded: "2026-03-01" });
      await seedAuthor(wrongPerson, zhuId, "Zhu, Y.", "chps_faculty", 0);

      const results = await queryPublications(client, {
        facultyQuery: "Stock",
        units: ["Department of Health Sciences"],
        dateAddedFrom: "2026-02-01",
        dateAddedTo: "2026-04-01",
      });

      expect(results.map((r) => r.publication.title)).toEqual(["Target Paper"]);
    });
  });

  describe("multi-unit publications", () => {
    it("a publication belonging to two units is returned once, with both units listed", async () => {
      const healthId = await seedFaculty("Brazendale, K.", "Department of Health Sciences");
      const socialWorkId = await seedFaculty("Lawrence, S.", "School of Social Work");
      const pubId = await seedPublication({ title: "Two-Unit Paper", dateAdded: "2026-01-01" });
      await seedAuthor(pubId, healthId, "Brazendale, K.", "chps_faculty", 0);
      await seedAuthor(pubId, socialWorkId, "Lawrence, S.", "chps_faculty", 1);

      const results = await queryPublications(client);

      expect(results).toHaveLength(1);
      expect(results[0].units).toEqual(["Department of Health Sciences", "School of Social Work"]);
    });
  });

  describe("plain-object results", () => {
    it("returns genuinely plain objects (Object.prototype), not libSQL Row instances — required to pass this data as props into a Client Component", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const pub = await seedPublication({ title: "Some Paper", dateAdded: "2026-01-01" });
      await seedAuthor(pub, facultyId, "Stock, M.", "chps_faculty", 0);

      const results = await queryPublications(client);

      expect(results).toHaveLength(1);
      expect(Object.getPrototypeOf(results[0].publication)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(results[0].authors[0])).toBe(Object.prototype);
    });
  });

  describe("zero writes", () => {
    it("exercising the full filter -> preview -> export flow never touches publications.roundup_id or the roundups table", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const pub = await seedPublication({ title: "Some Paper", dateAdded: "2026-01-01" });
      await seedAuthor(pub, facultyId, "Stock, M.", "chps_faculty", 0);

      // Filter (unfiltered, then narrowed) ...
      await queryPublications(client);
      const filtered = await queryPublications(client, { facultyQuery: "Stock", units: ["Department of Health Sciences"] });

      // ... preview + export (buildExportHtml is pure — no DB access at all,
      // exercised here anyway so this test proves the whole pipeline, not
      // just the query layer, leaves the guarantee intact).
      const { buildExportHtml } = await import("../lib/roundup-export");
      const html = buildExportHtml({ title: "t", intro: "i", legend: "l", publications: filtered });
      expect(html).toContain("Some Paper");

      const roundupIdRows = (await client.execute("SELECT COUNT(*) as c FROM publications WHERE roundup_id IS NOT NULL")).rows as unknown as Array<{
        c: number;
      }>;
      const roundupsRows = (await client.execute("SELECT COUNT(*) as c FROM roundups")).rows as unknown as Array<{ c: number }>;
      expect(roundupIdRows[0].c).toBe(0);
      expect(roundupsRows[0].c).toBe(0);
    });
  });
});
