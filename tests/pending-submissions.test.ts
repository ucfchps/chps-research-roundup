// §8c Tab 1 (Session 26): approve/reject against a throwaway temp-file DB.
// Submissions are seeded via the REAL addMissingPublication — same "one
// implementation, not a parallel fixture" discipline as everywhere else —
// so these tests exercise the actual production write path's output shape,
// not a hand-guessed one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { addMissingPublication } from "../lib/review-actions";
import { approvePendingSubmission, rejectPendingSubmission, checkForStaleMatch, listPendingSubmissions } from "../lib/pending-submissions";

describe("pending submissions — approve/reject", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "pending-submissions-test-"));
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

  async function seedSubmission(facultyId: number, title: string, overrides: Partial<{ doi: string | null; journal: string | null }> = {}): Promise<number> {
    const outcome = await addMissingPublication(client, facultyId, {
      title,
      doi: overrides.doi ?? null,
      url: "https://example.com/paper",
      journal: overrides.journal ?? null,
      year: 2026,
      volume: null,
      issue: null,
      pages: null,
    });
    if (outcome.outcome !== "pending_submission") throw new Error(`Expected a fresh pending_submission, got ${outcome.outcome}`);
    return outcome.pendingSubmissionId;
  }

  const BASE_APPROVE = { reviewedBy: "COMMS Reviewer", doi: null, url: "https://example.com/paper", journal: "Journal of Testing", year: 2026, volume: "1", issue: "1", pages: "1-10" };

  it("approve creates a publications row + author rows, status='published', source='manual'", async () => {
    const facultyId = await seedFaculty("Stock, M.", "School of Kinesiology and Rehabilitation Sciences");
    const subId = await seedSubmission(facultyId, "A Real Self-Submitted Paper");

    const result = await approvePendingSubmission(client, subId, {
      ...BASE_APPROVE,
      title: "A Real Self-Submitted Paper",
      authors: [{ name: "Stock, M.", facultyId, role: "chps_faculty" }],
    });

    expect(result.outcome).toBe("created");
    const pubId = result.outcome === "created" ? result.publicationId : -1;
    const pub = (await client.execute({ sql: "SELECT status, source, title FROM publications WHERE id = ?", args: [pubId] })).rows[0] as unknown as {
      status: string;
      source: string;
      title: string;
    };
    expect(pub.status).toBe("published");
    expect(pub.source).toBe("manual");
    expect(pub.title).toBe("A Real Self-Submitted Paper");
  });

  it("submitter is auto-linked as chps_faculty via faculty_id even when the reviewer's author list omits them", async () => {
    const facultyId = await seedFaculty("Stock, M.", "School of Kinesiology and Rehabilitation Sciences");
    const subId = await seedSubmission(facultyId, "Submitter Omitted From Author List");

    const result = await approvePendingSubmission(client, subId, {
      ...BASE_APPROVE,
      title: "Submitter Omitted From Author List",
      authors: [{ name: "Somebody Else", facultyId: null, role: "external" }], // deliberately doesn't include the submitter
    });

    expect(result.outcome).toBe("created");
    const pubId = result.outcome === "created" ? result.publicationId : -1;
    const authors = (await client.execute({ sql: "SELECT * FROM publication_authors WHERE publication_id = ?", args: [pubId] })).rows as unknown as Array<{
      faculty_id: number | null;
      role: string;
      role_set_by: string;
    }>;
    const submitterRow = authors.find((a) => a.faculty_id === facultyId);
    expect(submitterRow).toBeTruthy();
    expect(submitterRow?.role).toBe("chps_faculty");
    expect(submitterRow?.role_set_by).toBe(`faculty:${facultyId}`);
  });

  it("a co-author the reviewer adds (not the submitter) gets comms:{user} provenance, not faculty:", async () => {
    const facultyId = await seedFaculty("Stock, M.", "School of Kinesiology and Rehabilitation Sciences");
    const coFacultyId = await seedFaculty("Chapple, R.", "School of Social Work");
    const subId = await seedSubmission(facultyId, "Paper With A Co-Author The Reviewer Adds");

    const result = await approvePendingSubmission(client, subId, {
      ...BASE_APPROVE,
      title: "Paper With A Co-Author The Reviewer Adds",
      authors: [
        { name: "Stock, M.", facultyId, role: "chps_faculty" },
        { name: "Chapple, R.", facultyId: coFacultyId, role: "chps_faculty" },
      ],
    });
    expect(result.outcome).toBe("created");
    const pubId = result.outcome === "created" ? result.publicationId : -1;
    const authors = (await client.execute({ sql: "SELECT * FROM publication_authors WHERE publication_id = ?", args: [pubId] })).rows as unknown as Array<{
      faculty_id: number | null;
      role_set_by: string;
    }>;
    expect(authors.find((a) => a.faculty_id === facultyId)?.role_set_by).toBe(`faculty:${facultyId}`);
    expect(authors.find((a) => a.faculty_id === coFacultyId)?.role_set_by).toBe("comms:COMMS Reviewer");
  });

  it("editing a field before approving is what gets written, not the original raw payload", async () => {
    const facultyId = await seedFaculty("Stock, M.", "School of Kinesiology and Rehabilitation Sciences");
    const subId = await seedSubmission(facultyId, "Original Title Before Review", { journal: null });

    const result = await approvePendingSubmission(client, subId, {
      ...BASE_APPROVE,
      title: "Corrected Title The Reviewer Fixed",
      journal: "Journal COMMS Filled In",
      authors: [{ name: "Stock, M.", facultyId, role: "chps_faculty" }],
    });

    expect(result.outcome).toBe("created");
    const pubId = result.outcome === "created" ? result.publicationId : -1;
    const pub = (await client.execute({ sql: "SELECT title, journal FROM publications WHERE id = ?", args: [pubId] })).rows[0] as unknown as {
      title: string;
      journal: string;
    };
    expect(pub.title).toBe("Corrected Title The Reviewer Fixed");
    expect(pub.journal).toBe("Journal COMMS Filled In");
  });

  it("author position/order survives from the reviewer's form order into the approved publication", async () => {
    const facultyId = await seedFaculty("Stock, M.", "School of Kinesiology and Rehabilitation Sciences");
    const subId = await seedSubmission(facultyId, "Order-Sensitive Paper");

    const result = await approvePendingSubmission(client, subId, {
      ...BASE_APPROVE,
      title: "Order-Sensitive Paper",
      authors: [
        { name: "First, A.", facultyId: null, role: "external" },
        { name: "Stock, M.", facultyId, role: "chps_faculty" },
        { name: "Third, C.", facultyId: null, role: "external" },
      ],
    });
    expect(result.outcome).toBe("created");
    const pubId = result.outcome === "created" ? result.publicationId : -1;
    const rows = (
      await client.execute({ sql: "SELECT name, position FROM publication_authors WHERE publication_id = ? ORDER BY position", args: [pubId] })
    ).rows as unknown as Array<{ name: string; position: number }>;
    expect(rows.map((r) => r.name)).toEqual(["First, A.", "Stock, M.", "Third, C."]);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it("reject leaves publications untouched and marks the submission rejected", async () => {
    const facultyId = await seedFaculty("Stock, M.", "School of Kinesiology and Rehabilitation Sciences");
    const subId = await seedSubmission(facultyId, "A Paper To Reject");

    const result = await rejectPendingSubmission(client, subId, "COMMS Reviewer");
    expect(result.outcome).toBe("rejected");

    const pubCount = (await client.execute("SELECT COUNT(*) as c FROM publications")).rows[0] as unknown as { c: number };
    expect(pubCount.c).toBe(0);
    const sub = (await client.execute({ sql: "SELECT status, reviewed_by FROM pending_submissions WHERE id = ?", args: [subId] })).rows[0] as unknown as {
      status: string;
      reviewed_by: string;
    };
    expect(sub.status).toBe("rejected");
    expect(sub.reviewed_by).toBe("COMMS Reviewer");
  });

  it("staleness race: a matching publication landed via ingestion after submission — approve links the submitter to it instead of creating a duplicate", async () => {
    const facultyId = await seedFaculty("Stock, M.", "School of Kinesiology and Rehabilitation Sciences");
    const subId = await seedSubmission(facultyId, "Paper That Gets Independently Ingested", { doi: "10.1/raced" });

    // Simulate routine ingestion discovering the same paper (by DOI) after
    // the submission but before review.
    const now = new Date().toISOString();
    const racedResult = await client.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
            VALUES ('10.1/raced', 'Paper That Gets Independently Ingested', 'paper that gets independently ingested', 'https://example.com/raced', 'published', 'crossref', ?, ?, ?)`,
      args: [now, now.slice(0, 10), now],
    });
    const racedPubId = Number(racedResult.lastInsertRowid);

    const result = await approvePendingSubmission(client, subId, {
      ...BASE_APPROVE,
      doi: "10.1/raced",
      title: "Paper That Gets Independently Ingested",
      authors: [{ name: "Stock, M.", facultyId, role: "chps_faculty" }],
    });

    expect(result).toEqual({ outcome: "linked_existing", publicationId: racedPubId });

    const pubCount = (await client.execute("SELECT COUNT(*) as c FROM publications")).rows[0] as unknown as { c: number };
    expect(pubCount.c).toBe(1); // no duplicate created

    const authors = (await client.execute({ sql: "SELECT * FROM publication_authors WHERE publication_id = ?", args: [racedPubId] })).rows as unknown as Array<{
      faculty_id: number | null;
      role: string;
    }>;
    expect(authors).toHaveLength(1);
    expect(authors[0].faculty_id).toBe(facultyId);
    expect(authors[0].role).toBe("chps_faculty");

    const sub = (await client.execute({ sql: "SELECT status FROM pending_submissions WHERE id = ?", args: [subId] })).rows[0] as unknown as { status: string };
    expect(sub.status).toBe("approved");
  });

  it("staleness race + already finalized: approve reports already_posted and writes nothing at all", async () => {
    const facultyId = await seedFaculty("Stock, M.", "School of Kinesiology and Rehabilitation Sciences");
    const subId = await seedSubmission(facultyId, "Paper Someone Else Already Posted", { doi: "10.1/posted" });

    await client.execute("INSERT INTO roundups (label, generated_at, pub_count, html) VALUES ('Test Edition', datetime('now'), 1, '<html></html>')");
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, status, source, first_seen_at, date_added, created_at, roundup_id)
            VALUES ('10.1/posted', 'Paper Someone Else Already Posted', 'paper someone else already posted', 'https://example.com/posted', 'published', 'crossref', ?, ?, ?, 1)`,
      args: [now, now.slice(0, 10), now],
    });

    const result = await approvePendingSubmission(client, subId, {
      ...BASE_APPROVE,
      doi: "10.1/posted",
      title: "Paper Someone Else Already Posted",
      authors: [{ name: "Stock, M.", facultyId, role: "chps_faculty" }],
    });

    expect(result.outcome).toBe("already_posted");
    // Nothing written: submission still pending, no new author row.
    const sub = (await client.execute({ sql: "SELECT status FROM pending_submissions WHERE id = ?", args: [subId] })).rows[0] as unknown as { status: string };
    expect(sub.status).toBe("pending");
    const pubCount = (await client.execute("SELECT COUNT(*) as c FROM publications")).rows[0] as unknown as { c: number };
    expect(pubCount.c).toBe(1); // still just the one pre-existing row
  });

  it("checkForStaleMatch (read-only preview) reports a match without writing anything", async () => {
    const facultyId = await seedFaculty("Stock, M.", "School of Kinesiology and Rehabilitation Sciences");
    const subId = await seedSubmission(facultyId, "Preview-Checked Paper", { doi: "10.1/preview" });

    const now = new Date().toISOString();
    const raced = await client.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
            VALUES ('10.1/preview', 'Preview-Checked Paper', 'preview-checked paper', 'https://example.com/preview', 'published', 'crossref', ?, ?, ?)`,
      args: [now, now.slice(0, 10), now],
    });

    const list = await listPendingSubmissions(client);
    const submission = list.find((s) => s.id === subId)!;
    const staleCheck = await checkForStaleMatch(client, submission.payload);

    expect(staleCheck).toEqual({ publicationId: Number(raced.lastInsertRowid), finalized: false });
    const sub = (await client.execute({ sql: "SELECT status FROM pending_submissions WHERE id = ?", args: [subId] })).rows[0] as unknown as { status: string };
    expect(sub.status).toBe("pending"); // unchanged — read-only
  });

  it("approving a nonexistent submission throws", async () => {
    await expect(approvePendingSubmission(client, 999999, { ...BASE_APPROVE, title: "x", authors: [] })).rejects.toThrow(/no pending submission/i);
  });

  it("rejecting a nonexistent submission throws", async () => {
    await expect(rejectPendingSubmission(client, 999999, "Reviewer")).rejects.toThrow(/no pending submission/i);
  });

  it("approving an already-reviewed submission is a clean not_pending result, not a crash or a second write", async () => {
    const facultyId = await seedFaculty("Stock, M.", "School of Kinesiology and Rehabilitation Sciences");
    const subId = await seedSubmission(facultyId, "Already Rejected Paper");
    await rejectPendingSubmission(client, subId, "First Reviewer");

    const result = await approvePendingSubmission(client, subId, {
      ...BASE_APPROVE,
      title: "Already Rejected Paper",
      authors: [{ name: "Stock, M.", facultyId, role: "chps_faculty" }],
    });
    expect(result).toEqual({ outcome: "not_pending", currentStatus: "rejected" });
    const pubCount = (await client.execute("SELECT COUNT(*) as c FROM publications")).rows[0] as unknown as { c: number };
    expect(pubCount.c).toBe(0);
  });

  it("rejecting an already-approved submission is a clean not_pending result", async () => {
    const facultyId = await seedFaculty("Stock, M.", "School of Kinesiology and Rehabilitation Sciences");
    const subId = await seedSubmission(facultyId, "Already Approved Paper");
    await approvePendingSubmission(client, subId, {
      ...BASE_APPROVE,
      title: "Already Approved Paper",
      authors: [{ name: "Stock, M.", facultyId, role: "chps_faculty" }],
    });

    const result = await rejectPendingSubmission(client, subId, "Second Reviewer");
    expect(result).toEqual({ outcome: "not_pending", currentStatus: "approved" });
  });
});
