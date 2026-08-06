// Phase 5 hardening, Session 5 — §8b security model (master plan) items 4 & 6
// ("scope every query to the token's faculty_id... the {slug} is cosmetic";
// "no destructive actions... nothing that touches an already-posted roundup")
// + docs/phase5-surface-inventory.md §§2-3. Standing rule: report, don't fix.
// No modification to lib/, scripts/, app/, or db/.
//
// Coverage already existing, NOT duplicated here:
//   - tests/review-actions.test.ts: exhaustive facultyId-scoping at the
//     lib/review-actions.ts layer (Zhu/Dykstra isolation, swapped-id refusal,
//     isPublicationFinalized gating every write, the four addMissingPublication
//     outcomes at the facultyId level, "never touches an already-confirmed row").
//   - tests/review.test.ts, tests/tokens.test.ts: token lifecycle mechanics.
//   - tests/security/token-lifecycle.test.ts (Session 4): the slug-is-never-a-
//     credential table for setRoleAction specifically, expiry/revocation at
//     the token+slug layer, finalize/token interaction.
//   - tests/admin-server-actions.test.ts, tests/finalize-actions.test.ts,
//     tests/archive-actions.test.ts: requireAdminSession enforcement for
//     logoutAction, finalizeRoundupAction, unstampAction/dryRunUnstampAction.
// This file's job: the full attack matrix across every mutating review-token
// route (not just setRoleAction), a runtime drift guard so a route added
// later can't silently go untested, role-overwrite semantics, "not my
// paper" blast radius, the submission path, and the four-outcome duplicate
// handler — all driven through the REAL app/review/[slug]/[token]/actions.ts
// and app/admin/**/*.ts Server Actions, never a reimplementation.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../db/migrate";
import { generateReviewToken } from "../../lib/tokens";
import { createReviewRequest } from "../../lib/review";
import { unitsForPublication } from "../../lib/citation";
import { snapshotTables, expectNoNetChange } from "../helpers/snapshot";

process.env.CROSSREF_MAILTO ??= "test@example.com";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(() => Promise.resolve(cookieStore)) }));

class MockRedirectSignal extends Error {
  constructor(public url: string) {
    super(`REDIRECT:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new MockRedirectSignal(url);
  }),
}));

// ─── Shared DB singleton — same pattern as tests/security/token-lifecycle.test.ts
// (app/review/.../actions.ts and app/admin/**/*.ts both import `client` from
// @/lib/db directly, a module-level singleton read from TURSO_DATABASE_URL at
// import time — matches tests/finalize-actions.test.ts's established pattern
// for testing "use server" files that don't accept an injected client).
// ★ Env vars MUST be set before the FIRST import of lib/db.ts (or anything
// that transitively imports it, e.g. app/review/.../actions.ts below) —
// lib/db.ts creates its `client` singleton eagerly, synchronously, at its
// own module-evaluation time. A top-level `await import(...)` in a test file
// runs during module evaluation, BEFORE any beforeAll hook fires — setting
// these inside beforeAll (as originally written here) let the actions-module
// import below run first, against whatever TURSO_DATABASE_URL was already in
// process.env (the real production value from .env.local), which the
// network guard correctly caught and refused. Confirmed the hard way, not
// theorized: this exact ordering mistake is what tripped it.
const dbDir = mkdtempSync(path.join(tmpdir(), "token-authz-"));
process.env.TURSO_DATABASE_URL = `file:${path.join(dbDir, "test.db")}`;
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.SESSION_SECRET ??= "test-session-secret-for-token-authz";

const dbModule = await import("../../lib/db");
const dbClient: Client = dbModule.client;

beforeAll(async () => {
  await runMigrations(dbClient, path.join(__dirname, "..", "..", "db", "migrations"));
});

let seq = 0;
async function seedFacultyReal(displayName: string, unit = "Department of Health Sciences"): Promise<number> {
  seq++;
  const result = await dbClient.execute({
    sql: `INSERT INTO faculty (wp_id, slug, display_name, email, unit, active) VALUES (?, ?, ?, ?, ?, 1)`,
    args: [`wp-${seq}`, `slug-${seq}`, displayName, `f${seq}@example.edu`, unit],
  });
  return Number(result.lastInsertRowid);
}

async function seedPublicationReal(title: string, overrides: { status?: string; roundupId?: number | null } = {}): Promise<number> {
  seq++;
  const now = new Date().toISOString();
  const result = await dbClient.execute({
    sql: `INSERT INTO publications (title, title_normalized, url, status, source, first_seen_at, date_added, created_at, roundup_id)
          VALUES (?, ?, 'https://example.com', ?, 'crossref', ?, ?, ?, ?)`,
    args: [`${title} #${seq}`, `${title} #${seq}`.toLowerCase(), overrides.status ?? "pending_merge", now, now.slice(0, 10), now, overrides.roundupId ?? null],
  });
  return Number(result.lastInsertRowid);
}

async function seedAuthorReal(pubId: number, facultyId: number | null, name: string, role: string, position = 0): Promise<number> {
  const result = await dbClient.execute({
    sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, position) VALUES (?, ?, ?, ?, ?)`,
    args: [pubId, facultyId, name, role, position],
  });
  return Number(result.lastInsertRowid);
}

async function mintValidToken(facultyId: number): Promise<{ token: string; slug: string }> {
  return createReviewRequest(dbClient, facultyId, 90, "Attack Matrix Cycle");
}

async function mintExpiredToken(facultyId: number): Promise<{ token: string; slug: string }> {
  const { token, tokenHash } = generateReviewToken();
  await dbClient.execute({
    sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, created_at, expires_at, revoked) VALUES (?, ?, 'expired-slug', ?, ?, 0)`,
    args: [facultyId, tokenHash, new Date().toISOString(), new Date(Date.now() - 1000).toISOString()],
  });
  return { token, slug: "expired-slug" };
}

