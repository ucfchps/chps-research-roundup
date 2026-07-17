import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { runMigrations } from "../db/migrate";

describe("runMigrations", () => {
  it("applies all migrations once, and is a no-op on a second run", async () => {
    const dbDir = mkdtempSync(path.join(tmpdir(), "migrate-test-"));
    const client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    const migrationsDir = path.join(__dirname, "..", "db", "migrations");

    try {
      const firstRun = await runMigrations(client, migrationsDir);
      expect(firstRun).toEqual([
        "001_initial.sql",
        "002_faculty_corrections.sql",
        "003_metadata_mismatches.sql",
        "004_metadata_mismatches_issue.sql",
        "005_discovery_provenance.sql",
        "006_possible_duplicates.sql",
      ]);

      const tables = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'publications'"
      );
      expect(tables.rows).toHaveLength(1);

      const secondRun = await runMigrations(client, migrationsDir);
      expect(secondRun).toEqual([]);
    } finally {
      client.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("002 corrects the faculty table shape per the amended master plan §6", async () => {
    const dbDir = mkdtempSync(path.join(tmpdir(), "migrate-test-"));
    const client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    const migrationsDir = path.join(__dirname, "..", "db", "migrations");

    try {
      await runMigrations(client, migrationsDir);

      const columns = await client.execute("PRAGMA table_info(faculty)");
      const byName = new Map(
        columns.rows.map((row) => [row.name as string, row])
      );

      // renamed, not dropped-and-recreated
      expect(byName.has("scholar_url")).toBe(false);
      expect(byName.has("research_profile_url")).toBe(true);

      // dropped — no independent source (§5a.3)
      expect(byName.has("researchgate_url")).toBe(false);

      // added
      expect(byName.has("email")).toBe(true);
      expect(byName.has("slug")).toBe(true);
      expect(byName.has("classification")).toBe(true);

      // unit must be nullable (0 = not NOT NULL) after the 12-step rebuild
      const unitCol = byName.get("unit");
      expect(unitCol).toBeDefined();
      expect(unitCol!.notnull).toBe(0);

      // no leftover scratch table from the rebuild
      const facultyNew = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'faculty_new'"
      );
      expect(facultyNew.rows).toHaveLength(0);

      // faculty is still usable end-to-end after the rebuild
      await client.execute({
        sql: `INSERT INTO faculty (wp_id, display_name, full_name, email, slug, unit, research_profile_url, classification)
              VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        args: [
          "1", "Test, T.", "Test Testerson", "test@ucf.edu", "test-testerson",
          "https://scholar.google.com/citations?user=abc123", "Faculty",
        ],
      });
      const row = await client.execute("SELECT * FROM faculty WHERE wp_id = '1'");
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].unit).toBeNull();
    } finally {
      client.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
