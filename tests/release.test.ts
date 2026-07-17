import { describe, expect, it } from "vitest";
import { selectForRelease, type ReleasableRecord } from "../lib/release";

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
