// Phase 5 hardening, Session 3, item 0. Before trusting assertReRunInvariants
// (tests/helpers/invariants.ts) as the backbone of every idempotency test in
// this and prior sessions, prove it actually fails on the mutations it
// claims to catch — a helper whose failure path was never exercised is
// exactly the kind of thing that silently stops asserting anything.
import { describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/test-db";
import { snapshotTables } from "../helpers/snapshot";
import { assertReRunInvariants } from "../helpers/invariants";
import { seedPublication, seedAuthors } from "../helpers/fixtures";

describe("assertReRunInvariants — proving the negative (it can fail, and names the right thing)", () => {
  it("catches first_seen_at moving on an existing publication", async () => {
    const db: TestDb = await createTestDb();
    const id = await seedPublication(db.client);
    const before = await snapshotTables(db.client);

    await db.client.execute({ sql: "UPDATE publications SET first_seen_at = ? WHERE id = ?", args: ["2020-01-01T00:00:00.000Z", id] });
    const after = await snapshotTables(db.client);

    expect(() => assertReRunInvariants(before, after)).toThrow(new RegExp(`publications\\[${id}\\]\\.first_seen_at`));
    await db.teardown();
  });

  it("catches roundup_id changing on an existing publication (both directions)", async () => {
    const db: TestDb = await createTestDb();
    const id = await seedPublication(db.client, { roundup_id: null });
    const before = await snapshotTables(db.client);

    await db.client.execute("INSERT INTO roundups (id, label, generated_at, pub_count, html) VALUES (1, 'Test', datetime('now'), 1, '')");
    await db.client.execute({ sql: "UPDATE publications SET roundup_id = 1 WHERE id = ?", args: [id] });
    const after = await snapshotTables(db.client);

    expect(() => assertReRunInvariants(before, after)).toThrow(new RegExp(`publications\\[${id}\\]\\.roundup_id`));
    await db.teardown();
  });

  it("catches a human-set (role_set_by='faculty:N') role being rewritten", async () => {
    const db: TestDb = await createTestDb();
    const pubId = await seedPublication(db.client);
    await seedAuthors(db.client, pubId, [{ role: "grad_student", role_set_by: "faculty:1", role_set_at: "2026-01-01T00:00:00.000Z" }]);
    const before = await snapshotTables(db.client);

    await db.client.execute({ sql: "UPDATE publication_authors SET role = 'chps_faculty' WHERE publication_id = ?", args: [pubId] });
    const after = await snapshotTables(db.client);

    expect(() => assertReRunInvariants(before, after)).toThrow(/human-set.*role.*grad_student.*chps_faculty/);
    await db.teardown();
  });

  it("★ does NOT flag a role rewrite when role_set_by is machine-set (e.g. 'ingest') — only faculty:/comms: prefixes are protected", async () => {
    const db: TestDb = await createTestDb();
    const pubId = await seedPublication(db.client);
    await seedAuthors(db.client, pubId, [{ role: "unknown", role_set_by: "ingest:unconfirmed_name_match" }]);
    const before = await snapshotTables(db.client);

    await db.client.execute({ sql: "UPDATE publication_authors SET role = 'chps_faculty', role_set_by = 'ingest' WHERE publication_id = ?", args: [pubId] });
    const after = await snapshotTables(db.client);

    expect(() => assertReRunInvariants(before, after)).not.toThrow();
    await db.teardown();
  });

  it("catches an unexplained settings key changing value (not on the allowed-to-change list)", async () => {
    const db: TestDb = await createTestDb();
    const before = await snapshotTables(db.client);

    await db.client.execute("UPDATE settings SET value = '1' WHERE key = 'email_notifications_enabled'");
    const after = await snapshotTables(db.client);

    expect(() => assertReRunInvariants(before, after)).toThrow(/email_notifications_enabled/);
    await db.teardown();
  });

  it("catches a row count change on a table with no ID-based invariant of its own (a plain insert)", async () => {
    const db: TestDb = await createTestDb();
    const before = await snapshotTables(db.client);

    await seedPublication(db.client);
    const after = await snapshotTables(db.client);

    expect(() => assertReRunInvariants(before, after)).toThrow(/publications: row count changed from 0 to 1/);
    await db.teardown();
  });

  it("catches status regressing out of 'published'", async () => {
    const db: TestDb = await createTestDb();
    const id = await seedPublication(db.client, { status: "published" });
    const before = await snapshotTables(db.client);

    await db.client.execute({ sql: "UPDATE publications SET status = 'pending_merge' WHERE id = ?", args: [id] });
    const after = await snapshotTables(db.client);

    expect(() => assertReRunInvariants(before, after)).toThrow(/status regressed/);
    await db.teardown();
  });

  it("catches released_at changing once already set", async () => {
    const db: TestDb = await createTestDb();
    const id = await seedPublication(db.client, { released_at: "2026-01-01T00:00:00.000Z" });
    const before = await snapshotTables(db.client);

    await db.client.execute({ sql: "UPDATE publications SET released_at = ? WHERE id = ?", args: ["2026-02-01T00:00:00.000Z", id] });
    const after = await snapshotTables(db.client);

    expect(() => assertReRunInvariants(before, after)).toThrow(/released_at/);
    await db.teardown();
  });

  it("reports MULTIPLE violations in one throw, not just the first", async () => {
    const db: TestDb = await createTestDb();
    const id = await seedPublication(db.client);
    const before = await snapshotTables(db.client);

    await db.client.execute({ sql: "UPDATE publications SET first_seen_at = ?, status = 'needs_metadata' WHERE id = ?", args: ["2020-01-01T00:00:00.000Z", id] });
    const after = await snapshotTables(db.client);

    // status went published -> needs_metadata, which IS a regression (only
    // published -> non-published is checked) alongside the first_seen_at move.
    try {
      assertReRunInvariants(before, after);
      throw new Error("expected assertReRunInvariants to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/first_seen_at/);
      expect(message).toMatch(/status regressed/);
    }
    await db.teardown();
  });

  it("catches aiCallCount !== 0 when opted in", async () => {
    const db: TestDb = await createTestDb();
    const before = await snapshotTables(db.client);
    const after = await snapshotTables(db.client);

    expect(() => assertReRunInvariants(before, after, { aiCallCount: 2 })).toThrow(/AI calls on this run: expected 0, got 2/);
  });
});
