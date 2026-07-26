// Session 20 (§13.24) Task A: clean-room seed. Every test here uses a
// throwaway temp-file DB (same pattern as every other *.test.ts in this
// repo) — never production Turso.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { loadGroundTruth, seedGroundTruth, type GroundTruthFixture } from "../lib/backfill-seed";

describe("seedGroundTruth", () => {
  let dbDir: string;
  let client: Client;
  let fixture: GroundTruthFixture;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "backfill-seed-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
    fixture = loadGroundTruth();
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("loads the real fixture file as valid, non-empty JSON", () => {
    expect(fixture.publications.length).toBeGreaterThan(100);
    expect(fixture.faculty.length).toBeGreaterThan(30);
    expect(fixture.edition.label).toBe("Spring and Summer 2025");
  });

  it("seeds exactly the fixture's faculty, publication, and author counts", async () => {
    const summary = await seedGroundTruth(client, fixture);

    expect(summary.facultyCount).toBe(fixture.faculty.length);
    expect(summary.publicationCount).toBe(fixture.publications.length);

    const facultyRows = await client.execute("SELECT COUNT(*) as c FROM faculty");
    expect((facultyRows.rows[0] as unknown as { c: number }).c).toBe(fixture.faculty.length);

    const pubRows = await client.execute("SELECT COUNT(*) as c FROM publications");
    expect((pubRows.rows[0] as unknown as { c: number }).c).toBe(fixture.publications.length);

    const authorRows = await client.execute("SELECT COUNT(*) as c FROM publication_authors");
    expect((authorRows.rows[0] as unknown as { c: number }).c).toBe(summary.authorCount);
  });

  it("every seeded publication is published, unposted, and within the eligibility window", async () => {
    await seedGroundTruth(client, fixture);

    const rows = (await client.execute("SELECT status, roundup_id, date_added FROM publications")).rows as unknown as Array<{
      status: string;
      roundup_id: number | null;
      date_added: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.status).toBe("published");
      expect(r.roundup_id).toBeNull();
      expect(r.date_added <= "2025-06-30").toBe(true);
    }
  });

  it("links every chps_faculty author to a real seeded faculty row (so units derive)", async () => {
    await seedGroundTruth(client, fixture);

    const rows = (
      await client.execute(`
        SELECT pa.faculty_id FROM publication_authors pa WHERE pa.role = 'chps_faculty'
      `)
    ).rows as unknown as Array<{ faculty_id: number | null }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.faculty_id).not.toBeNull();
    }
  });

  it("is idempotent: running it twice yields the same row counts, no duplicates", async () => {
    const first = await seedGroundTruth(client, fixture);
    const second = await seedGroundTruth(client, fixture);

    expect(second.facultyCount).toBe(first.facultyCount);
    expect(second.publicationCount).toBe(first.publicationCount);
    expect(second.authorCount).toBe(first.authorCount);

    const pubRows = await client.execute("SELECT COUNT(*) as c FROM publications");
    expect((pubRows.rows[0] as unknown as { c: number }).c).toBe(fixture.publications.length);
  });

  it("throws if a fixture author references a faculty_key that isn't in the fixture's faculty list", async () => {
    const broken: GroundTruthFixture = {
      ...fixture,
      publications: [
        {
          key: "broken-pub",
          title: "Broken Paper",
          journal: "Test Journal",
          year: 2025,
          volume: null,
          issue: null,
          pages: null,
          doi: null,
          url: "https://example.com",
          units_in_post: [],
          authors: [{ name: "Ghost, G.", position: 0, role: "chps_faculty", faculty_key: "does-not-exist" }],
        },
      ],
    };

    await expect(seedGroundTruth(client, broken)).rejects.toThrow(/does-not-exist/);
  });
});
