// §8b: scoped data access for the personal review page. Every query takes
// facultyId derived from an already-validated token — never the {slug} URL
// segment (§8b security model item 4). DB-backed, temp-SQLite via
// runMigrations, same pattern as tests/ingest-crossref.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { generateReviewToken, hashToken } from "../lib/tokens";
import {
  createReviewRequest,
  getReviewablePublications,
  getReviewRequestByToken,
  markReviewComplete,
  markReviewRequestOpened,
  ownUnconfirmedRow,
  unidentifiedCoAuthors,
  type ReviewablePublication,
} from "../lib/review";

describe("getReviewRequestByToken / getReviewablePublications", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "review-test-"));
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

  async function seedReviewRequest(facultyId: number, overrides: Partial<{ tokenHash: string; expiresAt: string; revoked: number; slug: string }> = {}): Promise<{ token: string }> {
    const { token, tokenHash } = generateReviewToken();
    const now = new Date().toISOString();
    const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 90 * 86400000).toISOString();
    await client.execute({
      sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [facultyId, overrides.tokenHash ?? tokenHash, overrides.slug ?? "test-slug", now, expiresAt, overrides.revoked ?? 0],
    });
    return { token };
  }

  async function seedPublication(overrides: { title: string; roundupId?: number | null; status?: string }): Promise<number> {
    const now = new Date().toISOString();
    const result = await client.execute({
      sql: `INSERT INTO publications (title, title_normalized, url, status, source, first_seen_at, date_added, created_at, roundup_id)
            VALUES (?, ?, 'https://example.com', ?, 'crossref', ?, ?, ?, ?)`,
      args: [overrides.title, overrides.title.toLowerCase(), overrides.status ?? "pending_merge", now, now.slice(0, 10), now, overrides.roundupId ?? null],
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

  describe("getReviewRequestByToken", () => {
    it("returns the review request for a valid token", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const { token } = await seedReviewRequest(facultyId);

      const result = await getReviewRequestByToken(client, token);

      expect(result?.faculty_id).toBe(facultyId);
    });

    it("returns null for a token that was never minted (never throws)", async () => {
      await expect(getReviewRequestByToken(client, "totally-made-up-token")).resolves.toBeNull();
    });

    it("returns null for an expired token", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const { token } = await seedReviewRequest(facultyId, { expiresAt: new Date(Date.now() - 1000).toISOString() });

      expect(await getReviewRequestByToken(client, token)).toBeNull();
    });

    it("returns null for a revoked token", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const { token } = await seedReviewRequest(facultyId, { revoked: 1 });

      expect(await getReviewRequestByToken(client, token)).toBeNull();
    });

    it("looks up by the HASH of the token, never the raw token — a raw token stored by mistake would never match", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const { token } = await seedReviewRequest(facultyId);
      // Sanity: the raw token itself is not a valid lookup key.
      expect(await getReviewRequestByToken(client, hashToken(token))).toBeNull();
    });
  });

  describe("markReviewRequestOpened", () => {
    it("sets opened_at on first load", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const { token } = await seedReviewRequest(facultyId);
      const before = await getReviewRequestByToken(client, token);
      expect(before?.opened_at).toBeNull();

      await markReviewRequestOpened(client, before!.id);

      const after = await getReviewRequestByToken(client, token);
      expect(after?.opened_at).not.toBeNull();
    });

    it("does not overwrite an already-set opened_at (first-load semantics)", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const { token } = await seedReviewRequest(facultyId);
      const reviewRequest = await getReviewRequestByToken(client, token);

      await markReviewRequestOpened(client, reviewRequest!.id);
      const firstOpenedAt = (await getReviewRequestByToken(client, token))?.opened_at;

      await markReviewRequestOpened(client, reviewRequest!.id);
      const secondOpenedAt = (await getReviewRequestByToken(client, token))?.opened_at;

      expect(secondOpenedAt).toBe(firstOpenedAt);
    });
  });

  describe("getReviewablePublications", () => {
    it("returns a publication linked to this faculty member with roundup_id IS NULL", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const pubId = await seedPublication({ title: "A Queued Paper" });
      await seedAuthor(pubId, facultyId, "Zraick, R.I.", "chps_faculty", 0);

      const result = await getReviewablePublications(client, facultyId);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("A Queued Paper");
    });

    it("excludes a publication already posted in a roundup (roundup_id set) — settled, not shown", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      await client.execute(`INSERT INTO roundups (label, generated_at, pub_count, html) VALUES ('Test Edition', datetime('now'), 1, '<html></html>')`);
      const pubId = await seedPublication({ title: "Already Posted Paper", roundupId: 1 });
      await seedAuthor(pubId, facultyId, "Zraick, R.I.", "chps_faculty", 0);

      const result = await getReviewablePublications(client, facultyId);

      expect(result).toEqual([]);
    });

    it("excludes a publication rejected (status = 'rejected')", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const pubId = await seedPublication({ title: "A Rejected Paper", status: "rejected" });
      await seedAuthor(pubId, facultyId, "Zraick, R.I.", "chps_faculty", 0);

      expect(await getReviewablePublications(client, facultyId)).toEqual([]);
    });

    it("never shows another faculty member's publications", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const otherFacultyId = await seedFaculty("Stock, M.S.");
      const pubId = await seedPublication({ title: "Someone Else's Paper" });
      await seedAuthor(pubId, otherFacultyId, "Stock, M.S.", "chps_faculty", 0);

      expect(await getReviewablePublications(client, facultyId)).toEqual([]);
    });

    it("surfaces only 'unknown'-role co-authors for role-tagging — never a roster-matched chps_faculty co-author", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const otherFacultyId = await seedFaculty("OtherConfirmed, C.");
      const pubId = await seedPublication({ title: "A Coauthored Paper" });
      await seedAuthor(pubId, facultyId, "Zraick, R.I.", "chps_faculty", 0);
      await seedAuthor(pubId, otherFacultyId, "OtherConfirmed, C.", "chps_faculty", 1); // already roster-matched — must not be re-surfaced
      await seedAuthor(pubId, null, "Torralba, L.", "unknown", 2); // needs tagging

      const result = await getReviewablePublications(client, facultyId);

      expect(result).toHaveLength(1);
      expect(result[0].authors.map((a) => a.name)).toEqual(["Zraick, R.I.", "OtherConfirmed, C.", "Torralba, L."]);
      expect(result[0].unknownRoleAuthors.map((a) => a.name)).toEqual(["Torralba, L."]);
    });

    it("a publication where this faculty member's OWN row is the unconfirmed one (Zhu/Dykstra shape) still shows up — they need the chance to confirm or reject it", async () => {
      const facultyId = await seedFaculty("Zhu, Y.");
      const pubId = await seedPublication({ title: "Testing circuit-level theories of consciousness in humans" });
      await seedAuthor(pubId, facultyId, "Zhu, Y.", "unknown", 0); // this faculty's own row, unconfirmed

      const result = await getReviewablePublications(client, facultyId);

      expect(result).toHaveLength(1);
      // Their own row is unconfirmed too, so it's correctly counted among
      // the "unknown" authors shown for confirmation/tagging.
      expect(result[0].unknownRoleAuthors.map((a) => a.name)).toEqual(["Zhu, Y."]);
    });

    it("returns publications ordered consistently and each author list ordered by position", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const pubId = await seedPublication({ title: "Order Test" });
      await seedAuthor(pubId, null, "Third, C.", "unknown", 2);
      await seedAuthor(pubId, facultyId, "Zraick, R.I.", "chps_faculty", 0);
      await seedAuthor(pubId, null, "Second, B.", "unknown", 1);

      const result = await getReviewablePublications(client, facultyId);

      expect(result[0].authors.map((a) => a.name)).toEqual(["Zraick, R.I.", "Second, B.", "Third, C."]);
    });
  });

  describe("createReviewRequest", () => {
    it("mints a token, stores only its hash, and the returned token resolves via getReviewRequestByToken", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");

      const { token } = await createReviewRequest(client, facultyId, 90, "Fall 2026 review");

      const rows = (await client.execute("SELECT token_hash, cycle_label FROM review_requests")).rows as unknown as Array<{
        token_hash: string;
        cycle_label: string | null;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).toBe(hashToken(token));
      expect(rows[0].token_hash).not.toBe(token);
      expect(rows[0].cycle_label).toBe("Fall 2026 review");

      const reviewRequest = await getReviewRequestByToken(client, token);
      expect(reviewRequest?.faculty_id).toBe(facultyId);
    });

    it("sets expires_at ttlDays in the future", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");

      await createReviewRequest(client, facultyId, 90, null);

      const row = (await client.execute("SELECT created_at, expires_at FROM review_requests")).rows[0] as unknown as {
        created_at: string;
        expires_at: string;
      };
      const deltaDays = (new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()) / 86400000;
      expect(Math.round(deltaDays)).toBe(90);
    });

    it("uses the faculty's slug for the cosmetic URL segment, falling back to wp_id when slug is unset", async () => {
      const result = await client.execute({
        sql: `INSERT INTO faculty (wp_id, display_name, unit, active) VALUES ('55', 'No Slug, N.', 'Department of Health Sciences', 1)`,
        args: [],
      });
      const facultyId = Number(result.lastInsertRowid);

      const { slug } = await createReviewRequest(client, facultyId, 90, null);

      expect(slug).toBe("55");
    });

    it("allows cycle_label to be null (ad hoc mint, not part of a campaign)", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");

      await createReviewRequest(client, facultyId, 90, null);

      const row = (await client.execute("SELECT cycle_label FROM review_requests")).rows[0] as unknown as { cycle_label: string | null };
      expect(row.cycle_label).toBeNull();
    });
  });

  describe("markReviewComplete", () => {
    it("sets completed_at when currently NULL", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const { token } = await seedReviewRequest(facultyId);
      const reviewRequest = await getReviewRequestByToken(client, token);
      expect(reviewRequest?.completed_at).toBeNull();

      await markReviewComplete(client, reviewRequest!.id);

      const after = await getReviewRequestByToken(client, token);
      expect(after?.completed_at).not.toBeNull();
    });

    it("is idempotent — a second call does not change an already-set completed_at", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const { token } = await seedReviewRequest(facultyId);
      const reviewRequest = await getReviewRequestByToken(client, token);

      await markReviewComplete(client, reviewRequest!.id);
      const firstCompletedAt = (await getReviewRequestByToken(client, token))?.completed_at;

      await markReviewComplete(client, reviewRequest!.id);
      const secondCompletedAt = (await getReviewRequestByToken(client, token))?.completed_at;

      expect(secondCompletedAt).toBe(firstCompletedAt);
    });

    it("does not touch a different reviewRequestId (scoped by id match, not proximity)", async () => {
      const facultyId = await seedFaculty("Zraick, R.I.");
      const otherFacultyId = await seedFaculty("Stock, M.S.");
      const { token: myToken } = await seedReviewRequest(facultyId);
      const { token: otherToken } = await seedReviewRequest(otherFacultyId);
      const otherReviewRequest = await getReviewRequestByToken(client, otherToken);

      await markReviewComplete(client, otherReviewRequest!.id);

      const mine = await getReviewRequestByToken(client, myToken);
      expect(mine?.completed_at).toBeNull();
    });
  });

  describe("unidentifiedCoAuthors / ownUnconfirmedRow", () => {
    function makePub(authors: ReviewablePublication["authors"]): ReviewablePublication {
      return {
        id: 1,
        doi: null,
        title: "Test Pub",
        url: "https://example.com",
        journal: null,
        year: null,
        volume: null,
        issue: null,
        pages: null,
        authors,
        unknownRoleAuthors: authors.filter((a) => a.role === "unknown"),
      };
    }

    it("unidentifiedCoAuthors returns only genuinely unlinked (faculty_id null) unknown authors — not the reviewer's own row, not another real faculty's pending row", () => {
      const pub = makePub([
        { id: 1, publication_id: 1, faculty_id: 1, name: "Zhu, Y.", role: "unknown", role_set_by: null, role_set_at: null, position: 0 },
        { id: 2, publication_id: 1, faculty_id: 2, name: "Dykstra, A.", role: "unknown", role_set_by: null, role_set_at: null, position: 1 },
        { id: 3, publication_id: 1, faculty_id: null, name: "Torralba, L.", role: "unknown", role_set_by: null, role_set_at: null, position: 2 },
      ]);

      expect(unidentifiedCoAuthors(pub, 1).map((a) => a.name)).toEqual(["Torralba, L."]);
    });

    it("ownUnconfirmedRow returns the reviewer's own row when it is unknown, undefined otherwise", () => {
      const pub = makePub([
        { id: 1, publication_id: 1, faculty_id: 1, name: "Zhu, Y.", role: "unknown", role_set_by: null, role_set_at: null, position: 0 },
      ]);

      expect(ownUnconfirmedRow(pub, 1)?.name).toBe("Zhu, Y.");
      expect(ownUnconfirmedRow(pub, 999)).toBeUndefined();
    });
  });
});
