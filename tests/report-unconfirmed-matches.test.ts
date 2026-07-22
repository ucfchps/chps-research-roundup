// ops-notes.md §5/§6, §13 item 10 follow-up: the durable review surface for
// buildAuthorInputs' confirmation gate (lib/scholar-ingest.ts). Every row
// with role_set_by starting 'ingest:unconfirmed' should surface here,
// regardless of source — this replaces the old console-only
// nameOnlyMatchUnconfirmed flag (ingest-crossref.ts, retired).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { fetchUnconfirmedMatches } from "../scripts/report-unconfirmed-matches";

describe("fetchUnconfirmedMatches", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "report-unconfirmed-test-"));
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

  async function seedPublication(title: string, source: string): Promise<number> {
    const now = new Date().toISOString();
    const result = await client.execute({
      sql: `INSERT INTO publications (title, title_normalized, url, doi, status, source, first_seen_at, date_added, created_at)
            VALUES (?, ?, 'https://example.com', NULL, 'pending_merge', ?, ?, ?, ?)`,
      args: [title, title.toLowerCase(), source, now, now.slice(0, 10), now],
    });
    return Number(result.lastInsertRowid);
  }

  async function seedAuthor(pubId: number, facultyId: number | null, name: string, role: string, roleSetBy: string | null): Promise<void> {
    await client.execute({
      sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, 0)`,
      args: [pubId, facultyId, name, role, roleSetBy, roleSetBy ? new Date().toISOString() : null],
    });
  }

  it("returns rows tagged 'ingest:unconfirmed*', regardless of source", async () => {
    const zhuId = await seedFaculty("Zhu, Y.");
    const stockId = await seedFaculty("Stock, M.S.");

    const crossrefPub = await seedPublication("Testing circuit-level theories of consciousness", "crossref");
    await seedAuthor(crossrefPub, zhuId, "Zhu, Y.", "unknown", "ingest:unconfirmed_name_match_conflicting_affiliation");

    const pubmedPub = await seedPublication("A PubMed-Discovered Paper", "pubmed");
    await seedAuthor(pubmedPub, stockId, "Stock, M.S.", "unknown", "ingest:unconfirmed_name_match");

    const rows = await fetchUnconfirmedMatches(client);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source).sort()).toEqual(["crossref", "pubmed"]);
    expect(rows.find((r) => r.source === "crossref")).toMatchObject({
      title: "Testing circuit-level theories of consciousness",
      facultyId: zhuId,
      facultyDisplayName: "Zhu, Y.",
      roleSetBy: "ingest:unconfirmed_name_match_conflicting_affiliation",
    });
  });

  it("excludes a confirmed match (role_set_by = 'ingest')", async () => {
    const facultyId = await seedFaculty("Zraick, R.I.");
    const pub = await seedPublication("A Confirmed Paper", "crossref");
    await seedAuthor(pub, facultyId, "Zraick, R.I.", "chps_faculty", "ingest");

    const rows = await fetchUnconfirmedMatches(client);
    expect(rows).toEqual([]);
  });

  it("excludes a human-reviewed role (role_set_by starting 'faculty:' or 'comms:')", async () => {
    const facultyId = await seedFaculty("Someone, S.");
    const pub = await seedPublication("A Human Reviewed Paper", "scholar");
    await seedAuthor(pub, facultyId, "Someone, S.", "grad_student", "faculty:1");

    const rows = await fetchUnconfirmedMatches(client);
    expect(rows).toEqual([]);
  });

  it("excludes a genuine stranger (role_set_by null, no roster match at all)", async () => {
    const pub = await seedPublication("Someone Else's Paper", "crossref");
    await seedAuthor(pub, null, "Nobody, N.", "unknown", null);

    const rows = await fetchUnconfirmedMatches(client);
    expect(rows).toEqual([]);
  });
});
