import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { recordPossibleDuplicates, resolveDuplicate } from "../lib/duplicates";
import { selectForRelease, type ReleasableRecord } from "../lib/release";
import { runReleaseBuffer } from "../scripts/release-buffer";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const BUFFER_HOURS = 60;

function record(overrides: Partial<ReleasableRecord>): ReleasableRecord {
  return { id: 1, status: "pending_merge", first_seen_at: NOW.toISOString(), released_at: null, ...overrides };
}

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3600000).toISOString();
}

describe("selectForRelease", () => {
  it("a record older than the buffer releases", () => {
    const r = record({ id: 1, first_seen_at: hoursAgo(61) });
    const result = selectForRelease([r], NOW, BUFFER_HOURS);
    expect(result.toRelease).toEqual([1]);
    expect(result.stillBuffering).toEqual([]);
  });

  it("a record exactly at the buffer boundary releases (inclusive)", () => {
    const r = record({ id: 1, first_seen_at: hoursAgo(60) });
    const result = selectForRelease([r], NOW, BUFFER_HOURS);
    expect(result.toRelease).toEqual([1]);
    expect(result.stillBuffering).toEqual([]);
  });

  it("a record one minute short of the buffer does not release, with correct hoursRemaining", () => {
    const r = record({ id: 1, first_seen_at: hoursAgo(59 + 59 / 60) }); // 59h59m old, 1 minute short
    const result = selectForRelease([r], NOW, BUFFER_HOURS);
    expect(result.toRelease).toEqual([]);
    expect(result.stillBuffering).toHaveLength(1);
    expect(result.stillBuffering[0].id).toBe(1);
    // 1 minute = 0.0166...h remaining, rounded to one decimal place = 0.0h
    expect(result.stillBuffering[0].hoursRemaining).toBeCloseTo(1 / 60, 1);
  });

  it("a needs_metadata record, however old, never appears in either bucket", () => {
    const r = record({ id: 1, status: "needs_metadata", first_seen_at: hoursAgo(1000) });
    const result = selectForRelease([r], NOW, BUFFER_HOURS);
    expect(result.toRelease).toEqual([]);
    expect(result.stillBuffering).toEqual([]);
  });

  it("an already-published record never appears in either bucket", () => {
    const r = record({ id: 1, status: "published", first_seen_at: hoursAgo(1000), released_at: hoursAgo(1) });
    const result = selectForRelease([r], NOW, BUFFER_HOURS);
    expect(result.toRelease).toEqual([]);
    expect(result.stillBuffering).toEqual([]);
  });

  it("a rejected record never appears in either bucket", () => {
    const r = record({ id: 1, status: "rejected", first_seen_at: hoursAgo(1000) });
    const result = selectForRelease([r], NOW, BUFFER_HOURS);
    expect(result.toRelease).toEqual([]);
    expect(result.stillBuffering).toEqual([]);
  });

  it("empty input -> empty output, no throw", () => {
    const result = selectForRelease([], NOW, BUFFER_HOURS);
    expect(result).toEqual({ toRelease: [], stillBuffering: [] });
  });

  it("never mutates the input array", () => {
    const records = [record({ id: 1, first_seen_at: hoursAgo(61) })];
    const snapshot = JSON.parse(JSON.stringify(records));
    selectForRelease(records, NOW, BUFFER_HOURS);
    expect(records).toEqual(snapshot);
  });

  it("a mixed batch of all four statuses buckets each row correctly", () => {
    const records = [
      record({ id: 1, status: "pending_merge", first_seen_at: hoursAgo(100) }), // releases
      record({ id: 2, status: "pending_merge", first_seen_at: hoursAgo(10) }), // still buffering
      record({ id: 3, status: "needs_metadata", first_seen_at: hoursAgo(1000) }), // ignored
      record({ id: 4, status: "published", first_seen_at: hoursAgo(1000), released_at: hoursAgo(500) }), // ignored
      record({ id: 5, status: "rejected", first_seen_at: hoursAgo(1000) }), // ignored
    ];

    const result = selectForRelease(records, NOW, BUFFER_HOURS);
    expect(result.toRelease).toEqual([1]);
    expect(result.stillBuffering).toEqual([{ id: 2, hoursRemaining: 50.0 }]);
  });
});

