// Phase 5 hardening (master plan §13 Phase 5). Raw libSQL Row objects
// crossing the Server -> Client boundary have broken production repeatedly
// (e.g. lib/campaigns.ts::getCampaignStatus's notYetOpened field, fixed with
// `.map((r) => ({...r}))`) — neither `tsc` nor a normal vitest assertion on
// return VALUES catches this, because the row's data is correct; only its
// prototype/shape is wrong. This is a permanent structural guard on
// lib/db.ts's own exported query helpers, run against the real migrated
// schema, not a toy table.
//
// ★ Finding this test surfaces on its own, worth reporting even though it's
// not something this file can assert against: lib/db.ts::query<T>() is
// exported but UNUSED anywhere in the app (confirmed by grep — the only
// import of anything but `client` from "@/lib/db" across app/, lib/,
// scripts/ is lib/ai.ts's `execute`). Every real caller either goes through
// lib/publications.ts::queryPublications (which does its own mapping) or
// imports the raw `client` and calls `client.execute(...).rows` directly,
// each responsible for its own plain-object treatment — that's the actual,
// uncontrolled risk surface the getCampaignStatus incident came from, and a
// guard on lib/db.ts's own helpers (however solid) does not reach it, since
// nothing calls them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./helpers/test-db";
import { seedFaculty, seedPublication, seedAuthors } from "./helpers/fixtures";

process.env.CROSSREF_MAILTO ??= "test@example.com";

describe("lib/db.ts's exported query helpers — plain objects and real arrays, real schema", () => {
  let db: TestDb;
  let dbModule: typeof import("../lib/db");

  beforeEach(async () => {
    db = await createTestDb();
    process.env.TURSO_DATABASE_URL = db.url;
    process.env.TURSO_AUTH_TOKEN = "test-token";
    // lib/db.ts creates its `client` singleton eagerly at import time, from
    // whatever TURSO_DATABASE_URL is set at that instant — without
    // resetModules() a second test's import would return the FIRST test's
    // already-cached module, still pointed at a temp DB createTestDb()
    // already tore down.
    vi.resetModules();
    dbModule = await import("../lib/db");
  });

  afterEach(async () => {
    await db.teardown();
  });

  // dbModule.client is its OWN connection (created at that module's import
  // time from the env vars above), separate from db.client — seed through
  // dbModule.client itself so both are querying the same on-disk file with
  // no cross-connection visibility surprises.
  async function seedRealRow(): Promise<{ facultyId: number; pubId: number }> {
    const facultyId = await seedFaculty(dbModule.client, { full_name: null }); // NULL column deliberately included
    const pubId = await seedPublication(dbModule.client, { doi: null, journal: null });
    await seedAuthors(dbModule.client, pubId, [{ name: "Test, A.", role_set_by: null }]);
    return { facultyId, pubId };
  }

  function assertPlainRow(row: unknown): void {
    expect(row).not.toBeNull();
    expect(typeof row).toBe("object");
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  }

  describe("query()", () => {
    it("returns a real Array, and every row in it is a plain object — faculty table, including a NULL column", async () => {
      await seedRealRow();

      const rows = await dbModule.query("SELECT * FROM faculty");

      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) assertPlainRow(row);
    });

    it("holds across every real table this app actually reads from — not just one", async () => {
      await seedRealRow();

      for (const table of ["faculty", "publications", "publication_authors"]) {
        const rows = await dbModule.query(`SELECT * FROM ${table}`);
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) assertPlainRow(row);
      }
    });

    it("a plain row survives JSON.stringify with exactly its named columns — no stray numeric-index or length properties riding along, the shape an RSC boundary actually needs", async () => {
      await seedRealRow();

      const rows = await dbModule.query<Record<string, unknown>>("SELECT id, display_name, full_name FROM faculty");
      const [row] = rows;

      expect(Object.keys(row).sort()).toEqual(["display_name", "full_name", "id"]);
      expect(JSON.parse(JSON.stringify(row))).toEqual(row);
    });

    it("an empty result set is still a real, empty Array — never null/undefined, never array-like", async () => {
      const rows = await dbModule.query("SELECT * FROM faculty WHERE id = -1");
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toEqual([]);
    });
  });

  describe("execute()", () => {
    it("its .rows are a real Array of plain objects too — the lower-level helper, same guarantee", async () => {
      await seedRealRow();

      const result = await dbModule.execute("SELECT * FROM faculty");

      expect(Array.isArray(result.rows)).toBe(true);
      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows) assertPlainRow(row);
    });
  });
});
