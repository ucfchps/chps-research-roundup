// Makes the possible-duplicate judgment computed in lib/scholar-ingest.ts's
// findPossibleDuplicates durable and queryable, instead of living only in the
// run's console output. See master plan §6 (possible_duplicates), §7, §15.10/§15.11.
import type { Client } from "@libsql/client";

// Upserts one row per candidate. On conflict, does nothing — re-running
// ingestion over the same email must not disturb detected_at on an
// already-known flag, and must never throw over the UNIQUE constraint.
export async function recordPossibleDuplicates(
  client: Client,
  publicationId: number,
  candidateIds: number[],
  reason?: string
): Promise<void> {
  const nowIso = new Date().toISOString();
  for (const candidateId of candidateIds) {
    await client.execute({
      sql: `INSERT INTO possible_duplicates (publication_id, candidate_publication_id, reason, detected_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(publication_id, candidate_publication_id) DO NOTHING`,
      args: [publicationId, candidateId, reason ?? null, nowIso],
    });
  }
}

// Unioned across both columns: a publication is just as "not yet safe to
// release" when it's the candidate side of an open flag as when it's the
// triggering side — release-buffer (§9, Session 10) needs to hold either one
// until a human resolves the pair.
export async function getUnresolvedDuplicatePublicationIds(client: Client): Promise<Set<number>> {
  const result = await client.execute(
    `SELECT publication_id, candidate_publication_id FROM possible_duplicates WHERE resolved_at IS NULL`
  );
  const ids = new Set<number>();
  for (const row of result.rows) {
    ids.add(Number(row.publication_id));
    ids.add(Number(row.candidate_publication_id));
  }
  return ids;
}

// No UI calls this yet — it exists so a person can clear a flag from a script
// or `turso db shell` without hand-writing the UPDATE each time.
export async function resolveDuplicate(
  client: Client,
  publicationId: number,
  candidateId: number,
  resolution: "merged" | "not_duplicate"
): Promise<void> {
  await client.execute({
    sql: `UPDATE possible_duplicates SET resolved_at = ?, resolution = ? WHERE publication_id = ? AND candidate_publication_id = ?`,
    args: [new Date().toISOString(), resolution, publicationId, candidateId],
  });
}
