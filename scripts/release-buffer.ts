// Promotes matured 'pending_merge' publications to 'published' once they've
// cleared MERGE_BUFFER_HOURS (§7, §9, §13 Phase 3 item 11). 'published' here
// means "past the merge window, safe to consider for a future roundup" — NOT
// posted publicly. Posting to WordPress is gated separately by roundup_id
// (§6b), set later at Tab 4 finalize; this job never touches roundup_id and
// never looks at needs_metadata rows. Run with:
//   npm run release:buffer -- --dry-run
//   npm run release:buffer
import { config } from "dotenv";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { selectForRelease, type ReleasableRecord } from "../lib/release";

config({ path: path.join(__dirname, "..", ".env.local") });

const DEFAULT_BUFFER_HOURS = 60;

function readBufferHours(): number {
  const raw = process.env.MERGE_BUFFER_HOURS;
  if (!raw) {
    console.error(`⚠ MERGE_BUFFER_HOURS not set — defaulting to ${DEFAULT_BUFFER_HOURS}`);
    return DEFAULT_BUFFER_HOURS;
  }
  return Number(raw);
}

interface PendingRow extends ReleasableRecord {
  title: string;
}

export interface RunSummary {
  bufferHours: number;
  releasedCount: number;
  released: { id: number; title: string }[];
  stillBufferingCount: number;
  soonest: { id: number; title: string; hoursRemaining: number; releaseAt: string } | null;
  needsMetadataCount: number;
  dryRun: boolean;
}

export async function runReleaseBuffer(client: Client, opts: { dryRun: boolean }): Promise<RunSummary> {
  const bufferHours = readBufferHours();
  const now = new Date();

  const pending = (
    await client.execute("SELECT id, title, status, first_seen_at, released_at FROM publications WHERE status = 'pending_merge'")
  ).rows as unknown as PendingRow[];
  const byId = new Map(pending.map((p) => [p.id, p]));

  const { toRelease, stillBuffering } = selectForRelease(pending, now, bufferHours);

  // TODO(session-9.5): once possible_duplicates + getUnresolvedDuplicatePublicationIds
  // (lib/duplicates.ts) land, filter toRelease here — drop any id present in
  // that unresolved set so a flagged possible duplicate is held out of
  // release until a human resolves it. One-function edit: nothing to wire up
  // yet, the table doesn't exist this session.
  if (!opts.dryRun && toRelease.length > 0) {
    const placeholders = toRelease.map(() => "?").join(", ");
    // Re-assert status = 'pending_merge' even though we just selected on it —
    // defensive in case this run overlaps an ingestion run touching the same row.
    await client.execute({
      sql: `UPDATE publications SET status = 'published', released_at = ? WHERE id IN (${placeholders}) AND status = 'pending_merge'`,
      args: [now.toISOString(), ...toRelease],
    });
  }

  const needsMetadataCount = Number(
    (await client.execute("SELECT COUNT(*) as n FROM publications WHERE status = 'needs_metadata'")).rows[0].n
  );

  const soonestBuffering =
    stillBuffering.length > 0 ? stillBuffering.reduce((min, r) => (r.hoursRemaining < min.hoursRemaining ? r : min)) : null;
  const soonestRecord = soonestBuffering ? byId.get(soonestBuffering.id) : undefined;

  return {
    bufferHours,
    releasedCount: toRelease.length,
    released: toRelease.map((id) => ({ id, title: byId.get(id)!.title })),
    stillBufferingCount: stillBuffering.length,
    soonest:
      soonestBuffering && soonestRecord
        ? {
            id: soonestBuffering.id,
            title: soonestRecord.title,
            hoursRemaining: soonestBuffering.hoursRemaining,
            releaseAt: new Date(Date.parse(soonestRecord.first_seen_at) + bufferHours * 3600000).toISOString(),
          }
        : null,
    needsMetadataCount,
    dryRun: opts.dryRun,
  };
}

function printSummary(s: RunSummary): void {
  if (s.dryRun) console.log("--dry-run: no UPDATE will be issued.\n");
  console.log(`MERGE_BUFFER_HOURS = ${s.bufferHours}`);

  if (s.releasedCount > 0) {
    console.log(`\n${s.releasedCount} released this run${s.dryRun ? " (dry-run — not written)" : ""}:`);
    for (const r of s.released) console.log(`  [${r.id}] ${r.title}`);
  } else if (s.soonest) {
    console.log(`\n0 released this run. Soonest release: [${s.soonest.id}] "${s.soonest.title}" at ${s.soonest.releaseAt}.`);
  } else {
    console.log(`\n0 released this run. Nothing currently buffering, either.`);
  }

  console.log(
    `\n${s.stillBufferingCount} still buffering` +
      (s.soonest ? ` (soonest: [${s.soonest.id}] "${s.soonest.title}", ${s.soonest.hoursRemaining}h remaining)` : "") +
      "."
  );

  console.log(`\n${s.needsMetadataCount} sitting in needs_metadata right now — not touched by this job; awaiting the incomplete-records admin queue.`);

  console.log(
    `\nNote: duplicate-detection gate not yet wired (Session 9.5 pending) — records released this run were not checked against possible-duplicate signals.`
  );
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");

  const dryRun = process.argv.includes("--dry-run");
  const client = createClient({ url, authToken });
  const summary = await runReleaseBuffer(client, { dryRun });
  printSummary(summary);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
