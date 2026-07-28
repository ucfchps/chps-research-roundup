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
import { submitPublication } from "../lib/portal";

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

  describe("create path (no match) + an anonymous (faculty_id NULL) portal submission", () => {
    it("★ never stamps role_set_by as the literal string 'faculty:null' for an unlinked portal author — every author gets comms:{reviewedBy}, since there's no self-attesting submitter", async () => {
      const outcome = await submitPublication(client, "Anonymous Submitter", {
        title: "Anonymous Portal Paper With Unlinked Authors",
        doi: null,
        url: "https://example.com/anon-create",
        authors: [
          { name: "Unlinked One, U.", role: "chps_faculty" },
          { name: "Unlinked Two, U.", role: "grad_student" },
        ],
      });
      if (outcome.outcome !== "submitted") throw new Error(`Expected a fresh submission, got ${outcome.outcome}`);

      const result = await approvePendingSubmission(client, outcome.pendingSubmissionId, {
        ...BASE_APPROVE,
        title: "Anonymous Portal Paper With Unlinked Authors",
        authors: [
          { name: "Unlinked One, U.", facultyId: null, role: "chps_faculty" },
          { name: "Unlinked Two, U.", facultyId: null, role: "grad_student" },
        ],
      });

      expect(result.outcome).toBe("created");
      const pubId = result.outcome === "created" ? result.publicationId : -1;
      const authors = (await client.execute({ sql: "SELECT name, faculty_id, role_set_by FROM publication_authors WHERE publication_id = ?", args: [pubId] }))
        .rows as unknown as Array<{ name: string; faculty_id: number | null; role_set_by: string }>;

      expect(authors).toHaveLength(2);
      for (const a of authors) {
        expect(a.role_set_by).toBe("comms:COMMS Reviewer");
        expect(a.role_set_by).not.toContain("null");
      }
    });

    it("a reviewer-linked author on a portal submission still gets comms: provenance, not faculty: (no self-attesting submitter exists to earn that)", async () => {
      const facultyId = await seedFaculty("Resolved, R.", "Department of Health Sciences");
      const outcome = await submitPublication(client, "Anonymous Submitter", {
        title: "Portal Paper Where Reviewer Resolves One Author",
        doi: null,
        url: "https://example.com/anon-resolved",
        authors: [{ name: "Resolved, R.", role: "chps_faculty" }],
      });
      if (outcome.outcome !== "submitted") throw new Error(`Expected a fresh submission, got ${outcome.outcome}`);

      const result = await approvePendingSubmission(client, outcome.pendingSubmissionId, {
        ...BASE_APPROVE,
        title: "Portal Paper Where Reviewer Resolves One Author",
        authors: [{ name: "Resolved, R.", facultyId, role: "chps_faculty" }], // reviewer matched them via the datalist
      });

      expect(result.outcome).toBe("created");
      const pubId = result.outcome === "created" ? result.publicationId : -1;
      const author = (await client.execute({ sql: "SELECT role_set_by FROM publication_authors WHERE publication_id = ?", args: [pubId] })).rows[0] as unknown as {
        role_set_by: string;
      };
      expect(author.role_set_by).toBe("comms:COMMS Reviewer");
    });
  });

  describe("MATCH branch + a portal submission's payload.authors (the gap the §8a public-portal session found and closed)", () => {
    async function seedPortalSubmission(title: string, doi: string | null, authors: Array<{ name: string; role: "chps_faculty" | "grad_student" | "undergrad_student" | "external" }>): Promise<number> {
      const outcome = await submitPublication(client, "Anonymous Submitter", { title, doi, url: "https://example.com/portal-paper", authors });
      if (outcome.outcome !== "submitted") throw new Error(`Expected a fresh submission, got ${outcome.outcome}`);
      return outcome.pendingSubmissionId;
    }

    it("before the fix's shape: a portal submission (faculty_id NULL) matching an existing publication used to link nobody — confirm the fix links every reported author instead", async () => {
      const subId = await seedPortalSubmission("Paper That Gets Independently Ingested", "10.1/portal-raced", [
        { name: "Stock, M.", role: "chps_faculty" },
        { name: "Doe, J.", role: "grad_student" },
      ]);

      // Simulate routine ingestion discovering the same paper (by DOI) after the portal submission but before review.
      const now = new Date().toISOString();
      const racedResult = await client.execute({
        sql: `INSERT INTO publications (doi, title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
              VALUES ('10.1/portal-raced', 'Paper That Gets Independently Ingested', 'paper that gets independently ingested', 'https://example.com/raced', 'published', 'crossref', ?, ?, ?)`,
        args: [now, now.slice(0, 10), now],
      });
      const racedPubId = Number(racedResult.lastInsertRowid);

      const result = await approvePendingSubmission(client, subId, {
        ...BASE_APPROVE,
        doi: "10.1/portal-raced",
        title: "Paper That Gets Independently Ingested",
        authors: [
          { name: "Stock, M.", facultyId: null, role: "chps_faculty" },
          { name: "Doe, J.", facultyId: null, role: "grad_student" },
        ],
      });

      expect(result).toEqual({ outcome: "linked_existing", publicationId: racedPubId });

      const authors = (await client.execute({ sql: "SELECT name, faculty_id, role, role_set_by FROM publication_authors WHERE publication_id = ?", args: [racedPubId] }))
        .rows as unknown as Array<{ name: string; faculty_id: number | null; role: string; role_set_by: string }>;
      expect(authors.map((a) => a.name).sort()).toEqual(["Doe, J.", "Stock, M."]);
      expect(authors.every((a) => a.role_set_by === "comms:COMMS Reviewer")).toBe(true);
    });

    it("dedups against an author already linked on the matched publication (by faculty_id when the reviewer resolved one, by name otherwise)", async () => {
      const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
      const subId = await seedPortalSubmission("Paper With One Author Already Linked", "10.1/portal-partial", [
        { name: "Stock, M.", role: "chps_faculty" },
        { name: "New Co-Author, N.", role: "external" },
      ]);

      const now = new Date().toISOString();
      const existingResult = await client.execute({
        sql: `INSERT INTO publications (doi, title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
              VALUES ('10.1/portal-partial', 'Paper With One Author Already Linked', 'paper with one author already linked', 'https://example.com/partial', 'published', 'crossref', ?, ?, ?)`,
        args: [now, now.slice(0, 10), now],
      });
      const existingPubId = Number(existingResult.lastInsertRowid);
      // Already linked before this submission is reviewed (e.g. via ingestion's own author match).
      await client.execute({
        sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, position) VALUES (?, ?, 'Stock, M.', 'chps_faculty', 0)`,
        args: [existingPubId, facultyId],
      });

      const result = await approvePendingSubmission(client, subId, {
        ...BASE_APPROVE,
        doi: "10.1/portal-partial",
        title: "Paper With One Author Already Linked",
        authors: [
          { name: "Stock, M.", facultyId, role: "chps_faculty" }, // reviewer resolved this one via the datalist
          { name: "New Co-Author, N.", facultyId: null, role: "external" },
        ],
      });

      expect(result).toEqual({ outcome: "linked_existing", publicationId: existingPubId });

      const authors = (await client.execute({ sql: "SELECT name FROM publication_authors WHERE publication_id = ?", args: [existingPubId] })).rows as unknown as Array<{
        name: string;
      }>;
      // Not duplicated: still exactly one Stock, M. row, plus the genuinely new co-author.
      expect(authors.map((a) => a.name).sort()).toEqual(["New Co-Author, N.", "Stock, M."]);
    });

    it("a review-page submission's MATCH branch is unaffected — payload has no authors, so this new linking block never fires", async () => {
      // Same as the existing "staleness race" test above in spirit, just
      // asserting explicitly that hasPortalAuthors gates correctly: a
      // review-page submission (via addMissingPublication) never has
      // payload.authors, so it must go on getting exactly the faculty_id-
      // only auto-link behavior, unchanged.
      const facultyId = await seedFaculty("Zhu, Y.", "School of Communication Sciences and Disorders");
      const subId = await seedSubmission(facultyId, "Review-Page Paper Unaffected By The Portal Fix", { doi: "10.1/review-page-unaffected" });

      const now = new Date().toISOString();
      const racedResult = await client.execute({
        sql: `INSERT INTO publications (doi, title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
              VALUES ('10.1/review-page-unaffected', 'Review-Page Paper Unaffected By The Portal Fix', 'review-page paper unaffected by the portal fix', 'https://example.com/unaffected', 'published', 'crossref', ?, ?, ?)`,
        args: [now, now.slice(0, 10), now],
      });
      const racedPubId = Number(racedResult.lastInsertRowid);

      await approvePendingSubmission(client, subId, {
        ...BASE_APPROVE,
        doi: "10.1/review-page-unaffected",
        title: "Review-Page Paper Unaffected By The Portal Fix",
        authors: [{ name: "Zhu, Y.", facultyId, role: "chps_faculty" }],
      });

      const authors = (await client.execute({ sql: "SELECT name FROM publication_authors WHERE publication_id = ?", args: [racedPubId] })).rows as unknown as Array<{
        name: string;
      }>;
      expect(authors).toHaveLength(1); // only the submitter's own auto-link, exactly as before this session
      expect(authors[0].name).toBe("Zhu, Y.");
    });
  });
});
