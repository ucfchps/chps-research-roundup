// Phase 5 hardening (idempotency, §9, §6b, §5a rule 8). release-buffer is
// currently unscheduled in production (docs/phase5-surface-inventory.md
// §Discrepancies — no GitHub Actions workflow, no cron config anywhere) and
// hasn't promoted anything in 13 days as of that finding. That's a
// deployment gap, not a code question — this file tests the function's own
// behavior, which is independent of whether cron ever invokes it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/test-db";
import { snapshotTables } from "../helpers/snapshot";
import { assertReRunInvariants } from "../helpers/invariants";
import { seedPublication, seedRoundup } from "../helpers/fixtures";
import { runReleaseBuffer } from "../../scripts/release-buffer";

const BUFFER_HOURS = 10;

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600000).toISOString();
}

describe("release-buffer — mechanism + re-run invariants", () => {
  let db: TestDb;
  const originalBufferHours = process.env.MERGE_BUFFER_HOURS;

  beforeEach(async () => {
    db = await createTestDb();
    // Controlled, not whatever .env.local happens to say today — the
    // module-level `config()` call in scripts/release-buffer.ts loads real
    // .env.local values into process.env on import regardless of which
    // function is called, harmless here since runReleaseBuffer only ever
    // touches the client it's given, but pinning this explicitly keeps the
    // test's own math self-contained.
    process.env.MERGE_BUFFER_HOURS = String(BUFFER_HOURS);
  });

  afterEach(async () => {
    await db.teardown();
    if (originalBufferHours === undefined) delete process.env.MERGE_BUFFER_HOURS;
    else process.env.MERGE_BUFFER_HOURS = originalBufferHours;
  });

  it("a pending_merge record past the buffer is promoted once; a second run does not rewrite released_at", async () => {
    const id = await seedPublication(db.client, { status: "pending_merge", first_seen_at: hoursAgo(BUFFER_HOURS + 5) });

    const first = await runReleaseBuffer(db.client, { dryRun: false });
    expect(first.releasedCount).toBe(1);
    expect(first.released.map((r) => r.id)).toEqual([id]);

    const row1 = (await db.client.execute({ sql: "SELECT status, released_at FROM publications WHERE id = ?", args: [id] })).rows[0] as unknown as {
      status: string;
      released_at: string;
    };
    expect(row1.status).toBe("published");
    expect(row1.released_at).not.toBeNull();

    const before = await snapshotTables(db.client);
    const second = await runReleaseBuffer(db.client, { dryRun: false });
    const after = await snapshotTables(db.client);

    expect(second.releasedCount).toBe(0); // nothing left in pending_merge
    expect(() => assertReRunInvariants(before, after)).not.toThrow(); // released_at specifically must not have moved

    const row2 = (await db.client.execute({ sql: "SELECT released_at FROM publications WHERE id = ?", args: [id] })).rows[0] as unknown as { released_at: string };
    expect(row2.released_at).toBe(row1.released_at);
  });

  it("a record inside the buffer window is not promoted", async () => {
    const id = await seedPublication(db.client, { status: "pending_merge", first_seen_at: hoursAgo(BUFFER_HOURS - 5) });

    const result = await runReleaseBuffer(db.client, { dryRun: false });

    expect(result.releasedCount).toBe(0);
    expect(result.stillBufferingCount).toBe(1);
    const row = (await db.client.execute({ sql: "SELECT status, released_at FROM publications WHERE id = ?", args: [id] })).rows[0] as unknown as {
      status: string;
      released_at: string | null;
    };
    expect(row.status).toBe("pending_merge");
    expect(row.released_at).toBeNull();
  });

  it("a needs_metadata record is never promoted, regardless of age (§5a rule 8)", async () => {
    const id = await seedPublication(db.client, { status: "needs_metadata", first_seen_at: hoursAgo(1000) });

    const result = await runReleaseBuffer(db.client, { dryRun: false });

    expect(result.releasedCount).toBe(0);
    expect(result.stillBufferingCount).toBe(0); // not "buffering" either — selectForRelease ignores it outright
    expect(result.needsMetadataCount).toBe(1);
    const row = (await db.client.execute({ sql: "SELECT status FROM publications WHERE id = ?", args: [id] })).rows[0] as unknown as { status: string };
    expect(row.status).toBe("needs_metadata");
  });

  it("an already-published record with a roundup_id is untouched", async () => {
    const roundupId = await seedRoundup(db.client);
    const id = await seedPublication(db.client, { status: "published", roundup_id: roundupId, first_seen_at: hoursAgo(1000) });

    const before = await snapshotTables(db.client);
    const result = await runReleaseBuffer(db.client, { dryRun: false });
    const after = await snapshotTables(db.client);

    expect(result.releasedCount).toBe(0);
    expect(() => assertReRunInvariants(before, after)).not.toThrow();
    const row = (await db.client.execute({ sql: "SELECT roundup_id FROM publications WHERE id = ?", args: [id] })).rows[0] as unknown as { roundup_id: number };
    expect(row.roundup_id).toBe(roundupId);
  });

  it("★ a publication in an unresolved possible_duplicates pair is held back, and so is the OTHER member of the pair", async () => {
    const idA = await seedPublication(db.client, { status: "pending_merge", first_seen_at: hoursAgo(BUFFER_HOURS + 5), title: "Paper A" });
    const idB = await seedPublication(db.client, { status: "pending_merge", first_seen_at: hoursAgo(BUFFER_HOURS + 5), title: "Paper B" });
    await db.client.execute({
      sql: `INSERT INTO possible_duplicates (publication_id, candidate_publication_id, reason, detected_at) VALUES (?, ?, 'near_duplicate_title', ?)`,
      args: [idA, idB, new Date().toISOString()],
    });

    const result = await runReleaseBuffer(db.client, { dryRun: false });

    expect(result.releasedCount).toBe(0);
    expect(result.heldForDuplicateReviewCount).toBe(2);
    expect(result.heldForDuplicateReview.map((r) => r.id).sort()).toEqual([idA, idB].sort());

    const rows = (await db.client.execute("SELECT id, status FROM publications ORDER BY id")).rows as unknown as Array<{ id: number; status: string }>;
    for (const r of rows) expect(r.status).toBe("pending_merge"); // neither released, including the CANDIDATE side of the pair
  });
});
