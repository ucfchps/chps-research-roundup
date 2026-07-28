// §8a: the public portal's anonymous submission path. Three outcomes only
// (no "linked_you" — there's no known submitter identity to link in), and
// reuses lib/matching.ts::findMatch as-is, same as
// lib/review-actions.ts::addMissingPublication.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { submitPublication } from "../lib/portal";

describe("submitPublication", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "portal-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  async function seedExistingPublication(overrides: { title: string; doi?: string | null; roundupId?: number | null }): Promise<number> {
    const now = new Date().toISOString();
    const result = await client.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, status, source, first_seen_at, date_added, created_at, roundup_id)
            VALUES (?, ?, ?, 'https://example.com', 'published', 'crossref', ?, ?, ?, ?)`,
      args: [overrides.doi ?? null, overrides.title, overrides.title.toLowerCase(), now, now.slice(0, 10), now, overrides.roundupId ?? null],
    });
    return Number(result.lastInsertRowid);
  }

  it("no match: creates a pending_submissions row with faculty_id NULL, submitted_via='public_portal', and the full author list in payload", async () => {
    const result = await submitPublication(client, "Jane Submitter", {
      title: "A Genuinely New Paper",
      doi: null,
      url: "https://example.com/new",
      journal: "Journal of Testing",
      authors: [
        { name: "Stock, M.", role: "chps_faculty" },
        { name: "Doe, J.", role: "grad_student" },
      ],
    });

    expect(result.outcome).toBe("submitted");
    const row = (
      await client.execute({
        sql: "SELECT faculty_id, submitted_via, submitted_by, payload, status FROM pending_submissions WHERE id = ?",
        args: [result.outcome === "submitted" ? result.pendingSubmissionId : -1],
      })
    ).rows[0] as unknown as { faculty_id: number | null; submitted_via: string; submitted_by: string; payload: string; status: string };

    expect(row.faculty_id).toBeNull();
    expect(row.submitted_via).toBe("public_portal");
    expect(row.submitted_by).toBe("Jane Submitter");
    expect(row.status).toBe("pending");
    const payload = JSON.parse(row.payload);
    expect(payload.authors).toEqual([
      { name: "Stock, M.", role: "chps_faculty" },
      { name: "Doe, J.", role: "grad_student" },
    ]);
  });

  it("preserves author order/position from submission to payload", async () => {
    const result = await submitPublication(client, "Jane Submitter", {
      title: "Order Preservation Paper",
      doi: null,
      url: "https://example.com/order",
      authors: [
        { name: "Third, C.", role: "external" },
        { name: "First, A.", role: "chps_faculty" },
        { name: "Second, B.", role: "grad_student" },
      ],
    });

    expect(result.outcome).toBe("submitted");
    const row = (
      await client.execute({ sql: "SELECT payload FROM pending_submissions WHERE id = ?", args: [result.outcome === "submitted" ? result.pendingSubmissionId : -1] })
    ).rows[0] as unknown as { payload: string };
    const payload = JSON.parse(row.payload);
    expect(payload.authors.map((a: { name: string }) => a.name)).toEqual(["Third, C.", "First, A.", "Second, B."]);
  });

  it("writes the optional note to pending_submissions.note, not the payload", async () => {
    const result = await submitPublication(
      client,
      "Jane Submitter",
      { title: "Noted Paper", doi: null, url: "https://example.com/noted", authors: [{ name: "Stock, M.", role: "chps_faculty" }] },
      "Found this on the department newsletter"
    );

    expect(result.outcome).toBe("submitted");
    const row = (
      await client.execute({ sql: "SELECT note FROM pending_submissions WHERE id = ?", args: [result.outcome === "submitted" ? result.pendingSubmissionId : -1] })
    ).rows[0] as unknown as { note: string | null };
    expect(row.note).toBe("Found this on the department newsletter");
  });

  it("already-posted match (DOI): tells the submitter, creates nothing", async () => {
    await client.execute(`INSERT INTO roundups (label, generated_at, pub_count, html) VALUES ('Spring 2026', datetime('now'), 1, '<html></html>')`);
    await seedExistingPublication({ title: "Existing Posted Paper", doi: "10.1/existing", roundupId: 1 });

    const result = await submitPublication(client, "Jane Submitter", {
      title: "A different title entirely",
      doi: "10.1/existing",
      url: "https://example.com/dupe",
      authors: [{ name: "Stock, M.", role: "chps_faculty" }],
    });

    expect(result.outcome).toBe("already_posted");
    if (result.outcome === "already_posted") expect(result.roundupLabel).toBe("Spring 2026");
    const count = (await client.execute("SELECT COUNT(*) as c FROM pending_submissions")).rows[0] as unknown as { c: number };
    expect(count.c).toBe(0);
  });

  it("already-posted match (title): tells the submitter, creates nothing", async () => {
    await client.execute(`INSERT INTO roundups (label, generated_at, pub_count, html) VALUES ('Spring 2026', datetime('now'), 1, '<html></html>')`);
    await seedExistingPublication({ title: "Existing Posted By Title", roundupId: 1 });

    const result = await submitPublication(client, "Jane Submitter", {
      title: "Existing Posted By Title",
      doi: null,
      url: "https://example.com/dupe2",
      authors: [{ name: "Stock, M.", role: "chps_faculty" }],
    });

    expect(result.outcome).toBe("already_posted");
    const count = (await client.execute("SELECT COUNT(*) as c FROM pending_submissions")).rows[0] as unknown as { c: number };
    expect(count.c).toBe(0);
  });

  it("already-pending match (collected, not yet posted): tells the submitter, creates nothing", async () => {
    await seedExistingPublication({ title: "Queued Paper", doi: "10.1/queued", roundupId: null });

    const result = await submitPublication(client, "Jane Submitter", {
      title: "Queued Paper (slightly different title)",
      doi: "10.1/queued",
      url: "https://example.com/queued-dupe",
      authors: [{ name: "Stock, M.", role: "chps_faculty" }],
    });

    expect(result.outcome).toBe("already_pending");
    if (result.outcome === "already_pending") expect(result.publicationId).toBeGreaterThan(0);
    const count = (await client.execute("SELECT COUNT(*) as c FROM pending_submissions")).rows[0] as unknown as { c: number };
    expect(count.c).toBe(0);
  });
});
