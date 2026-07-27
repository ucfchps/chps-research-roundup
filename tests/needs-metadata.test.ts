// §8c Tab 2 (Session 25): the manual completion path for a needs_metadata
// stub. Exercises the real mergeAuthors/mergeMetadata machinery (never a
// parallel write path) against a throwaway temp-file DB — same harness
// shape as tests/roundup-finalize.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { completeNeedsMetadataRecord } from "../lib/needs-metadata";

describe("completeNeedsMetadataRecord", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "needs-metadata-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  async function seedFaculty(displayName: string, unit: string): Promise<number> {
    const result = await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, unit, active) VALUES (?, ?, ?, ?, 1)`,
      args: [displayName, displayName, displayName, unit],
    });
    return Number(result.lastInsertRowid);
  }

  async function seedNeedsMetadataPub(overrides: { title?: string; firstSeenAt?: string } = {}): Promise<number> {
    const firstSeenAt = overrides.firstSeenAt ?? "2025-01-01T00:00:00.000Z";
    const title = overrides.title ?? "A Gray-Lit Paper Scholar Found";
    const result = await client.execute({
      sql: `INSERT INTO publications (title, title_normalized, url, year, status, source, first_seen_at, date_added, created_at)
            VALUES (?, ?, 'https://scholar.google.com/scholar_url?url=x', 2026, 'needs_metadata', 'scholar', ?, ?, ?)`,
      args: [title, title.toLowerCase(), firstSeenAt, firstSeenAt.slice(0, 10), firstSeenAt],
    });
    return Number(result.lastInsertRowid);
  }

  const BASE_PARAMS = {
    completedBy: "Test Reviewer",
    journal: "Journal of Testing",
    volume: "12",
    issue: "3",
    pages: "100-110",
    doi: null,
    acknowledgedMissingJournal: false,
    acknowledgedZeroLinkedAuthors: false,
  };

  it("transitions needs_metadata -> pending_merge, resets first_seen_at, sets role_set_by to comms:{user} on every author row", async () => {
    const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
    const pubId = await seedNeedsMetadataPub({ firstSeenAt: "2025-01-01T00:00:00.000Z" });

    const result = await completeNeedsMetadataRecord(client, pubId, {
      ...BASE_PARAMS,
      authors: [{ name: "Stock, M.", facultyId, role: "chps_faculty" }],
    });

    expect(result.outcome).toBe("completed");

    const pubRow = (await client.execute({ sql: "SELECT status, first_seen_at FROM publications WHERE id = ?", args: [pubId] })).rows[0] as unknown as {
      status: string;
      first_seen_at: string;
    };
    expect(pubRow.status).toBe("pending_merge");
    expect(pubRow.first_seen_at).not.toBe("2025-01-01T00:00:00.000Z"); // reset to now, not preserved

    const authorRows = (await client.execute({ sql: "SELECT * FROM publication_authors WHERE publication_id = ?", args: [pubId] })).rows as unknown as Array<{
      role_set_by: string;
    }>;
    expect(authorRows).toHaveLength(1);
    expect(authorRows[0].role_set_by).toBe("comms:Test Reviewer");
  });

  it("author position/order survives exactly as entered (array order), no silent reordering", async () => {
    // mergeAuthors assigns a genuinely-new author's DB position from its
    // ARRIVAL ORDER in the incoming array (lib/matching.ts:180's
    // `position: merged.length`), not from a caller-supplied position value
    // — see the comment on CompleteAuthorInput.position. The form must
    // submit authors already in final display order; that's what this
    // exercises, not an independently-authoritative position field.
    const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
    const pubId = await seedNeedsMetadataPub();

    await completeNeedsMetadataRecord(client, pubId, {
      ...BASE_PARAMS,
      authors: [
        { name: "First, A.", facultyId, role: "chps_faculty" },
        { name: "Second, B.", facultyId: null, role: "grad_student" },
        { name: "Third, C.", facultyId: null, role: "external" },
      ],
    });

    const rows = (
      await client.execute({ sql: "SELECT name, position FROM publication_authors WHERE publication_id = ? ORDER BY position", args: [pubId] })
    ).rows as unknown as Array<{ name: string; position: number }>;
    expect(rows.map((r) => r.name)).toEqual(["First, A.", "Second, B.", "Third, C."]);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it("derives units correctly post-save via the real unitsForPublication, not reimplemented", async () => {
    const facultyId = await seedFaculty("Chapple, R.", "School of Social Work");
    const pubId = await seedNeedsMetadataPub();

    const result = await completeNeedsMetadataRecord(client, pubId, {
      ...BASE_PARAMS,
      authors: [{ name: "Chapple, R.", facultyId, role: "chps_faculty" }],
    });

    expect(result.outcome).toBe("completed");
    expect(result.outcome === "completed" && result.units).toEqual(["School of Social Work"]);
  });

  it("pre-populated (existing) author rows are merged, not discarded, when the form submits on top of them", async () => {
    const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
    const pubId = await seedNeedsMetadataPub();
    // Simulate a needs_metadata record that DID arrive with a partial author
    // (not possible for any real source today per Session 25 recon, but the
    // merge machinery must still handle it correctly if that ever changes).
    await client.execute({
      sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, position) VALUES (?, NULL, 'Stock, M.', 'unknown', NULL, 0)`,
      args: [pubId],
    });

    await completeNeedsMetadataRecord(client, pubId, {
      ...BASE_PARAMS,
      authors: [{ name: "Stock, M.", facultyId, role: "chps_faculty" }],
    });

    const rows = (await client.execute({ sql: "SELECT * FROM publication_authors WHERE publication_id = ?", args: [pubId] })).rows as unknown as Array<{
      id: number;
      name: string;
      faculty_id: number | null;
      role: string;
    }>;
    // Same row updated in place (matched by normalized name), not duplicated.
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Stock, M.");
    expect(rows[0].faculty_id).toBe(facultyId);
    expect(rows[0].role).toBe("chps_faculty");
  });

  it("blocks save when journal is missing and not acknowledged", async () => {
    const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
    const pubId = await seedNeedsMetadataPub();

    await expect(
      completeNeedsMetadataRecord(client, pubId, {
        ...BASE_PARAMS,
        journal: null,
        acknowledgedMissingJournal: false,
        authors: [{ name: "Stock, M.", facultyId, role: "chps_faculty" }],
      })
    ).rejects.toThrow(/journal/i);

    const pubRow = (await client.execute({ sql: "SELECT status FROM publications WHERE id = ?", args: [pubId] })).rows[0] as unknown as { status: string };
    expect(pubRow.status).toBe("needs_metadata"); // nothing written
  });

  it("allows save when journal is missing but explicitly acknowledged", async () => {
    const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
    const pubId = await seedNeedsMetadataPub();

    const result = await completeNeedsMetadataRecord(client, pubId, {
      ...BASE_PARAMS,
      journal: null,
      acknowledgedMissingJournal: true,
      authors: [{ name: "Stock, M.", facultyId, role: "chps_faculty" }],
    });
    expect(result.outcome).toBe("completed");
  });

  it("blocks save when there's no linked chps_faculty author and it's not acknowledged (mirrors FinalizePanel's zero-unit gate)", async () => {
    const pubId = await seedNeedsMetadataPub();

    await expect(
      completeNeedsMetadataRecord(client, pubId, {
        ...BASE_PARAMS,
        acknowledgedZeroLinkedAuthors: false,
        authors: [{ name: "Somebody, S.", facultyId: null, role: "external" }],
      })
    ).rejects.toThrow(/linked CHPS faculty|unit/i);

    const pubRow = (await client.execute({ sql: "SELECT status FROM publications WHERE id = ?", args: [pubId] })).rows[0] as unknown as { status: string };
    expect(pubRow.status).toBe("needs_metadata");
  });

  it("allows save with zero linked chps_faculty authors when explicitly acknowledged", async () => {
    const pubId = await seedNeedsMetadataPub();

    const result = await completeNeedsMetadataRecord(client, pubId, {
      ...BASE_PARAMS,
      acknowledgedZeroLinkedAuthors: true,
      authors: [{ name: "Somebody, S.", facultyId: null, role: "external" }],
    });
    expect(result.outcome).toBe("completed");
    expect(result.outcome === "completed" && result.units).toEqual([]);
  });

  it("DOI is optional — save succeeds with doi: null (gray lit frequently has none)", async () => {
    const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
    const pubId = await seedNeedsMetadataPub();

    const result = await completeNeedsMetadataRecord(client, pubId, {
      ...BASE_PARAMS,
      doi: null,
      authors: [{ name: "Stock, M.", facultyId, role: "chps_faculty" }],
    });
    expect(result.outcome).toBe("completed");

    const pubRow = (await client.execute({ sql: "SELECT doi FROM publications WHERE id = ?", args: [pubId] })).rows[0] as unknown as { doi: string | null };
    expect(pubRow.doi).toBeNull();
  });

  it("a race where the record was already promoted before save is detected and handled without corrupting either write", async () => {
    const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
    const pubId = await seedNeedsMetadataPub();

    // Simulate lib/matching.ts::promoteFromNeedsMetadata firing between form
    // load and this save (a real automatic ingestion run finding a DOI).
    await client.execute({ sql: "UPDATE publications SET status = 'pending_merge' WHERE id = ?", args: [pubId] });

    const result = await completeNeedsMetadataRecord(client, pubId, {
      ...BASE_PARAMS,
      authors: [{ name: "Stock, M.", facultyId, role: "chps_faculty" }],
    });

    expect(result).toEqual({ outcome: "already_promoted", publicationId: pubId, currentStatus: "pending_merge" });

    // Nothing corrupted: no author rows were written by the aborted manual save.
    const authorRows = await client.execute({ sql: "SELECT * FROM publication_authors WHERE publication_id = ?", args: [pubId] });
    expect(authorRows.rows).toHaveLength(0);
  });

  it("throws for a publication id that doesn't exist", async () => {
    await expect(completeNeedsMetadataRecord(client, 999999, { ...BASE_PARAMS, authors: [] })).rejects.toThrow(/no publication found/i);
  });

  it("returns already_promoted (not a silent no-op, not a throw) when attempting to complete a publication that isn't needs_metadata", async () => {
    const pubId = await seedNeedsMetadataPub();
    await client.execute({ sql: "UPDATE publications SET status = 'published' WHERE id = ?", args: [pubId] });

    const result = await completeNeedsMetadataRecord(client, pubId, { ...BASE_PARAMS, authors: [] });
    expect(result).toEqual({ outcome: "already_promoted", publicationId: pubId, currentStatus: "published" });
  });
});
