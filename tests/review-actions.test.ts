// §8b write-side actions for the personal review page: role tagging, "this
// isn't my paper", citation edits, and the four-outcome duplicate handler on
// "add a missing publication" (§7 matching ladder). Every action re-validates
// scope server-side — never trusts a client-supplied row/publication id.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import {
  addMissingPublication,
  editCitation,
  rejectAuthorAttribution,
  setCoAuthorRole,
} from "../lib/review-actions";

describe("review-actions", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "review-actions-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  async function seedFaculty(displayName: string): Promise<number> {
    const result = await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, unit, active) VALUES (?, ?, ?, 'Department of Health Sciences', 1)`,
      args: [displayName, displayName, displayName],
    });
    return Number(result.lastInsertRowid);
  }

  async function seedPublication(overrides: {
    title: string;
    doi?: string | null;
    roundupId?: number | null;
    journal?: string | null;
    volume?: string | null;
    pages?: string | null;
  }): Promise<number> {
    const now = new Date().toISOString();
    const result = await client.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, journal, volume, pages, status, source, first_seen_at, date_added, created_at, roundup_id)
            VALUES (?, ?, ?, 'https://example.com', ?, ?, ?, 'pending_merge', 'crossref', ?, ?, ?, ?)`,
      args: [
        overrides.doi ?? null,
        overrides.title,
        overrides.title.toLowerCase(),
        overrides.journal ?? null,
        overrides.volume ?? null,
        overrides.pages ?? null,
        now,
        now.slice(0, 10),
        now,
        overrides.roundupId ?? null,
      ],
    });
    return Number(result.lastInsertRowid);
  }

  async function seedAuthor(pubId: number, facultyId: number | null, name: string, role: string, position: number): Promise<number> {
    const result = await client.execute({
      sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, position) VALUES (?, ?, ?, ?, ?)`,
      args: [pubId, facultyId, name, role, position],
    });
    return Number(result.lastInsertRowid);
  }

  async function getAuthor(id: number) {
    const rows = (await client.execute({ sql: "SELECT * FROM publication_authors WHERE id = ?", args: [id] })).rows as unknown as Array<{
      id: number;
      faculty_id: number | null;
      role: string;
      role_set_by: string | null;
    }>;
    return rows[0];
  }

  describe("setCoAuthorRole", () => {
    it("tags an unknown-role co-author with a plain-language role, stamping role_set_by/role_set_at", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const pubId = await seedPublication({ title: "A Coauthored Paper" });
      await seedAuthor(pubId, facultyId, "Zraick, R.I.", "chps_faculty", 0);
      const coAuthorRowId = await seedAuthor(pubId, null, "Torralba, L.", "unknown", 1);

      const ok = await setCoAuthorRole(client, facultyId, coAuthorRowId, "grad_student");

      expect(ok).toBe(true);
      const row = await getAuthor(coAuthorRowId);
      expect(row.role).toBe("grad_student");
      expect(row.role_set_by).toBe(`faculty:${facultyId}`);
    });

    it("refuses to set role to 'unknown' — not a valid plain-language option", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const pubId = await seedPublication({ title: "A Coauthored Paper" });
      const coAuthorRowId = await seedAuthor(pubId, null, "Torralba, L.", "unknown", 0);

      await expect(setCoAuthorRole(client, facultyId, coAuthorRowId, "unknown" as never)).rejects.toThrow();
    });

    it("never touches a row that is already confirmed (not currently 'unknown')", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const otherFacultyId = await seedFaculty("Stock, M.S.");
      const pubId = await seedPublication({ title: "A Coauthored Paper" });
      await seedAuthor(pubId, facultyId, "Zraick, R.I.", "chps_faculty", 0);
      const confirmedRowId = await seedAuthor(pubId, otherFacultyId, "Stock, M.S.", "chps_faculty", 1);

      const ok = await setCoAuthorRole(client, facultyId, confirmedRowId, "grad_student");

      expect(ok).toBe(false);
      const row = await getAuthor(confirmedRowId);
      expect(row.role).toBe("chps_faculty"); // untouched
      expect(row.faculty_id).toBe(otherFacultyId); // untouched
    });

    it("refuses to tag a co-author row on a publication this faculty is not linked to (swapped id attack)", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const otherFacultyId = await seedFaculty("Stock, M.S.");
      const otherPubId = await seedPublication({ title: "Someone Else's Paper" });
      await seedAuthor(otherPubId, otherFacultyId, "Stock, M.S.", "chps_faculty", 0);
      const coAuthorRowId = await seedAuthor(otherPubId, null, "Torralba, L.", "unknown", 1);

      const ok = await setCoAuthorRole(client, facultyId, coAuthorRowId, "grad_student");

      expect(ok).toBe(false);
      const row = await getAuthor(coAuthorRowId);
      expect(row.role).toBe("unknown"); // untouched
    });

    it("refuses to let one faculty member set the role on ANOTHER already-identified faculty member's own unconfirmed row (Zhu must not be able to tag Dykstra's row)", async () => {
      const zhuId = await seedFaculty("Zhu, Y.");
      const dykstraId = await seedFaculty("Dykstra, A.");
      const pubId = await seedPublication({ title: "Testing circuit-level theories of consciousness in humans" });
      await seedAuthor(pubId, zhuId, "Zhu, Y.", "unknown", 0);
      const dykstraRowId = await seedAuthor(pubId, dykstraId, "Dykstra, A.", "unknown", 1);

      const ok = await setCoAuthorRole(client, zhuId, dykstraRowId, "grad_student");

      expect(ok).toBe(false);
      const row = await getAuthor(dykstraRowId);
      expect(row.role).toBe("unknown"); // untouched — only Dykstra may confirm/reject his own row
      expect(row.faculty_id).toBe(dykstraId);
    });

    it("Zhu/Dykstra shape: a faculty member can confirm their OWN unconfirmed row as chps_faculty", async () => {
      const zhuId = await seedFaculty("Zhu, Y.");
      const pubId = await seedPublication({ title: "Testing circuit-level theories of consciousness in humans" });
      const zhuRowId = await seedAuthor(pubId, zhuId, "Zhu, Y.", "unknown", 0);

      const ok = await setCoAuthorRole(client, zhuId, zhuRowId, "chps_faculty");

      expect(ok).toBe(true);
      const row = await getAuthor(zhuRowId);
      expect(row.role).toBe("chps_faculty");
      expect(row.faculty_id).toBe(zhuId);
    });
  });

  describe("rejectAuthorAttribution (\"this isn't my paper\")", () => {
    it("unlinks the reviewing faculty member's own row: faculty_id -> NULL, role -> unknown, tagged for COMMS", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const pubId = await seedPublication({ title: "Not Actually Mine" });
      const ownRowId = await seedAuthor(pubId, facultyId, "Zraick, R.I.", "chps_faculty", 0);

      const ok = await rejectAuthorAttribution(client, facultyId, ownRowId);

      expect(ok).toBe(true);
      const row = await getAuthor(ownRowId);
      expect(row.faculty_id).toBeNull();
      expect(row.role).toBe("unknown");
      expect(row.role_set_by).toBe(`faculty:${facultyId}:rejected`);
    });

    it("never deletes the publication_authors row — only unlinks it", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const pubId = await seedPublication({ title: "Not Actually Mine" });
      const ownRowId = await seedAuthor(pubId, facultyId, "Zraick, R.I.", "chps_faculty", 0);

      await rejectAuthorAttribution(client, facultyId, ownRowId);

      const row = await getAuthor(ownRowId);
      expect(row).toBeDefined();
    });

    it("refuses to unlink a row that doesn't belong to this faculty member (can't reject someone else's attribution)", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const otherFacultyId = await seedFaculty("Stock, M.S.");
      const pubId = await seedPublication({ title: "Someone Else's Paper" });
      const otherRowId = await seedAuthor(pubId, otherFacultyId, "Stock, M.S.", "chps_faculty", 0);

      const ok = await rejectAuthorAttribution(client, facultyId, otherRowId);

      expect(ok).toBe(false);
      const row = await getAuthor(otherRowId);
      expect(row.faculty_id).toBe(otherFacultyId); // untouched
    });

    it("refuses to let one faculty member reject ANOTHER already-identified faculty member's own attribution on their shared publication (Zhu must not be able to unlink Dykstra's row)", async () => {
      const zhuId = await seedFaculty("Zhu, Y.");
      const dykstraId = await seedFaculty("Dykstra, A.");
      const pubId = await seedPublication({ title: "Testing circuit-level theories of consciousness in humans" });
      await seedAuthor(pubId, zhuId, "Zhu, Y.", "unknown", 0);
      const dykstraRowId = await seedAuthor(pubId, dykstraId, "Dykstra, A.", "unknown", 1);

      const ok = await rejectAuthorAttribution(client, zhuId, dykstraRowId);

      expect(ok).toBe(false);
      const row = await getAuthor(dykstraRowId);
      expect(row.faculty_id).toBe(dykstraId); // untouched — only Dykstra may reject his own attribution
      expect(row.role).toBe("unknown");
      expect(row.role_set_by).toBeNull();
    });

    // ★ The concrete acceptance case: Zhu and Dykstra are both flagged
    // (unconfirmed) co-authors on the same real publication. Zhu rejecting
    // his own attribution must not touch Dykstra's separate row.
    it("Zhu/Dykstra isolation: rejecting one co-author's attribution never touches the other's row on the same publication", async () => {
      const zhuId = await seedFaculty("Zhu, Y.");
      const dykstraId = await seedFaculty("Dykstra, A.");
      const pubId = await seedPublication({
        title: "Testing circuit-level theories of consciousness in humans",
        doi: "10.1016/j.tics.2025.08.012",
      });
      const zhuRowId = await seedAuthor(pubId, zhuId, "Zhu, Y.", "unknown", 0);
      const dykstraRowId = await seedAuthor(pubId, dykstraId, "Dykstra, A.", "unknown", 1);

      const ok = await rejectAuthorAttribution(client, zhuId, zhuRowId);

      expect(ok).toBe(true);
      const zhuRow = await getAuthor(zhuRowId);
      expect(zhuRow.faculty_id).toBeNull();
      expect(zhuRow.role).toBe("unknown");

      const dykstraRow = await getAuthor(dykstraRowId);
      expect(dykstraRow.faculty_id).toBe(dykstraId); // completely untouched
      expect(dykstraRow.role).toBe("unknown");
      expect(dykstraRow.role_set_by).toBeNull();

      // And Dykstra can independently confirm his own row afterward —
      // proving the mechanism resolves both cases, in isolation.
      const dykstraConfirmed = await setCoAuthorRole(client, dykstraId, dykstraRowId, "chps_faculty");
      expect(dykstraConfirmed).toBe(true);
      const dykstraRowAfter = await getAuthor(dykstraRowId);
      expect(dykstraRowAfter.role).toBe("chps_faculty");
      expect(dykstraRowAfter.faculty_id).toBe(dykstraId);
    });
  });

  describe("editCitation", () => {
    it("applies the edit directly and logs old/new value per changed field", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const pubId = await seedPublication({ title: "A Paper", journal: "Old Journal", volume: "1", pages: "1-10" });
      await seedAuthor(pubId, facultyId, "Zraick, R.I.", "chps_faculty", 0);

      const ok = await editCitation(client, facultyId, pubId, { journal: "New Journal", pages: "1-10" });

      expect(ok).toBe(true);
      const pub = (await client.execute({ sql: "SELECT journal, volume, pages FROM publications WHERE id = ?", args: [pubId] })).rows[0] as unknown as {
        journal: string;
        volume: string;
        pages: string;
      };
      expect(pub.journal).toBe("New Journal");
      expect(pub.volume).toBe("1"); // untouched — not part of this edit

      const logRows = (await client.execute({ sql: "SELECT * FROM citation_edits WHERE publication_id = ?", args: [pubId] })).rows as unknown as Array<{
        field: string;
        old_value: string | null;
        new_value: string | null;
        faculty_id: number;
      }>;
      expect(logRows).toHaveLength(1); // pages unchanged (same value) -> not logged
      expect(logRows[0].field).toBe("journal");
      expect(logRows[0].old_value).toBe("Old Journal");
      expect(logRows[0].new_value).toBe("New Journal");
      expect(logRows[0].faculty_id).toBe(facultyId);
    });

    it("refuses to edit a publication this faculty is not linked to", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const otherFacultyId = await seedFaculty("Stock, M.S.");
      const pubId = await seedPublication({ title: "Someone Else's Paper", journal: "Old Journal" });
      await seedAuthor(pubId, otherFacultyId, "Stock, M.S.", "chps_faculty", 0);

      const ok = await editCitation(client, facultyId, pubId, { journal: "Hijacked Journal" });

      expect(ok).toBe(false);
      const pub = (await client.execute({ sql: "SELECT journal FROM publications WHERE id = ?", args: [pubId] })).rows[0] as unknown as { journal: string };
      expect(pub.journal).toBe("Old Journal");
    });
  });

  describe("addMissingPublication — four-outcome duplicate handler", () => {
    it("outcome 1: matches a paper already posted (roundup_id set) -> tells them, creates nothing", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      await client.execute(`INSERT INTO roundups (label, generated_at, pub_count, html) VALUES ('Spring and Summer 2025', datetime('now'), 1, '<html></html>')`);
      const pubId = await seedPublication({ title: "Already Posted Paper", doi: "10.1/already-posted", roundupId: 1 });

      const result = await addMissingPublication(client, facultyId, { title: "Already Posted Paper", doi: "10.1/already-posted", url: "https://example.com" });

      expect(result).toEqual({ outcome: "already_posted", publicationId: pubId, roundupLabel: "Spring and Summer 2025" });
      const authorCount = (await client.execute({ sql: "SELECT COUNT(*) as c FROM publication_authors WHERE publication_id = ?", args: [pubId] })).rows[0] as unknown as { c: number };
      expect(authorCount.c).toBe(0); // nothing created
      const pending = (await client.execute("SELECT COUNT(*) as c FROM pending_submissions")).rows[0] as unknown as { c: number };
      expect(pending.c).toBe(0);
    });

    it("outcome 2: matches a paper already in their queue -> points at it, creates nothing", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const pubId = await seedPublication({ title: "Already Queued Paper", doi: "10.1/already-queued" });
      await seedAuthor(pubId, facultyId, "Zraick, R.I.", "chps_faculty", 0);

      const result = await addMissingPublication(client, facultyId, { title: "Already Queued Paper", doi: "10.1/already-queued", url: "https://example.com" });

      expect(result).toEqual({ outcome: "already_in_queue", publicationId: pubId });
      const authorCount = (await client.execute({ sql: "SELECT COUNT(*) as c FROM publication_authors WHERE publication_id = ?", args: [pubId] })).rows[0] as unknown as { c: number };
      expect(authorCount.c).toBe(1); // nothing added
    });

    it("outcome 3 (★ the name-matching-miss fix): matches a paper they aren't listed on -> links them as chps_faculty, creates no new record", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const otherFacultyId = await seedFaculty("Stock, M.S.");
      const pubId = await seedPublication({ title: "Missed Connection Paper", doi: "10.1/missed-connection" });
      await seedAuthor(pubId, otherFacultyId, "Stock, M.S.", "chps_faculty", 0);

      const result = await addMissingPublication(client, facultyId, { title: "Missed Connection Paper", doi: "10.1/missed-connection", url: "https://example.com" });

      expect(result).toEqual({ outcome: "linked_you", publicationId: pubId });
      const authors = (await client.execute({ sql: "SELECT * FROM publication_authors WHERE publication_id = ? ORDER BY position", args: [pubId] })).rows as unknown as Array<{
        faculty_id: number | null;
        role: string;
        role_set_by: string | null;
      }>;
      expect(authors).toHaveLength(2); // Stock's original row untouched, plus the new one
      const newRow = authors.find((a) => a.faculty_id === facultyId);
      expect(newRow?.role).toBe("chps_faculty");
      expect(newRow?.role_set_by).toBe(`faculty:${facultyId}`);
      // no second publication record created for the same paper
      const pubCount = (await client.execute("SELECT COUNT(*) as c FROM publications")).rows[0] as unknown as { c: number };
      expect(pubCount.c).toBe(1);
    });

    it("outcome 4: no match -> genuine new submission goes to pending_submissions", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");

      const result = await addMissingPublication(client, facultyId, { title: "Genuinely New Paper", doi: null, url: "https://example.com/new" });

      expect(result.outcome).toBe("pending_submission");
      const rows = (await client.execute("SELECT * FROM pending_submissions")).rows as unknown as Array<{
        faculty_id: number;
        submitted_via: string;
        status: string;
        payload: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].faculty_id).toBe(facultyId);
      expect(rows[0].submitted_via).toBe("review_page");
      expect(rows[0].status).toBe("pending");
      expect(JSON.parse(rows[0].payload).title).toBe("Genuinely New Paper");
    });
  });
});