// The duplicate-hold filter lives in scripts/release-buffer.ts, not
// lib/release.ts: selectForRelease stays pure (no DB access), and checking
// possible_duplicates is inherently I/O. So this is an integration test
// against a real temp SQLite db (via runMigrations), same pattern as
// tests/duplicates.test.ts and tests/refresh-metadata.test.ts.
describe("runReleaseBuffer — duplicate hold (§7 possible_duplicates gate)", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "release-buffer-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  // Well past any reasonable MERGE_BUFFER_HOURS (default 60) so this is
  // never accidentally still-buffering regardless of the configured value.
  async function seedPendingMerge(title: string): Promise<number> {
    const firstSeenAt = new Date(Date.now() - 1000 * 3600000).toISOString();
    const result = await client.execute({
      sql: `INSERT INTO publications (title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
            VALUES (?, ?, ?, 'pending_merge', 'scholar', ?, ?, ?)`,
      args: [title, title.toLowerCase(), "https://example.com", firstSeenAt, firstSeenAt.slice(0, 10), firstSeenAt],
    });
    return Number(result.lastInsertRowid);
  }

  it("a pending_merge record past the buffer window with an unresolved possible_duplicates entry is held, not released", async () => {
    const pubId = await seedPendingMerge("Paper A");
    const candidateId = await seedPendingMerge("Paper A (candidate)");
    await recordPossibleDuplicates(client, pubId, [candidateId], "near_duplicate_title");

    const summary = await runReleaseBuffer(client, { dryRun: false });

    expect(summary.releasedCount).toBe(0);
    // Both sides of an open flag are held (getUnresolvedDuplicatePublicationIds
    // unions publication_id and candidate_publication_id — see lib/duplicates.ts).
    expect(summary.heldForDuplicateReviewCount).toBe(2);
    expect(summary.heldForDuplicateReview.map((r) => r.id).sort()).toEqual([pubId, candidateId].sort());

    const row = await client.execute("SELECT status, released_at FROM publications WHERE id = ?", [pubId]);
    expect(row.rows[0].status).toBe("pending_merge");
    expect(row.rows[0].released_at).toBeNull();

    const candidateRow = await client.execute("SELECT status, released_at FROM publications WHERE id = ?", [candidateId]);
    expect(candidateRow.rows[0].status).toBe("pending_merge");
    expect(candidateRow.rows[0].released_at).toBeNull();
  });

  it("the same record releases normally once resolved_at is set", async () => {
    const pubId = await seedPendingMerge("Paper B");
    const candidateId = await seedPendingMerge("Paper B (candidate)");
    await recordPossibleDuplicates(client, pubId, [candidateId], "near_duplicate_title");
    await resolveDuplicate(client, pubId, candidateId, "not_duplicate");

    const summary = await runReleaseBuffer(client, { dryRun: false });

    expect(summary.heldForDuplicateReviewCount).toBe(0);
    expect(summary.releasedCount).toBe(2);
    expect(summary.released.map((r) => r.id).sort()).toEqual([pubId, candidateId].sort());

    const row = await client.execute("SELECT status, released_at FROM publications WHERE id = ?", [pubId]);
    expect(row.rows[0].status).toBe("published");
    expect(row.rows[0].released_at).not.toBeNull();

    const candidateRow = await client.execute("SELECT status, released_at FROM publications WHERE id = ?", [candidateId]);
    expect(candidateRow.rows[0].status).toBe("published");
    expect(candidateRow.rows[0].released_at).not.toBeNull();
  });
});