async function mintRevokedToken(facultyId: number): Promise<{ token: string; slug: string }> {
  const { token, tokenHash } = generateReviewToken();
  await dbClient.execute({
    sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, created_at, expires_at, revoked) VALUES (?, ?, 'revoked-slug', ?, ?, 1)`,
    args: [facultyId, tokenHash, new Date().toISOString(), new Date(Date.now() + 90 * 86400000).toISOString()],
  });
  return { token, slug: "revoked-slug" };
}

function tamper(token: string): string {
  return token.slice(0, -1) + (token.at(-1) === "A" ? "B" : "A");
}

const { setRoleAction, rejectAttributionAction, confirmOwnAttributionAction, editCitationAction, markReviewCompleteAction, addPublicationAction } =
  await import("../../app/review/[slug]/[token]/actions");

// ─────────────────────────────────────────────────────────────────────────
// 1. THE ATTACK MATRIX
// ─────────────────────────────────────────────────────────────────────────
describe("1. Attack matrix — every mutating review-token route", () => {
  describe("setRoleAction — role tagging (the richest attack surface: enum, cross-faculty id, finalized publication)", () => {
    async function baseline() {
      const facultyAId = await seedFacultyReal("Matrix Owner, A.");
      const facultyBId = await seedFacultyReal("Matrix Other, B.");
      const pubId = await seedPublicationReal("Matrix Role Paper");
      await seedAuthorReal(pubId, facultyAId, "Matrix Owner, A.", "chps_faculty");
      const coAuthorId = await seedAuthorReal(pubId, null, "Unconfirmed, U.", "unknown", 1);
      const { token, slug } = await mintValidToken(facultyAId);
      return { facultyAId, facultyBId, pubId, coAuthorId, token, slug };
    }

    it("no token: rejected, nothing written", async () => {
      const { slug, coAuthorId } = await baseline();
      const before = await snapshotTables(dbClient);
      const fd = new FormData();
      fd.set("role", "grad_student");
      await expect(setRoleAction("", slug, coAuthorId, fd)).rejects.toThrow(/no longer valid/i);
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("expired token: rejected, nothing written", async () => {
      const { facultyAId, pubId, coAuthorId } = await baseline();
      const { token, slug } = await mintExpiredToken(facultyAId);
      void pubId;
      const before = await snapshotTables(dbClient);
      const fd = new FormData();
      fd.set("role", "grad_student");
      await expect(setRoleAction(token, slug, coAuthorId, fd)).rejects.toThrow(/no longer valid/i);
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("revoked token: rejected, nothing written", async () => {
      const { facultyAId, coAuthorId } = await baseline();
      const { token, slug } = await mintRevokedToken(facultyAId);
      const before = await snapshotTables(dbClient);
      const fd = new FormData();
      fd.set("role", "grad_student");
      await expect(setRoleAction(token, slug, coAuthorId, fd)).rejects.toThrow(/no longer valid/i);
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("tampered token (one character changed): rejected, nothing written", async () => {
      const { token, slug, coAuthorId } = await baseline();
      const before = await snapshotTables(dbClient);
      const fd = new FormData();
      fd.set("role", "grad_student");
      await expect(setRoleAction(tamper(token), slug, coAuthorId, fd)).rejects.toThrow(/no longer valid/i);
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("valid token, publication_author.id belonging to a paper this faculty is NOT an author on: rejected, nothing written", async () => {
      const { token, slug } = await baseline();
      const strangerPubId = await seedPublicationReal("A Paper This Token's Faculty Has Nothing To Do With");
      const strangerCoAuthorId = await seedAuthorReal(strangerPubId, null, "Stranger Coauthor, S.", "unknown", 0);

      const before = await snapshotTables(dbClient);
      const fd = new FormData();
      fd.set("role", "grad_student");
      await setRoleAction(token, slug, strangerCoAuthorId, fd); // does not throw — setCoAuthorRole returns false internally
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();

      const row = (await dbClient.execute("SELECT role FROM publication_authors WHERE id = ?", [strangerCoAuthorId])).rows[0] as unknown as { role: string };
      expect(row.role).toBe("unknown"); // untouched
    });

    it("valid token, role outside the 5-value enum entirely (a bogus string): rejected, nothing written", async () => {
      const { token, slug, coAuthorId } = await baseline();
      const before = await snapshotTables(dbClient);
      const fd = new FormData();
      fd.set("role", "professor_emeritus"); // not chps_faculty/grad_student/undergrad_student/external/unknown
      await expect(setRoleAction(token, slug, coAuthorId, fd)).rejects.toThrow(/not a plain-language role option/i);
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("valid token, role = 'unknown' (a real enum member, but never a valid TARGET): rejected, nothing written", async () => {
      const { token, slug, coAuthorId } = await baseline();
      const before = await snapshotTables(dbClient);
      const fd = new FormData();
      fd.set("role", "unknown");
      await expect(setRoleAction(token, slug, coAuthorId, fd)).rejects.toThrow(/not a plain-language role option/i);
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("valid token, a publication already stamped with roundup_id: rejected, nothing written", async () => {
      const facultyId = await seedFacultyReal("Matrix Finalized, F.");
      await dbClient.execute(`INSERT INTO roundups (label, generated_at, pub_count, html) VALUES ('Matrix Finalized Edition', datetime('now'), 1, '<html></html>')`);
      const roundupId = (await dbClient.execute("SELECT last_insert_rowid() as id")).rows[0] as unknown as { id: number };
      const pubId = await seedPublicationReal("Matrix Already Finalized Paper", { status: "published", roundupId: roundupId.id });
      await seedAuthorReal(pubId, facultyId, "Matrix Finalized, F.", "chps_faculty");
      const coAuthorId = await seedAuthorReal(pubId, null, "Unconfirmed On Finalized, U.", "unknown", 1);
      const { token, slug } = await mintValidToken(facultyId);

      const before = await snapshotTables(dbClient);
      const fd = new FormData();
      fd.set("role", "grad_student");
      await setRoleAction(token, slug, coAuthorId, fd); // returns false internally, doesn't throw
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("★ valid token, role = chps_faculty tagged onto a co-author whose name matches NO roster faculty member: report which it currently is", async () => {
      const { token, slug, coAuthorId } = await baseline(); // "Unconfirmed, U." — deliberately not a real faculty row's name
      const facultyRoster = (await dbClient.execute("SELECT display_name FROM faculty")).rows as unknown as Array<{ display_name: string }>;
      expect(facultyRoster.some((f) => f.display_name === "Unconfirmed, U.")).toBe(false); // confirm the premise

      const fd = new FormData();
      fd.set("role", "chps_faculty");
      await setRoleAction(token, slug, coAuthorId, fd);

      const row = (await dbClient.execute("SELECT role, faculty_id FROM publication_authors WHERE id = ?", [coAuthorId])).rows[0] as unknown as {
        role: string;
        faculty_id: number | null;
      };
      // CURRENT BEHAVIOR: this SUCCEEDS. setCoAuthorRole (lib/review-actions.ts)
      // never cross-checks the row's `name` against the faculty roster before
      // allowing role='chps_faculty' — it trusts the reviewing faculty member's
      // say-so entirely, with no flag of any kind. faculty_id stays null (never
      // auto-linked to a roster row), so this bolds an unlinked name in the
      // citation without ever confirming who that name actually refers to.
      // Not rejected. Not flagged. See the report for the trade-off.
      expect(row.role).toBe("chps_faculty");
      expect(row.faculty_id).toBeNull();
    });
  });

  describe("editCitationAction — citation edits (free-text fields: oversized payload, cross-faculty, finalized)", () => {
    async function baseline() {
      const facultyAId = await seedFacultyReal("Citation Owner, C.");
      const facultyBId = await seedFacultyReal("Citation Other, C.");
      const pubId = await seedPublicationReal("Citation Edit Paper");
      await seedAuthorReal(pubId, facultyAId, "Citation Owner, C.", "chps_faculty");
      const { token, slug } = await mintValidToken(facultyAId);
      return { facultyAId, facultyBId, pubId, token, slug };
    }

    it("no token: rejected, nothing written", async () => {
      const { slug, pubId } = await baseline();
      const before = await snapshotTables(dbClient);
      const fd = new FormData();
      fd.set("journal", "Hijacked");
      await expect(editCitationAction("", slug, pubId, fd)).rejects.toThrow(/no longer valid/i);
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("expired token: rejected, nothing written", async () => {
      const { facultyAId, pubId } = await baseline();
      const { token, slug } = await mintExpiredToken(facultyAId);
      const before = await snapshotTables(dbClient);
      const fd = new FormData();
      fd.set("journal", "Hijacked");
      await expect(editCitationAction(token, slug, pubId, fd)).rejects.toThrow(/no longer valid/i);
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("revoked token: rejected, nothing written", async () => {
      const { facultyAId, pubId } = await baseline();
      const { token, slug } = await mintRevokedToken(facultyAId);
      const before = await snapshotTables(dbClient);
      const fd = new FormData();
      fd.set("journal", "Hijacked");
      await expect(editCitationAction(token, slug, pubId, fd)).rejects.toThrow(/no longer valid/i);
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("tampered token: rejected, nothing written", async () => {
      const { token, slug, pubId } = await baseline();
      const before = await snapshotTables(dbClient);
      const fd = new FormData();
      fd.set("journal", "Hijacked");
      await expect(editCitationAction(tamper(token), slug, pubId, fd)).rejects.toThrow(/no longer valid/i);
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("valid token, publication_id for a paper this faculty is NOT an author on: rejected, nothing written", async () => {
      const { token, slug } = await baseline();
      const strangerPubId = await seedPublicationReal("Not This Faculty's Paper At All", { status: "pending_merge" });

      const before = await snapshotTables(dbClient);
      const fd = new FormData();
      fd.set("journal", "Hijacked Via Wrong Publication Id");
      await editCitationAction(token, slug, strangerPubId, fd); // no throw — editCitation returns false
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("valid token, a publication already stamped with roundup_id: rejected, nothing written", async () => {
      const facultyId = await seedFacultyReal("Citation Finalized, F.");
      await dbClient.execute(`INSERT INTO roundups (label, generated_at, pub_count, html) VALUES ('Citation Finalized Edition', datetime('now'), 1, '<html></html>')`);
      const roundupId = (await dbClient.execute("SELECT last_insert_rowid() as id")).rows[0] as unknown as { id: number };
      const pubId = await seedPublicationReal("Citation Already Finalized Paper", { status: "published", roundupId: roundupId.id });
      await seedAuthorReal(pubId, facultyId, "Citation Finalized, F.", "chps_faculty");
      const { token, slug } = await mintValidToken(facultyId);

      const before = await snapshotTables(dbClient);
      const fd = new FormData();
      fd.set("journal", "Hijacked Post-Finalize");
      await editCitationAction(token, slug, pubId, fd);
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("★ valid token, oversized payload (1MB title): report whether it's rejected before reaching the database, or simply written", async () => {
      const { token, slug, pubId } = await baseline();
      const oversizedTitle = "A".repeat(1024 * 1024); // 1MB
      const fd = new FormData();
      fd.set("title", oversizedTitle);

      await editCitationAction(token, slug, pubId, fd);

      const row = (await dbClient.execute({ sql: "SELECT title FROM publications WHERE id = ?", args: [pubId] })).rows[0] as unknown as { title: string };
      // CURRENT BEHAVIOR: no size limit is enforced anywhere in this write
      // path (lib/review-actions.ts::editCitation has no length check; SQLite
      // TEXT columns are effectively unbounded — well under its own
      // SQLITE_MAX_LENGTH ceiling of ~1GB). The 1MB string is written verbatim,
      // not rejected. Confirmed empirically here, not assumed.
      expect(row.title.length).toBe(1024 * 1024);
    });
  });

  describe("confirmOwnAttributionAction — the Zhu/Dykstra 'yes, this is mine' shape (own-row only, no cross-faculty id to attack)", () => {
    async function baseline() {
      const facultyAId = await seedFacultyReal("Confirm Owner, C.");
      const pubId = await seedPublicationReal("Confirm Own Paper");
      const ownRowId = await seedAuthorReal(pubId, facultyAId, "Confirm Owner, C.", "unknown", 0);
      const { token, slug } = await mintValidToken(facultyAId);
      return { facultyAId, pubId, ownRowId, token, slug };
    }

    it("no/expired/revoked/tampered token: all rejected, nothing written", async () => {
      const { facultyAId, ownRowId } = await baseline();
      // Mint every token needed FIRST — minting itself writes to
      // review_requests, which must not be mistaken for the attacked
      // action's own effect. The snapshot brackets only the attack attempts.
      const { token: expired, slug: expSlug } = await mintExpiredToken(facultyAId);
      const { token: revoked, slug: revSlug } = await mintRevokedToken(facultyAId);
      const { token: valid, slug: validSlug } = await mintValidToken(facultyAId);

      const before = await snapshotTables(dbClient);
      await expect(confirmOwnAttributionAction("", "irrelevant-slug", ownRowId)).rejects.toThrow(/no longer valid/i);
      await expect(confirmOwnAttributionAction(expired, expSlug, ownRowId)).rejects.toThrow(/no longer valid/i);
      await expect(confirmOwnAttributionAction(revoked, revSlug, ownRowId)).rejects.toThrow(/no longer valid/i);
      await expect(confirmOwnAttributionAction(tamper(valid), validSlug, ownRowId)).rejects.toThrow(/no longer valid/i);
      const after = await snapshotTables(dbClient);

      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("valid token, but publicationAuthorId belongs to ANOTHER faculty member's own unconfirmed row on the same paper (Zhu cannot confirm Dykstra's row via this action either): rejected, nothing written", async () => {
      const zhuId = await seedFacultyReal("Confirm Zhu, Z.");
      const dykstraId = await seedFacultyReal("Confirm Dykstra, D.");
      const pubId = await seedPublicationReal("Confirm Zhu Dykstra Paper");
      await seedAuthorReal(pubId, zhuId, "Confirm Zhu, Z.", "unknown", 0);
      const dykstraRowId = await seedAuthorReal(pubId, dykstraId, "Confirm Dykstra, D.", "unknown", 1);
      const { token: zhuToken, slug: zhuSlug } = await mintValidToken(zhuId);

      await confirmOwnAttributionAction(zhuToken, zhuSlug, dykstraRowId); // no throw

      const row = (await dbClient.execute("SELECT role, faculty_id FROM publication_authors WHERE id = ?", [dykstraRowId])).rows[0] as unknown as {
        role: string;
        faculty_id: number;
      };
      expect(row.role).toBe("unknown"); // untouched — only Dykstra's own token can confirm this row
      expect(row.faculty_id).toBe(dykstraId);
    });
  });

  describe("rejectAttributionAction — \"this isn't my paper\"", () => {
    it("no/expired/revoked/tampered token: all rejected, nothing written", async () => {
      const facultyId = await seedFacultyReal("Reject Owner, R.");
      const pubId = await seedPublicationReal("Reject Attribution Paper");
      const ownRowId = await seedAuthorReal(pubId, facultyId, "Reject Owner, R.", "chps_faculty", 0);
      const { token: expired, slug: expSlug } = await mintExpiredToken(facultyId);
      const { token: revoked, slug: revSlug } = await mintRevokedToken(facultyId);
      const { token: valid, slug: validSlug } = await mintValidToken(facultyId);

      const before = await snapshotTables(dbClient);
      await expect(rejectAttributionAction("", "irrelevant-slug", ownRowId)).rejects.toThrow(/no longer valid/i);
      await expect(rejectAttributionAction(expired, expSlug, ownRowId)).rejects.toThrow(/no longer valid/i);
      await expect(rejectAttributionAction(revoked, revSlug, ownRowId)).rejects.toThrow(/no longer valid/i);
      await expect(rejectAttributionAction(tamper(valid), validSlug, ownRowId)).rejects.toThrow(/no longer valid/i);
      const after = await snapshotTables(dbClient);

      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("valid token, publication_author.id belonging to another faculty member's OWN row: rejected, nothing written", async () => {
      const facultyAId = await seedFacultyReal("Reject A, A.");
      const facultyBId = await seedFacultyReal("Reject B, B.");
      const pubBId = await seedPublicationReal("Reject B's Own Paper");
      const bRowId = await seedAuthorReal(pubBId, facultyBId, "Reject B, B.", "chps_faculty", 0);
      const { token: tokenA, slug: slugA } = await mintValidToken(facultyAId);

      await rejectAttributionAction(tokenA, slugA, bRowId); // no throw

      const row = (await dbClient.execute("SELECT faculty_id FROM publication_authors WHERE id = ?", [bRowId])).rows[0] as unknown as { faculty_id: number };
      expect(row.faculty_id).toBe(facultyBId); // untouched
    });

    it("valid token, a publication already stamped with roundup_id: rejected, nothing written", async () => {
      const facultyId = await seedFacultyReal("Reject Finalized, F.");
      await dbClient.execute(`INSERT INTO roundups (label, generated_at, pub_count, html) VALUES ('Reject Finalized Edition', datetime('now'), 1, '<html></html>')`);
      const roundupId = (await dbClient.execute("SELECT last_insert_rowid() as id")).rows[0] as unknown as { id: number };
      const pubId = await seedPublicationReal("Reject Already Finalized Paper", { status: "published", roundupId: roundupId.id });
      const ownRowId = await seedAuthorReal(pubId, facultyId, "Reject Finalized, F.", "chps_faculty", 0);
      const { token, slug } = await mintValidToken(facultyId);

      const before = await snapshotTables(dbClient);
      await rejectAttributionAction(token, slug, ownRowId);
      const after = await snapshotTables(dbClient);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });
  });

  describe("markReviewCompleteAction — no payload/id at all beyond the token itself", () => {
    it("no/expired/revoked/tampered token: all rejected, nothing written", async () => {
      const facultyId = await seedFacultyReal("Complete Owner, C.");
      const { token: expired, slug: expSlug } = await mintExpiredToken(facultyId);
      const { token: revoked, slug: revSlug } = await mintRevokedToken(facultyId);
      const { token: valid, slug: validSlug } = await mintValidToken(facultyId);

      const before = await snapshotTables(dbClient);
      await expect(markReviewCompleteAction("", "irrelevant-slug")).rejects.toThrow(/no longer valid/i);
      await expect(markReviewCompleteAction(expired, expSlug)).rejects.toThrow(/no longer valid/i);
      await expect(markReviewCompleteAction(revoked, revSlug)).rejects.toThrow(/no longer valid/i);
      await expect(markReviewCompleteAction(tamper(valid), validSlug)).rejects.toThrow(/no longer valid/i);
      const after = await snapshotTables(dbClient);

      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });
  });

  describe("addPublicationAction — the four-outcome duplicate handler (payload: title/doi/url/journal/volume/issue/pages — no facultyId field exists to inject)", () => {
    it("no/expired/revoked/tampered token: all rejected, nothing written to publications/publication_authors/pending_submissions", async () => {
      const facultyId = await seedFacultyReal("AddPub Owner, A.");
      const { token: expired, slug: expSlug } = await mintExpiredToken(facultyId);
      const { token: revoked, slug: revSlug } = await mintRevokedToken(facultyId);
      const { token: valid, slug: validSlug } = await mintValidToken(facultyId);

      const fd = () => {
        const f = new FormData();
        f.set("title", "An Attempted Submission");
        f.set("url", "https://example.com/attempt");
        return f;
      };

      const before = await snapshotTables(dbClient);
      await expect(addPublicationAction("", "irrelevant-slug", { message: null }, fd())).rejects.toThrow(/no longer valid/i);
      await expect(addPublicationAction(expired, expSlug, { message: null }, fd())).rejects.toThrow(/no longer valid/i);
      await expect(addPublicationAction(revoked, revSlug, { message: null }, fd())).rejects.toThrow(/no longer valid/i);
      await expect(addPublicationAction(tamper(valid), validSlug, { message: null }, fd())).rejects.toThrow(/no longer valid/i);
      const after = await snapshotTables(dbClient);

      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("★ valid token, oversized payload (1MB title): report whether it's rejected before reaching the database, or simply written", async () => {
      const facultyId = await seedFacultyReal("AddPub Oversized, O.");
      const { token, slug } = await mintValidToken(facultyId);
      const fd = new FormData();
      fd.set("title", "B".repeat(1024 * 1024));
      fd.set("url", "https://example.com/oversized");

      const result = await addPublicationAction(token, slug, { message: null }, fd);

      // CURRENT BEHAVIOR: same as editCitationAction — no size limit anywhere
      // in this path. A genuine new submission with a 1MB title is accepted
      // and lands in pending_submissions verbatim.
      expect(result.message).toBe("Thanks — we'll review this and add it soon.");
      const rows = (await dbClient.execute("SELECT payload FROM pending_submissions ORDER BY id DESC LIMIT 1")).rows as unknown as Array<{ payload: string }>;
      expect(JSON.parse(rows[0].payload).title.length).toBe(1024 * 1024);
    });

    it("★ 500 authors: structurally impossible via this route — addPublicationAction's FormData parsing never reads an authors field at all (title/doi/url/journal/volume/issue/pages only; lib/review-actions.ts's own comment confirms 'the review page's AddPublicationForm never sets these')", async () => {
      const facultyId = await seedFacultyReal("AddPub NoAuthors, N.");
      const { token, slug } = await mintValidToken(facultyId);
      const fd = new FormData();
      fd.set("title", "A Paper With An Attempted Authors Field");
      fd.set("url", "https://example.com/authors-attempt");
      // Attempt the injection anyway — even if a client crafted this by hand,
      // outside the real <form>'s fields.
      fd.set("authors", JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ name: `Fake Author ${i}`, role: "chps_faculty" }))));

      await addPublicationAction(token, slug, { message: null }, fd);

      const rows = (await dbClient.execute("SELECT payload FROM pending_submissions ORDER BY id DESC LIMIT 1")).rows as unknown as Array<{ payload: string }>;
      const payload = JSON.parse(rows[0].payload);
      expect(payload.authors).toBeUndefined(); // never read from the FormData at all
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. ★ THE DRIFT GUARD
// ─────────────────────────────────────────────────────────────────────────
// Pure test-file tooling (not lib/) — enumerates exported async Server
// Action functions from a "use server" file's source text. Deliberately
// simple (regex over source, not a real TS parser) — good enough to catch
// "someone added a function and nobody wrote a matching test," which is the
// actual failure mode this guards against, not general-purpose static analysis.
function exportedServerActionFunctionNames(filePath: string): string[] {
  const source = readFileSync(filePath, "utf-8");
  if (!/^\s*["']use server["'];?\s*$/m.test(source)) return [];
  const names: string[] = [];
  const fnPattern = /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = fnPattern.exec(source))) names.push(match[1]);
  return names;
}

function findFilesRecursive(dir: string, predicate: (name: string) => boolean): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) results.push(...findFilesRecursive(full, predicate));
    else if (predicate(entry)) results.push(full);
  }
  return results;
}

describe("2. ★ Drift guard — review-surface", () => {
  // The exact set this file's attack matrix (section 1) exercises. Keep this
  // list, and ONLY this list, in sync by hand when a route is added — the
  // test below is what makes forgetting to update it loud instead of silent.
  const COVERED_REVIEW_ACTIONS = new Set([
    "setRoleAction",
    "rejectAttributionAction",
    "confirmOwnAttributionAction",
    "editCitationAction",
    "markReviewCompleteAction",
    "addPublicationAction",
  ]);

  it("every exported Server Action function in app/review/[slug]/[token]/actions.ts is covered by the attack matrix above", () => {
    const actionsFile = path.join(__dirname, "..", "..", "app", "review", "[slug]", "[token]", "actions.ts");
    const found = exportedServerActionFunctionNames(actionsFile);

    expect(found.length).toBeGreaterThan(0); // sanity: the scanner actually found something real
    const uncovered = found.filter((name) => !COVERED_REVIEW_ACTIONS.has(name));
    expect(uncovered, `New review-token route(s) not in the attack matrix: ${uncovered.join(", ")}`).toEqual([]);

    // And the reverse — nothing in COVERED_REVIEW_ACTIONS is stale (a route
    // that was renamed/removed but left in this list would silently stop
    // meaning anything).
    const stale = [...COVERED_REVIEW_ACTIONS].filter((name) => !found.includes(name));
    expect(stale, `Stale entries in COVERED_REVIEW_ACTIONS, no longer exported: ${stale.join(", ")}`).toEqual([]);
  });

  it("★ verifies the guard actually fails on an uncovered function — a disposable stub file, never touching the real app/ tree", () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), "drift-guard-selftest-"));
    const stubFile = path.join(stubDir, "actions.ts");
    writeFileSync(
      stubFile,
      [
        '"use server";',
        "",
        "export async function coveredAction(token: string): Promise<void> {}",
        "export async function definitelyUncoveredAction(token: string): Promise<void> {}",
        "",
      ].join("\n")
    );

    const found = exportedServerActionFunctionNames(stubFile);
    const knownCovered = new Set(["coveredAction"]); // deliberately missing definitelyUncoveredAction
    const uncovered = found.filter((name) => !knownCovered.has(name));

    expect(uncovered).toEqual(["definitelyUncoveredAction"]); // the guard DOES catch it

    rmSync(stubDir, { recursive: true, force: true });
  });
});

describe("2. ★ Drift guard — admin surface (§8c: every admin route must check the session server-side)", () => {
  it("every exported Server Action function across app/admin/**/*.ts either calls requireAdminSession(), or is requireAdminSession itself / an explicitly-unauthenticated documented exception (login, logout)", () => {
    const adminDir = path.join(__dirname, "..", "..", "app", "admin");
    const actionFiles = findFilesRecursive(adminDir, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

    // Explicitly documented exceptions (docs/phase5-surface-inventory.md §2):
    // loginAction IS the auth gate itself (nothing to require session
    // against); session.ts defines requireAdminSession and has no separate
    // export to check against itself; *-shared.ts files are pure form
    // parsing helpers, never "use server" action files (confirmed by the
    // surface inventory's own note that they only match the "use server"
    // grep in comments, not a real directive).
    const EXCEPTION_FUNCTIONS = new Set(["loginAction", "requireAdminSession", "clearAdminSessionCookie"]);

    const violations: string[] = [];
    let totalChecked = 0;
    for (const file of actionFiles) {
      const source = readFileSync(file, "utf-8");
      if (!/^\s*["']use server["'];?\s*$/m.test(source)) continue;
      const names = exportedServerActionFunctionNames(file);
      for (const name of names) {
        if (EXCEPTION_FUNCTIONS.has(name)) continue;
        totalChecked++;
        // Structural check: does THIS function's own body call
        // requireAdminSession() before its closing brace at the same or
        // deeper nesting? Approximated by checking the call appears
        // somewhere between this function's `export` and the NEXT export
        // (or EOF) — good enough given every real action here is a flat,
        // unnested top-level function (confirmed by reading every one of
        // these files this session).
        const startIdx = source.indexOf(`export async function ${name}`);
        const nextExportIdx = source.indexOf("export async function", startIdx + 1);
        const body = source.slice(startIdx, nextExportIdx === -1 ? undefined : nextExportIdx);
        if (!/requireAdminSession\s*\(/.test(body)) violations.push(`${path.relative(adminDir, file)}::${name}`);
      }
    }

    expect(totalChecked).toBeGreaterThan(5); // sanity: found a meaningful number of real admin actions
    expect(violations, `Admin action(s) that never call requireAdminSession(): ${violations.join(", ")}`).toEqual([]);
  });

  // Behavioral confirmation for the three files with ZERO prior
  // session-enforcement test coverage (confirmed by grep before writing this
  // — tests/admin-server-actions.test.ts / finalize-actions.test.ts /
  // archive-actions.test.ts cover logoutAction, finalizeRoundupAction, and
  // unstampAction/dryRunUnstampAction respectively; nothing previously
  // exercised submission-actions.ts, complete-actions.ts, or campaign-actions.ts
  // at all). Same established pattern: no session cookie -> redirect to
  // /admin/login, before any parsing or DB access.
  it("approveSubmissionAction / rejectSubmissionAction redirect to /admin/login with no session — never reach the DB", async () => {
    cookieStore.get.mockReturnValue(undefined);
    const { approveSubmissionAction, rejectSubmissionAction } = await import("../../app/admin/pending-submissions/submission-actions");
    const { initialSubmissionFormState } = await import("../../app/admin/pending-submissions/submission-shared");

    const before = await snapshotTables(dbClient);
    await expect(approveSubmissionAction(initialSubmissionFormState, new FormData())).rejects.toMatchObject({ url: "/admin/login" });
    await expect(rejectSubmissionAction(initialSubmissionFormState, new FormData())).rejects.toMatchObject({ url: "/admin/login" });
    const after = await snapshotTables(dbClient);
    expect(() => expectNoNetChange(before, after)).not.toThrow();
  });

  it("completeNeedsMetadataAction redirects to /admin/login with no session — never reaches the DB", async () => {
    cookieStore.get.mockReturnValue(undefined);
    const { completeNeedsMetadataAction } = await import("../../app/admin/needs-metadata/complete-actions");
    const { initialCompletionFormState } = await import("../../app/admin/needs-metadata/complete-shared");

    const before = await snapshotTables(dbClient);
    await expect(completeNeedsMetadataAction(initialCompletionFormState, new FormData())).rejects.toMatchObject({ url: "/admin/login" });
    const after = await snapshotTables(dbClient);
    expect(() => expectNoNetChange(before, after)).not.toThrow();
  });

  it("previewCampaignAction / sendCampaignAction / revokeAction all redirect to /admin/login with no session — never reach the DB or Gmail", async () => {
    cookieStore.get.mockReturnValue(undefined);
    const { previewCampaignAction, sendCampaignAction, revokeAction } = await import("../../app/admin/review-campaigns/campaign-actions");
    const { initialSendCampaignFormState, initialRevokeFormState } = await import("../../app/admin/review-campaigns/campaign-shared");

    const before = await snapshotTables(dbClient);
    await expect(previewCampaignAction("Some Cycle")).rejects.toMatchObject({ url: "/admin/login" });
    await expect(sendCampaignAction(initialSendCampaignFormState, new FormData())).rejects.toMatchObject({ url: "/admin/login" });
    await expect(revokeAction(initialRevokeFormState, new FormData())).rejects.toMatchObject({ url: "/admin/login" });
    const after = await snapshotTables(dbClient);
    expect(() => expectNoNetChange(before, after)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Role-overwrite semantics
// ─────────────────────────────────────────────────────────────────────────
describe("3. Role-overwrite semantics", () => {
  it("two legitimately co-authoring CHPS faculty, both with valid tokens: the SECOND one to re-tag an already-classified co-author is a silent no-op — first classification wins", async () => {
    const facultyAId = await seedFacultyReal("Overwrite A, A.");
    const facultyBId = await seedFacultyReal("Overwrite B, B.");
    const pubId = await seedPublicationReal("Overwrite Shared Paper");
    await seedAuthorReal(pubId, facultyAId, "Overwrite A, A.", "chps_faculty", 0);
    await seedAuthorReal(pubId, facultyBId, "Overwrite B, B.", "chps_faculty", 1);
    const coAuthorId = await seedAuthorReal(pubId, null, "Shared Coauthor, S.", "unknown", 2);
    const { token: tokenA, slug: slugA } = await mintValidToken(facultyAId);
    const { token: tokenB, slug: slugB } = await mintValidToken(facultyBId);

    const fdA = new FormData();
    fdA.set("role", "grad_student");
    await setRoleAction(tokenA, slugA, coAuthorId, fdA); // A classifies first

    const fdB = new FormData();
    fdB.set("role", "undergrad_student");
    await setRoleAction(tokenB, slugB, coAuthorId, fdB); // B tries to re-tag — no throw, silently does nothing

    const row = (await dbClient.execute("SELECT role, role_set_by FROM publication_authors WHERE id = ?", [coAuthorId])).rows[0] as unknown as {
      role: string;
      role_set_by: string;
    };
    expect(row.role).toBe("grad_student"); // A's classification survives — B's attempt never landed
    expect(row.role_set_by).toBe(`faculty:${facultyAId}`);
  });

  it("★ a faculty token CANNOT change an author currently marked chps_faculty — confirmed at the server (token+action) layer, not just inferred from the UI hiding it", async () => {
    const facultyAId = await seedFacultyReal("Unbold Attacker, U.");
    const colleagueFacultyId = await seedFacultyReal("Colleague Target, C.");
    const pubId = await seedPublicationReal("Unbold Attempt Paper");
    await seedAuthorReal(pubId, facultyAId, "Unbold Attacker, U.", "chps_faculty", 0);
    const colleagueRowId = await seedAuthorReal(pubId, colleagueFacultyId, "Colleague Target, C.", "chps_faculty", 1); // already confirmed
    const { token, slug } = await mintValidToken(facultyAId);

    // The UI only ever renders unknown-role co-authors as taggable (§8b) —
    // this bypasses the UI entirely and submits the form directly against an
    // already-chps_faculty row's id, exactly what a malicious or buggy
    // client could do.
    const fd = new FormData();
    fd.set("role", "external"); // would un-bold the colleague if it landed
    await setRoleAction(token, slug, colleagueRowId, fd);

    const row = (await dbClient.execute("SELECT role, faculty_id FROM publication_authors WHERE id = ?", [colleagueRowId])).rows[0] as unknown as {
      role: string;
      faculty_id: number;
    };
    // The SERVER enforces this (lib/review-actions.ts::setCoAuthorRole's own
    // WHERE role = 'unknown' clause — already proven at the facultyId layer
    // in tests/review-actions.test.ts; this test proves it holds through the
    // real token-based route too, which that file never drives).
    expect(row.role).toBe("chps_faculty"); // untouched — never un-bolded
    expect(row.faculty_id).toBe(colleagueFacultyId);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. "Not my paper" blast radius
// ─────────────────────────────────────────────────────────────────────────
describe("4. \"Not my paper\" blast radius", () => {
  it("unlinking affects ONLY the requesting faculty member's own row — co-authors' rows, the publication itself, and other faculty's derived unit membership are all untouched, and the action is flagged for COMMS (role_set_by:...:rejected, discoverable via report-rejected-attributions.ts's own query)", async () => {
    const unitX = "Department of Health Sciences";
    const unitY = "School of Social Work";
    const facultyXId = await seedFacultyReal("Blast Radius X, X.", unitX);
    const facultyYId = await seedFacultyReal("Blast Radius Y, Y.", unitY);
    const pubId = await seedPublicationReal("Blast Radius Two-Unit Paper", { status: "published" });
    const xRowId = await seedAuthorReal(pubId, facultyXId, "Blast Radius X, X.", "chps_faculty", 0);
    const yRowId = await seedAuthorReal(pubId, facultyYId, "Blast Radius Y, Y.", "chps_faculty", 1);
    const { token: tokenX, slug: slugX } = await mintValidToken(facultyXId);

    const pubTitleBefore = (await dbClient.execute("SELECT title FROM publications WHERE id = ?", [pubId])).rows[0] as unknown as { title: string };
    // Both units present before X rejects their own attribution.
    const authorsBefore = (await dbClient.execute("SELECT * FROM publication_authors WHERE publication_id = ?", [pubId])).rows as unknown as Array<{
      faculty_id: number | null;
      role: string;
    }>;
    const facultyById = {
      [facultyXId]: { unit: unitX } as never,
      [facultyYId]: { unit: unitY } as never,
    };
    const unitsBefore = unitsForPublication(authorsBefore as never, facultyById as never);
    expect(unitsBefore).toContain(unitX);
    expect(unitsBefore).toContain(unitY);

    await rejectAttributionAction(tokenX, slugX, xRowId);

    // 1. X's own row: unlinked (faculty_id -> null, role -> unknown), never deleted.
    const xRowAfter = (await dbClient.execute("SELECT faculty_id, role, role_set_by FROM publication_authors WHERE id = ?", [xRowId]))
      .rows[0] as unknown as { faculty_id: number | null; role: string; role_set_by: string };
    expect(xRowAfter.faculty_id).toBeNull();
    expect(xRowAfter.role).toBe("unknown");
    expect(xRowAfter.role_set_by).toBe(`faculty:${facultyXId}:rejected`);

    // 2. Y's row: completely untouched.
    const yRowAfter = (await dbClient.execute("SELECT faculty_id, role FROM publication_authors WHERE id = ?", [yRowId])).rows[0] as unknown as {
      faculty_id: number;
      role: string;
    };
    expect(yRowAfter.faculty_id).toBe(facultyYId);
    expect(yRowAfter.role).toBe("chps_faculty");

    // 3. The publication row itself: untouched (title, status, roundup_id all the same).
    const pubTitleAfter = (await dbClient.execute("SELECT title, status, roundup_id FROM publications WHERE id = ?", [pubId])).rows[0] as unknown as {
      title: string;
      status: string;
      roundup_id: number | null;
    };
    expect(pubTitleAfter.title).toBe(pubTitleBefore.title);
    expect(pubTitleAfter.status).toBe("published");
    expect(pubTitleAfter.roundup_id).toBeNull();

    // 4. Y's OWN derived unit membership is untouched — Unit Y is still
    // present in the recomputed set (units are derived, never stored, so
    // "untouched" means recomputing from the fresh author list still
    // includes it). The paper's overall unit set legitimately shrinks (loses
    // X's unit) — that's correct, not a violation of this guarantee.
    const authorsAfter = (await dbClient.execute("SELECT * FROM publication_authors WHERE publication_id = ?", [pubId])).rows as unknown as Array<{
      faculty_id: number | null;
      role: string;
    }>;
    const unitsAfter = unitsForPublication(authorsAfter as never, facultyById as never);
    expect(unitsAfter).toContain(unitY);
    expect(unitsAfter).not.toContain(unitX); // X legitimately dropped — the correct consequence, not a leak

    // 5. Flagged for COMMS: discoverable via the exact query
    // scripts/report-rejected-attributions.ts::fetchRejectedAttributions uses.
    const { fetchRejectedAttributions } = await import("../../scripts/report-rejected-attributions");
    const rejections = await fetchRejectedAttributions(dbClient);
    expect(rejections.some((r) => r.publicationId === pubId && r.authorName === "Blast Radius X, X.")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Submission path
// ─────────────────────────────────────────────────────────────────────────
describe("5. Submission path — a genuinely new missing-publication submission never writes directly to publications", () => {
  it("lands in pending_submissions; publications count is unchanged, snapshot-asserted", async () => {
    const facultyId = await seedFacultyReal("Submission Path, S.");
    const { token, slug } = await mintValidToken(facultyId);

    const before = await snapshotTables(dbClient, ["publications", "publication_authors", "pending_submissions"]);
    const fd = new FormData();
    fd.set("title", "A Genuinely Novel Submission Never Seen Before");
    fd.set("url", "https://example.com/novel-submission");
    const result = await addPublicationAction(token, slug, { message: null }, fd);
    const after = await snapshotTables(dbClient, ["publications", "publication_authors", "pending_submissions"]);

    expect(result.message).toBe("Thanks — we'll review this and add it soon.");
    expect(after.publications.rowCount).toBe(before.publications.rowCount); // unchanged
    expect(after.publication_authors.rowCount).toBe(before.publication_authors.rowCount); // unchanged
    expect(after.pending_submissions.rowCount).toBe(before.pending_submissions.rowCount + 1); // exactly one new row, here
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Four-outcome duplicate handler — driven through the real token route
// ─────────────────────────────────────────────────────────────────────────
describe("6. Four-outcome duplicate handler (§8b), via the real addPublicationAction route", () => {
  it("outcome 1: matches a paper already posted -> tells them, creates nothing", async () => {
    const facultyId = await seedFacultyReal("Outcome1, O.");
    await dbClient.execute(`INSERT INTO roundups (label, generated_at, pub_count, html) VALUES ('Outcome1 Edition', datetime('now'), 1, '<html></html>')`);
    const roundupId = (await dbClient.execute("SELECT last_insert_rowid() as id")).rows[0] as unknown as { id: number };
    const pubId = await seedPublicationReal("Outcome1 Already Posted Paper", { status: "published", roundupId: roundupId.id });
    await dbClient.execute({ sql: "UPDATE publications SET doi = ? WHERE id = ?", args: ["10.1/outcome1-posted", pubId] });
    const { token, slug } = await mintValidToken(facultyId);

    const before = await snapshotTables(dbClient, ["publications", "publication_authors", "pending_submissions"]);
    const fd = new FormData();
    fd.set("title", "Outcome1 Already Posted Paper (resubmitted)");
    fd.set("doi", "10.1/outcome1-posted");
    fd.set("url", "https://example.com/outcome1");
    const result = await addPublicationAction(token, slug, { message: null }, fd);
    const after = await snapshotTables(dbClient, ["publications", "publication_authors", "pending_submissions"]);

    expect(result.message).toContain("Good news");
    expect(after.publications.rowCount).toBe(before.publications.rowCount);
    expect(after.publication_authors.rowCount).toBe(before.publication_authors.rowCount);
    expect(after.pending_submissions.rowCount).toBe(before.pending_submissions.rowCount);
  });

  it("outcome 2: matches a paper already in their own queue -> points at it, creates nothing", async () => {
    const facultyId = await seedFacultyReal("Outcome2, O.");
    const pubId = await seedPublicationReal("Outcome2 Already Queued Paper");
    await dbClient.execute({ sql: "UPDATE publications SET doi = ? WHERE id = ?", args: ["10.1/outcome2-queued", pubId] });
    await seedAuthorReal(pubId, facultyId, "Outcome2, O.", "chps_faculty");
    const { token, slug } = await mintValidToken(facultyId);

    const before = await snapshotTables(dbClient, ["publications", "publication_authors", "pending_submissions"]);
    const fd = new FormData();
    fd.set("title", "Outcome2 Already Queued Paper (resubmitted)");
    fd.set("doi", "10.1/outcome2-queued");
    fd.set("url", "https://example.com/outcome2");
    const result = await addPublicationAction(token, slug, { message: null }, fd);
    const after = await snapshotTables(dbClient, ["publications", "publication_authors", "pending_submissions"]);

    expect(result.message).toBe("This one's already in your list below.");
    expect(after.publications.rowCount).toBe(before.publications.rowCount);
    expect(after.publication_authors.rowCount).toBe(before.publication_authors.rowCount);
    expect(after.pending_submissions.rowCount).toBe(before.pending_submissions.rowCount);
  });

  it("★ outcome 3 (the name-matching-miss fix): matches a paper this faculty ISN'T listed on -> links them in via THEIR OWN token's faculty_id, never a payload-supplied one, creates no second record", async () => {
    const facultyAId = await seedFacultyReal("Outcome3 Original, O.");
    const facultyBId = await seedFacultyReal("Outcome3 Missed, M."); // the one submitting via the review page
    const pubId = await seedPublicationReal("Outcome3 Missed Connection Paper");
    await dbClient.execute({ sql: "UPDATE publications SET doi = ? WHERE id = ?", args: ["10.1/outcome3-missed", pubId] });
    await seedAuthorReal(pubId, facultyAId, "Outcome3 Original, O.", "chps_faculty");
    const { token, slug } = await mintValidToken(facultyBId);

    const before = await snapshotTables(dbClient, ["publications"]);
    const fd = new FormData();
    fd.set("title", "Outcome3 Missed Connection Paper (resubmitted)");
    fd.set("doi", "10.1/outcome3-missed");
    fd.set("url", "https://example.com/outcome3");
    // Even though this action's real FormData shape has no facultyId field to
    // inject (confirmed in section 1's "500 authors" test), attempt it
    // anyway — belt and suspenders, proving it's ignored even if present.
    fd.set("facultyId", String(facultyAId));
    fd.set("faculty_id", String(facultyAId));
    const result = await addPublicationAction(token, slug, { message: null }, fd);
    const after = await snapshotTables(dbClient, ["publications"]);

    expect(result.message).toContain("Found it");
    expect(after.publications.rowCount).toBe(before.publications.rowCount); // no second record

    const authors = (await dbClient.execute("SELECT faculty_id, role, role_set_by FROM publication_authors WHERE publication_id = ? ORDER BY position", [pubId]))
      .rows as unknown as Array<{ faculty_id: number; role: string; role_set_by: string }>;
    expect(authors).toHaveLength(2); // original author's row untouched, plus exactly one new one
    const newRow = authors.find((a) => a.faculty_id !== facultyAId);
    // Scoped to the TOKEN's own faculty (B) — never the payload-injected A,
    // never anyone else.
    expect(newRow?.faculty_id).toBe(facultyBId);
    expect(newRow?.role).toBe("chps_faculty");
    expect(newRow?.role_set_by).toBe(`faculty:${facultyBId}`);
  });

  it("outcome 4: no match -> genuine new submission goes to pending_submissions (already covered in detail by section 5 above; confirming the outcome label itself here)", async () => {
    const facultyId = await seedFacultyReal("Outcome4, O.");
    const { token, slug } = await mintValidToken(facultyId);

    const fd = new FormData();
    fd.set("title", "Outcome4 Genuinely New Paper Never Seen Before");
    fd.set("url", "https://example.com/outcome4");
    const result = await addPublicationAction(token, slug, { message: null }, fd);

    expect(result.message).toBe("Thanks — we'll review this and add it soon.");
  });
});
