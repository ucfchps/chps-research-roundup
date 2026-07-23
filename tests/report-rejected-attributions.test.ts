// §8b item 6: "This isn't my paper" (lib/review-actions.ts::rejectAuthorAttribution)
// writes role_set_by = 'faculty:{id}:rejected' and quietly reverts the row to
// an anonymous, unlinked 'unknown' stub — this is the durable surface that
// makes those rejections visible to COMMS, mirroring
// scripts/report-unconfirmed-matches.ts's shape.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { fetchRejectedAttributions } from "../scripts/report-rejected-attributions";

describe("fetchRejectedAttributions", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "report-rejected-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  async function seedFaculty(displayName: string): Promise<number> {
    const result = await client.execute({
      sql: `INSERT INTO faculty (wp_id, display_name, unit, active) VALUES (?, ?, 'Department of Health Sciences', 1)`,
      args: [displayName, displayName],
    });
    return Number(result.lastInsertRowid);
  }

  async function seedPublication(title: string): Promise<number> {
    const now = new Date().toISOString();
    const result = await client.execute({
      sql: `INSERT INTO publications (title, title_normalized, url, doi, status, source, first_seen_at, date_added, created_at)
            VALUES (?, ?, 'https://example.com', NULL, 'pending_merge', 'crossref', ?, ?, ?)`,
      args: [title, title.toLowerCase(), now, now.slice(0, 10), now],
    });
    return Number(result.lastInsertRowid);
  }

  async function seedAuthor(pubId: number, facultyId: number | null, name: string, role: string, roleSetBy: string | null): Promise<void> {
    await client.execute({
      sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, 0)`,
      args: [pubId, facultyId, name, role, roleSetBy, roleSetBy ? new Date().toISOString() : null],
    });
  }

  it("returns rows tagged 'faculty:{id}:rejected'", async () => {
    const pub = await seedPublication("A Wrongly Attributed Paper");
    await seedAuthor(pub, null, "Zhu, Y.", "unknown", "faculty:23:rejected");

    const rows = await fetchRejectedAttributions(client);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "A Wrongly Attributed Paper",
      authorName: "Zhu, Y.",
      roleSetBy: "faculty:23:rejected",
    });
  });

  it("excludes a normal human confirmation (role_set_by = 'faculty:{id}', no ':rejected' suffix)", async () => {
    const facultyId = await seedFaculty("Zraick, R.I.");
    const pub = await seedPublication("A Confirmed Paper");
    await seedAuthor(pub, facultyId, "Zraick, R.I.", "chps_faculty", `faculty:${facultyId}`);

    const rows = await fetchRejectedAttributions(client);
    expect(rows).toEqual([]);
  });

  it("excludes an unconfirmed ingest match (role_set_by starting 'ingest:unconfirmed')", async () => {
    const facultyId = await seedFaculty("Zhu, Y.");
    const pub = await seedPublication("Testing circuit-level theories of consciousness");
    await seedAuthor(pub, facultyId, "Zhu, Y.", "unknown", "ingest:unconfirmed_name_match");

    const rows = await fetchRejectedAttributions(client);
    expect(rows).toEqual([]);
  });
});
