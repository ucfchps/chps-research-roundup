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
      expect(firstRun).toEqual(["001_initial.sql"]);

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
});
