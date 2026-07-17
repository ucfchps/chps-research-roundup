// Session 9.5: makes the possible-duplicate judgment computed in
// lib/scholar-ingest.ts's findPossibleDuplicates durable and queryable. See
// master plan §6 (possible_duplicates), §7, §15.10/§15.11. Runs against a
// real temp SQLite db (via runMigrations), same pattern as
// tests/refresh-metadata.test.ts, since the idempotency guarantee here is
// genuinely SQL (an ON CONFLICT ... DO NOTHING upsert).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { getUnresolvedDuplicatePublicationIds, recordPossibleDuplicates, resolveDuplicate } from "../lib/duplicates";

async function seedPublication(client: Client, title: string, status: "needs_metadata" | "pending_merge" = "pending_merge"): Promise<number> {
  const now = new Date().toISOString();
  const result = await client.execute({
    sql: `INSERT INTO publications (title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
          VALUES (?, ?, ?, ?, 'scholar', ?, ?, ?)`,
    args: [title, title.toLowerCase(), "https://example.com", status, now, now.slice(0, 10), now],
  });
  return Number(result.lastInsertRowid);
}

describe("lib/duplicates", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "duplicates-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("recordPossibleDuplicates writes one row per candidate", async () => {
    const newPub = await seedPublication(client, "A New Paper");
    const candidateA = await seedPublication(client, "A New Papper");
    const candidateB = await seedPublication(client, "A Newer Paper");

    await recordPossibleDuplicates(client, newPub, [candidateA, candidateB], "near_duplicate_title");

    const rows = await client.execute("SELECT * FROM possible_duplicates WHERE publication_id = ? ORDER BY candidate_publication_id", [newPub]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r) => r.candidate_publication_id)).toEqual([candidateA, candidateB]);
    expect(rows.rows[0]).toMatchObject({ reason: "near_duplicate_title", resolved_at: null, resolution: null });
  });

  it("calling it twice with the same publication/candidate pair does not duplicate rows and does not throw", async () => {
    const newPub = await seedPublication(client, "A New Paper");
    const candidate = await seedPublication(client, "A New Papper");

    await recordPossibleDuplicates(client, newPub, [candidate], "near_duplicate_title");
    await expect(recordPossibleDuplicates(client, newPub, [candidate], "near_duplicate_title")).resolves.not.toThrow();

    const rows = await client.execute("SELECT * FROM possible_duplicates WHERE publication_id = ? AND candidate_publication_id = ?", [newPub, candidate]);
    expect(rows.rows).toHaveLength(1);
  });

  it("a symmetric check: publications persisted via the insert_needs_metadata shape and the insert_resolved shape both record correctly", async () => {
    // insert_needs_metadata path: status 'needs_metadata', no DOI yet.
    const needsMetadataPub = await seedPublication(client, "Gray Lit Paper", "needs_metadata");
    const needsMetadataCandidate = await seedPublication(client, "Gray Lit Papper");
    await recordPossibleDuplicates(client, needsMetadataPub, [needsMetadataCandidate], "near_duplicate_title");

    // insert_resolved path: status 'pending_merge', already has a DOI-backed record.
    const resolvedPub = await seedPublication(client, "Resolved Paper", "pending_merge");
    const resolvedCandidate = await seedPublication(client, "Resolved Papper");
    await recordPossibleDuplicates(client, resolvedPub, [resolvedCandidate], "near_duplicate_title");

    const rows = await client.execute("SELECT publication_id, candidate_publication_id FROM possible_duplicates ORDER BY publication_id");
    expect(rows.rows).toEqual([
      { publication_id: needsMetadataPub, candidate_publication_id: needsMetadataCandidate },
      { publication_id: resolvedPub, candidate_publication_id: resolvedCandidate },
    ]);
  });

  it("getUnresolvedDuplicatePublicationIds includes an open flag's publication, excludes one where resolved_at is set", async () => {
    const openPub = await seedPublication(client, "Open Flag Paper");
    const openCandidate = await seedPublication(client, "Open Flag Papper");
    const closedPub = await seedPublication(client, "Closed Flag Paper");
    const closedCandidate = await seedPublication(client, "Closed Flag Papper");

    await recordPossibleDuplicates(client, openPub, [openCandidate]);
    await recordPossibleDuplicates(client, closedPub, [closedCandidate]);
    await resolveDuplicate(client, closedPub, closedCandidate, "not_duplicate");

    const unresolved = await getUnresolvedDuplicatePublicationIds(client);
    expect(unresolved.has(openPub)).toBe(true);
    expect(unresolved.has(openCandidate)).toBe(true);
    expect(unresolved.has(closedPub)).toBe(false);
    expect(unresolved.has(closedCandidate)).toBe(false);
  });

  it("resolveDuplicate sets resolved_at and the id then drops out of the unresolved set", async () => {
    const pub = await seedPublication(client, "Paper One");
    const candidate = await seedPublication(client, "Paper Ones");
    await recordPossibleDuplicates(client, pub, [candidate]);

    await resolveDuplicate(client, pub, candidate, "merged");

    const row = await client.execute("SELECT resolved_at, resolution FROM possible_duplicates WHERE publication_id = ? AND candidate_publication_id = ?", [pub, candidate]);
    expect(row.rows[0].resolved_at).not.toBeNull();
    expect(row.rows[0].resolution).toBe("merged");

    const unresolved = await getUnresolvedDuplicatePublicationIds(client);
    expect(unresolved.has(pub)).toBe(false);
    expect(unresolved.has(candidate)).toBe(false);
  });
});
