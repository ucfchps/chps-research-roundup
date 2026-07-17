// Pure decision logic for the release-buffer job (§9, §13 Phase 3 item 11).
// Promotes a 'pending_merge' record once it has matured past the merge
// window (§7) — this only means "safe to consider for a future roundup." It
// is NOT "posted publicly." That gate is roundup_id (§6b), applied later at
// Tab 4 finalize, and this job never touches it. No I/O here — see
// scripts/release-buffer.ts for the query/UPDATE/summary that wraps this.
import type { PublicationStatus } from "./types";

export interface ReleasableRecord {
  id: number;
  status: PublicationStatus;
  first_seen_at: string; // ISO 8601
  released_at: string | null;
}

export interface ReleaseResult {
  toRelease: number[];
  stillBuffering: Array<{ id: number; hoursRemaining: number }>;
}

const MS_PER_HOUR = 3600000;

export function selectForRelease(records: ReleasableRecord[], now: Date, bufferHours: number): ReleaseResult {
  const toRelease: number[] = [];
  const stillBuffering: Array<{ id: number; hoursRemaining: number }> = [];

  for (const record of records) {
    // Only pending_merge is ever considered. needs_metadata, published, and
    // rejected rows are ignored completely — not released, not reported as
    // buffering either. They simply don't appear in the output.
    if (record.status !== "pending_merge") continue;

    const ageHours = (now.getTime() - Date.parse(record.first_seen_at)) / MS_PER_HOUR;

    // Inclusive at the boundary (>=, not >): "held for MERGE_BUFFER_HOURS"
    // (§7) reads as a minimum hold time, not a strict one — a record exactly
    // bufferHours old has fully served its wait and releases this run.
    if (ageHours >= bufferHours) {
      toRelease.push(record.id);
    } else {
      stillBuffering.push({ id: record.id, hoursRemaining: Math.round((bufferHours - ageHours) * 10) / 10 });
    }
  }

  return { toRelease, stillBuffering };
}
