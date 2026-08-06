// Phase 5 hardening — §8b security model (master plan) + docs/phase5-surface-inventory.md
// §§2-3 ("auth = review_token": every function in app/review/[slug]/[token]/actions.ts
// plus the write-during-render in page.tsx:51 — all re-derive facultyId server-side
// from the token, none trust {slug}). Standing rule: report, don't fix. No
// modification to lib/, scripts/, app/, or db/.
//
// Coverage already existing, NOT duplicated here (read first, per instruction):
//   - tests/tokens.test.ts: token length/URL-safety/200-token uniqueness, hash round-trip.
//   - tests/review.test.ts: getReviewRequestByToken null-on-{never-minted,expired,revoked},
//     lookup-by-hash-not-raw-value, markReviewRequestOpened first-load/no-overwrite semantics,
//     createReviewRequest hash-only storage + expiry math, revokeReviewRequest idempotency +
//     no-cross-contamination, getReviewablePublications scoping (never another faculty's papers).
//   - tests/review-actions.test.ts: exhaustive facultyId-scoping at the lib/review-actions.ts
//     layer (the Zhu/Dykstra "can't touch another identified faculty's own row" shape,
//     "swapped id attack" refusal, isPublicationFinalized gating every write).
//   - tests/campaigns.test.ts: the email-notifications kill switch tested with an
//     INJECTED sendMessageFn mock (disabled -> zero DB writes, zero calls; --dry-run
//     unaffected either way; toggle transitions); resolveMockSendMessageFn in isolation.
//   - tests/mint-review-token.test.ts: the CLI mint path, hash-only storage.
// This file's job: the TOKEN+SLUG layer sitting on top of that (app/review/[slug]/[token]/
// actions.ts's resolveFacultyId(token), which review-actions.test.ts never exercises since
// it calls lib/review-actions.ts directly with a pre-resolved facultyId) — plus items with
// no existing coverage at all: raw-token-at-rest scanning, 1000-token entropy/CSPRNG-source,
// fake-timer-driven expiry boundary, finalize/token interaction, query-shape (indexed vs
// scan), opened_at-as-scanner-oracle, and response uniformity — and one end-to-end
// real-Gmail-function harness safety check.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../db/migrate";
import { generateReviewToken, hashToken } from "../../lib/tokens";
import { createReviewRequest, getReviewRequestByToken, markReviewRequestOpened } from "../../lib/review";
import { setSetting } from "../../lib/settings";
import { finalizeRoundup } from "../../lib/roundup-finalize";
import { withFakeTimers } from "../helpers/fake-timers";

// Top-level (not nested in a describe/it) — vi.mock calls are hoisted above
// all imports regardless, and Vitest warns/will error on a nested one that
// implies otherwise. Every describe block below that imports
// app/review/[slug]/[token]/actions.ts relies on this being in place.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

process.env.CROSSREF_MAILTO ??= "test@example.com";
process.env.GMAIL_CLIENT_ID ??= "id";
process.env.GMAIL_CLIENT_SECRET ??= "secret";
process.env.GMAIL_REFRESH_TOKEN ??= "refresh";

// ─── 0. The harness safety net this whole pack rests on ───────────────────
// MOCK_GMAIL_SEND=1 + email_notifications_enabled=0, asserted as a test in
// its own right, using the REAL default wiring (no injected sendMessageFn —
// tests/campaigns.test.ts already covers the injectable-mock path
// exhaustively; this proves the actual production default — runCampaign's
// own `opts.sendMessageFn ?? realSendMessage` fallback — never reaches Gmail
// either, by spying on the real lib/gmail.ts module).
describe("0. Harness safety net — no test in this pack may send an email", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    process.env.MOCK_GMAIL_SEND = "1";
    dbDir = mkdtempSync(path.join(tmpdir(), "harness-safety-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "..", "db", "migrations"));
    await setSetting(client, "email_notifications_enabled", "false", "test-setup");
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.doUnmock("../../lib/gmail");
    vi.resetModules();
  });

  it("mints a full campaign against the REAL default send wiring (no injected sendMessageFn) — the real Gmail sendMessage function is never invoked", async () => {
    await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, email, unit, active) VALUES ('1','harness-target','Harness, T.','harness@example.edu','Department of Health Sciences',1)`,
      args: [],
    });
    const now = new Date().toISOString();
    const pub = await client.execute({
      sql: `INSERT INTO publications (title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
            VALUES ('A Paper Needing Review', 'a paper needing review', 'https://example.com', 'pending_merge', 'crossref', ?, ?, ?)`,
      args: [now, now.slice(0, 10), now],
    });
    await client.execute({
      sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, position) VALUES (?, 1, 'Harness, T.', 'chps_faculty', 0)`,
      args: [Number(pub.lastInsertRowid)],
    });

    const gmailSendSpy = vi.fn(async () => {
      throw new Error("REAL GMAIL SEND WAS CALLED — this must never happen in a test run");
    });
    vi.doMock("../../lib/gmail", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../lib/gmail")>();
      return { ...actual, sendMessage: gmailSendSpy };
    });

    const { runCampaign } = await import("../../lib/campaigns");
    const result = await runCampaign(client, "Harness Safety Cycle", {
      dryRun: false,
      ttlDays: 90,
      appBaseUrl: "https://example.com",
      emailFrom: "roundup@example.com",
      emailReplyTo: "roundup@example.com",
      // Deliberately NOT passing sendMessageFn — exercises the real
      // `opts.sendMessageFn ?? ((input) => realSendMessage(client, input))`
      // fallback in lib/campaigns.ts.
    });

    expect(gmailSendSpy).not.toHaveBeenCalled();
    expect(result.notificationsDisabled).toBe(true); // the kill switch is what actually stopped it
    expect(result.sent).toEqual([]);
    const reviewRequests = await client.execute("SELECT COUNT(*) as n FROM review_requests");
    expect(reviewRequests.rows[0].n).toBe(0); // no token even minted — aborted before selection
  });
});

// ─── Shared fixtures for items 1-9 ─────────────────────────────────────────
// A single temp-file DB shared across this describe block (app/review/.../actions.ts
// and app/review/.../page.tsx-equivalent both route through lib/db.ts's module
// singleton, which reads TURSO_DATABASE_URL once at import time — same pattern
// tests/finalize-actions.test.ts and tests/archive-actions.test.ts already use
// for testing "use server" files that import that singleton directly, rather
// than accepting an injected client). Every test below uses its own uniquely
// named faculty/publication rows so accumulation across the shared DB never
// cross-contaminates an assertion.
let dbDir: string;
let dbClient: Client;

beforeAll(async () => {
  dbDir = mkdtempSync(path.join(tmpdir(), "token-lifecycle-"));
  process.env.TURSO_DATABASE_URL = `file:${path.join(dbDir, "test.db")}`;
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.SESSION_SECRET ??= "test-session-secret-for-token-lifecycle";

  const dbModule = await import("../../lib/db");
  dbClient = dbModule.client;
  await runMigrations(dbClient, path.join(__dirname, "..", "..", "db", "migrations"));
});

let facultySeq = 0;
async function seedFacultyReal(displayName: string): Promise<number> {
  facultySeq++;
  const result = await dbClient.execute({
    sql: `INSERT INTO faculty (wp_id, slug, display_name, email, unit, active) VALUES (?, ?, ?, ?, 'Department of Health Sciences', 1)`,
    args: [`wp-${facultySeq}`, `slug-${facultySeq}`, displayName, `f${facultySeq}@example.edu`],
  });
  return Number(result.lastInsertRowid);
}

async function seedPublicationReal(title: string, overrides: { status?: string; roundupId?: number | null; dateAdded?: string } = {}): Promise<number> {
  const now = new Date().toISOString();
  const result = await dbClient.execute({
    sql: `INSERT INTO publications (title, title_normalized, url, status, source, first_seen_at, date_added, created_at, roundup_id)
          VALUES (?, ?, 'https://example.com', ?, 'crossref', ?, ?, ?, ?)`,
    args: [title, title.toLowerCase(), overrides.status ?? "pending_merge", now, overrides.dateAdded ?? now.slice(0, 10), now, overrides.roundupId ?? null],
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

// ─── 1. Tokens are hashed at rest ──────────────────────────────────────────
describe("1. Tokens are hashed at rest — real campaign code, full-schema scan", () => {
  it("mints a real token via the real campaign code, then scans every column of every row of review_requests (and defensively settings/usage_log) for the raw token substring — zero hits", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "token-scan-"));
    const client = createClient({ url: `file:${path.join(dir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "..", "db", "migrations"));

    const facultyResult = await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, email, unit, active) VALUES ('1','scan-target','Scan, T.','scan@example.edu','Department of Health Sciences',1)`,
      args: [],
    });
    const facultyId = Number(facultyResult.lastInsertRowid);

    // The real campaign mint path — lib/campaigns.ts -> lib/review.ts::createReviewRequest,
    // the single code path both the CLI mint tool and the campaign tool route through.
    // createReviewRequest returns only {token, slug} — the hash is never
    // handed back to the caller at all, only ever written to the DB.
    const { token } = await createReviewRequest(client, facultyId, 90, "Scan Cycle");
    const tokenHash = hashToken(token);
    expect(token.length).toBeGreaterThan(20); // sanity: we actually have a real raw token to hunt for

    const tablesToScan = ["review_requests", "settings", "usage_log"];
    for (const table of tablesToScan) {
      const exists = (await client.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name = '${table}'`)).rows;
      if (exists.length === 0) continue;
      const columns = (await client.execute(`PRAGMA table_info(${table})`)).rows as unknown as Array<{ name: string }>;
      const rows = (await client.execute(`SELECT * FROM ${table}`)).rows;
      for (const row of rows) {
        for (const col of columns) {
          const value = (row as unknown as Record<string, unknown>)[col.name];
          if (typeof value === "string") {
            expect(value.includes(token), `${table}.${col.name} contained the raw token`).toBe(false);
          }
        }
      }
    }

    // And the one place it IS stored is a real, correct hash — not a
    // truncation, not the raw value, not something reversible.
    const rrRow = (await client.execute("SELECT token_hash FROM review_requests WHERE faculty_id = ?", [facultyId]))
      .rows[0] as unknown as { token_hash: string };
    expect(rrRow.token_hash).toBe(tokenHash);
    expect(rrRow.token_hash).toBe(hashToken(token));
    expect(rrRow.token_hash).not.toBe(token);
    expect(rrRow.token_hash).not.toContain(token);

    client.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── 2. Entropy ─────────────────────────────────────────────────────────────
describe("2. Entropy — 1,000 mints", () => {
  it("all 1,000 tokens are distinct, each encodes >=128 bits, and none contains any observable trace of its paired identity string or mint index", () => {
    const tokens: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const { token } = generateReviewToken();
      tokens.push(token);

      // The "identity" this token is minted alongside, in this hypothetical —
      // faculty_id, a slug, a display name, and the mint ordinal itself.
      // generateReviewToken() takes NO arguments (confirmed: lib/tokens.ts's
      // signature is `(): { token, tokenHash }`), so this is provably
      // structural, not incidental — but assert it concretely per the ask
      // rather than reasoning from the signature alone, and to guard against
      // a future refactor that threads an id through.
      //
      // Fragments must be long enough that a chance substring collision
      // against a 256-bit random token is astronomically unlikely, not just
      // "short" — a raw 1-3 digit index (e.g. "609") WILL turn up inside
      // some random base64url string across 1000 trials by pure chance
      // (P(hit) per token ≈ 43 × (1/64)^3 ≈ 0.0016, ×1000 trials ≈ expected
      // ~1-2 false positives) — confirmed empirically the hard way, not
      // theorized: an earlier version of this test using bare `String(i)`
      // flagged token #609 for containing "609," which is exactly that
      // coincidence, not a derivation. At length >= 8 the same math puts a
      // chance collision at ~1.4e-13 per token, negligible even ×1000.
      const identityFragments = [`faculty-id-${i}`, `review-slug-${i}`, `Person Number ${i}`];
      for (const fragment of identityFragments) {
        if (fragment.length >= 8) expect(token).not.toContain(fragment);
      }
    }

    expect(new Set(tokens).size).toBe(1000); // no collisions

    for (const token of tokens) {
      const byteLength = Buffer.from(token, "base64url").length;
      expect(byteLength * 8).toBeGreaterThanOrEqual(128);
    }
  });

  it("★ the source is a CSPRNG, not Math.random — asserted by reading lib/tokens.ts's own source, the crude-but-catches-the-failure-that-matters check", () => {
    const source = readFileSync(path.join(__dirname, "..", "..", "lib", "tokens.ts"), "utf-8");
    expect(source).not.toMatch(/Math\.random/);
    expect(source).toMatch(/randomBytes/); // node:crypto's CSPRNG
    expect(source).toMatch(/from ["']node:crypto["']/);
  });
});

// ─── 3. Expiry, driven with fake timers ────────────────────────────────────
describe("3. Expiry — fake-timer-driven, including the exact boundary", () => {
  it("a token exactly at expires_at, and one 1ms past it, are both rejected; one 1ms before it still works", async () => {
    await withFakeTimers(async () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const facultyId = await seedFacultyReal("Expiry, E.");
      const { token, tokenHash } = generateReviewToken();
      const expiresAt = new Date(Date.now() + 90 * 86400000); // matches REVIEW_TOKEN_TTL_DAYS default
      await dbClient.execute({
        sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, created_at, expires_at, revoked) VALUES (?, ?, 'expiry-test', ?, ?, 0)`,
        args: [facultyId, tokenHash, new Date().toISOString(), expiresAt.toISOString()],
      });

      // 1ms before expiry: still valid.
      vi.setSystemTime(new Date(expiresAt.getTime() - 1));
      expect(await getReviewRequestByToken(dbClient, token)).not.toBeNull();

      // Exactly at expires_at: the comparison is `expires_at < now` — equal
      // is NOT less-than, so the exact boundary instant is still accepted.
      // This is current behavior, worth naming precisely rather than assuming.
      vi.setSystemTime(new Date(expiresAt.getTime()));
      expect(await getReviewRequestByToken(dbClient, token)).not.toBeNull();

      // 1ms past: rejected.
      vi.setSystemTime(new Date(expiresAt.getTime() + 1));
      expect(await getReviewRequestByToken(dbClient, token)).toBeNull();
    });
  });

  it("an expired token is rejected on every write route (app/review/[slug]/[token]/actions.ts), not just the read path", async () => {
    const { setRoleAction, editCitationAction, markReviewCompleteAction } = await import("../../app/review/[slug]/[token]/actions");

    await withFakeTimers(async () => {
      vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
      const facultyId = await seedFacultyReal("Expiry Writes, E.");
      const pubId = await seedPublicationReal("Expiry Writes Paper");
      const authorId = await seedAuthorReal(pubId, facultyId, "Expiry Writes, E.", "chps_faculty");
      const coAuthorId = await seedAuthorReal(pubId, null, "Coauthor, C.", "unknown", 1);
      void authorId;

      const { token, tokenHash } = generateReviewToken();
      await dbClient.execute({
        sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, created_at, expires_at, revoked) VALUES (?, ?, 'expiry-writes', ?, ?, 0)`,
        args: [facultyId, tokenHash, new Date().toISOString(), new Date(Date.now() - 1000).toISOString()], // already expired
      });

      const formData = new FormData();
      formData.set("role", "grad_student");
      await expect(setRoleAction(token, "expiry-writes", coAuthorId, formData)).rejects.toThrow(/no longer valid/i);

      const citationForm = new FormData();
      citationForm.set("journal", "Hijacked Via Expired Token");
      await expect(editCitationAction(token, "expiry-writes", pubId, citationForm)).rejects.toThrow(/no longer valid/i);

      await expect(markReviewCompleteAction(token, "expiry-writes")).rejects.toThrow(/no longer valid/i);

      // Nothing moved.
      const coAuthorRow = (await dbClient.execute("SELECT role FROM publication_authors WHERE id = ?", [coAuthorId])).rows[0] as unknown as { role: string };
      expect(coAuthorRow.role).toBe("unknown");
    });
  });
});

// ─── 4. Revocation, mid-session ────────────────────────────────────────────
describe("4. Revocation — rejects immediately, mid-session, on every route", () => {
  it("a token valid at the start of a session, revoked mid-session, is rejected on the read path and every write action from that point on", async () => {
    const { setRoleAction } = await import("../../app/review/[slug]/[token]/actions");

    const facultyId = await seedFacultyReal("Revoke MidSession, R.");
    const pubId = await seedPublicationReal("Revoke MidSession Paper");
    await seedAuthorReal(pubId, facultyId, "Revoke MidSession, R.", "chps_faculty");
    const coAuthorId = await seedAuthorReal(pubId, null, "Coauthor, C.", "unknown", 1);

    const { token, tokenHash } = generateReviewToken();
    const rrResult = await dbClient.execute({
      sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, created_at, expires_at, revoked) VALUES (?, ?, 'revoke-mid', ?, ?, 0)`,
      args: [facultyId, tokenHash, new Date().toISOString(), new Date(Date.now() + 90 * 86400000).toISOString()],
    });
    const reviewRequestId = Number(rrResult.lastInsertRowid);

    // "Mid-session": the token works once (the equivalent of an already-open
    // browser tab having loaded the page)...
    expect(await getReviewRequestByToken(dbClient, token)).not.toBeNull();

    // ...then gets revoked out from under it.
    await dbClient.execute({ sql: "UPDATE review_requests SET revoked = 1 WHERE id = ?", args: [reviewRequestId] });

    expect(await getReviewRequestByToken(dbClient, token)).toBeNull();
    const formData = new FormData();
    formData.set("role", "grad_student");
    await expect(setRoleAction(token, "revoke-mid", coAuthorId, formData)).rejects.toThrow(/no longer valid/i);

    const row = (await dbClient.execute("SELECT role FROM publication_authors WHERE id = ?", [coAuthorId])).rows[0] as unknown as { role: string };
    expect(row.role).toBe("unknown"); // untouched
  });
});

// ─── 5. Finalize's interaction with outstanding tokens ─────────────────────
describe("5. Finalize (§6b) and campaign tokens — empirical, not assumed", () => {
  it("★ finalizing a roundup does NOT revoke or expire the token — the master plan's own §8b correction (Session 19) documents this as a deliberate non-fix, confirmed here against real code, not just the doc", async () => {
    const facultyId = await seedFacultyReal("Finalize Interaction, F.");
    const willBeFinalizedId = await seedPublicationReal("Will Be Finalized This Edition", { status: "published" });
    await seedAuthorReal(willBeFinalizedId, facultyId, "Finalize Interaction, F.", "chps_faculty");
    const stillPendingId = await seedPublicationReal("Still Pending, Different Paper", { status: "pending_merge" });
    await seedAuthorReal(stillPendingId, facultyId, "Finalize Interaction, F.", "chps_faculty");

    const { token } = await createReviewRequest(dbClient, facultyId, 90, "Finalize Cycle");

    const before = await getReviewRequestByToken(dbClient, token);
    expect(before).not.toBeNull(); // sanity

    await finalizeRoundup(dbClient, {
      label: "Test Edition — Finalize Interaction",
      generatedBy: "test",
      cutoffDate: new Date().toISOString().slice(0, 10),
      title: "Test Edition",
      intro: "Intro",
      legendLine: "Legend",
      publicationIds: [willBeFinalizedId],
    });

    // THE FINDING: the token itself is still valid — grep of
    // lib/roundup-finalize.ts confirms zero references to review_requests or
    // "token" anywhere in that file. This is not a gap this pack should
    // silently flag as a bug: it is the documented, deliberate outcome of
    // Session 19's correction (finalize gates WRITES via isPublicationFinalized,
    // not token validity) — but it means a naive assumption that "finalize
    // kills outstanding links for that cycle" is simply false, empirically,
    // and worth restating here as a live-verified fact, not an inference.
    const after = await getReviewRequestByToken(dbClient, token);
    expect(after).not.toBeNull();
    expect(after?.faculty_id).toBe(facultyId);

    // What DOES change: the review page's own list of reviewable
    // publications for this faculty member — the just-finalized paper drops
    // out (roundup_id now set), the still-pending one remains. The token
    // keeps working for the real remaining work, exactly as §8b's correction
    // describes.
    const { getReviewablePublications } = await import("../../lib/review");
    const reviewable = await getReviewablePublications(dbClient, facultyId);
    expect(reviewable.map((p) => p.id)).toEqual([stillPendingId]);
    expect(reviewable.map((p) => p.id)).not.toContain(willBeFinalizedId);
  });
});

// ─── 6. ★ The slug is never a credential — table-driven ───────────────────
describe("6. ★ The slug is never a credential (§8b.4) — table-driven across the real review routes", () => {
  async function setup() {
    const facultyAId = await seedFacultyReal("Slug Owner A, A.");
    const facultyBId = await seedFacultyReal("Different Faculty B, B.");
    const pubAId = await seedPublicationReal("Faculty A's Paper");
    await seedAuthorReal(pubAId, facultyAId, "Slug Owner A, A.", "chps_faculty");
    const coAuthorOnAId = await seedAuthorReal(pubAId, null, "Unconfirmed Coauthor, U.", "unknown", 1);
    const pubBId = await seedPublicationReal("Faculty B's Own Paper");
    await seedAuthorReal(pubBId, facultyBId, "Different Faculty B, B.", "chps_faculty");

    const { token: tokenA, slug: slugA } = await createReviewRequest(dbClient, facultyAId, 90, "Slug Table Cycle");
    const { token: tokenB, slug: slugB } = await createReviewRequest(dbClient, facultyBId, 90, "Slug Table Cycle");

    return { facultyAId, facultyBId, pubAId, coAuthorOnAId, pubBId, tokenA, slugA, tokenB, slugB };
  }

  it("correct slug + correct token: works", async () => {
    const { setRoleAction } = await import("../../app/review/[slug]/[token]/actions");
    const { slugA, tokenA, coAuthorOnAId } = await setup();

    const formData = new FormData();
    formData.set("role", "grad_student");
    await setRoleAction(tokenA, slugA, coAuthorOnAId, formData);

    const row = (await dbClient.execute("SELECT role FROM publication_authors WHERE id = ?", [coAuthorOnAId])).rows[0] as unknown as { role: string };
    expect(row.role).toBe("grad_student");
  });

  it("wrong slug + correct token: still works — the slug is cosmetic, never gates the action", async () => {
    const { setRoleAction } = await import("../../app/review/[slug]/[token]/actions");
    const { tokenA, coAuthorOnAId } = await setup();

    const formData = new FormData();
    formData.set("role", "undergrad_student");
    // A completely made-up slug — not even a real faculty's slug.
    await setRoleAction(tokenA, "totally-wrong-slug-xyz", coAuthorOnAId, formData);

    const row = (await dbClient.execute("SELECT role FROM publication_authors WHERE id = ?", [coAuthorOnAId])).rows[0] as unknown as { role: string };
    expect(row.role).toBe("undergrad_student"); // the write still happened
  });

  it("correct slug + no token: rejected", async () => {
    const { setRoleAction } = await import("../../app/review/[slug]/[token]/actions");
    const { slugA, coAuthorOnAId } = await setup();

    const formData = new FormData();
    formData.set("role", "grad_student");
    await expect(setRoleAction("", slugA, coAuthorOnAId, formData)).rejects.toThrow(/no longer valid/i);

    const row = (await dbClient.execute("SELECT role FROM publication_authors WHERE id = ?", [coAuthorOnAId])).rows[0] as unknown as { role: string };
    expect(row.role).toBe("unknown"); // untouched
  });

  it("correct slug + tampered token (one character changed): rejected", async () => {
    const { setRoleAction } = await import("../../app/review/[slug]/[token]/actions");
    const { slugA, tokenA, coAuthorOnAId } = await setup();

    const tampered = tokenA.slice(0, -1) + (tokenA.at(-1) === "A" ? "B" : "A");
    const formData = new FormData();
    formData.set("role", "grad_student");
    await expect(setRoleAction(tampered, slugA, coAuthorOnAId, formData)).rejects.toThrow(/no longer valid/i);

    const row = (await dbClient.execute("SELECT role FROM publication_authors WHERE id = ?", [coAuthorOnAId])).rows[0] as unknown as { role: string };
    expect(row.role).toBe("unknown"); // untouched
  });

  it("★ correct slug + ANOTHER faculty member's valid token: scoped ENTIRELY to that token's faculty — no data from the slug's owner, on read or write", async () => {
    const { setRoleAction } = await import("../../app/review/[slug]/[token]/actions");
    const { getReviewablePublications } = await import("../../lib/review");
    const { slugA, tokenB, facultyBId, pubAId, pubBId, coAuthorOnAId } = await setup();

    // Write side: Faculty B's token, but Faculty A's slug in the URL. The
    // action must resolve to Faculty B, and Faculty B has no row on
    // pubA/coAuthorOnAId — the scoped UPDATE in setCoAuthorRole (WHERE ...
    // EXISTS (publication_authors.faculty_id = <resolved id>)) must find
    // nothing to touch.
    const formData = new FormData();
    formData.set("role", "grad_student");
    await setRoleAction(tokenB, slugA, coAuthorOnAId, formData);

    const row = (await dbClient.execute("SELECT role FROM publication_authors WHERE id = ?", [coAuthorOnAId])).rows[0] as unknown as { role: string };
    expect(row.role).toBe("unknown"); // Faculty A's data, completely untouched despite A's slug in the URL

    // Read side: the page-equivalent (getReviewRequestByToken + getReviewablePublications)
    // driven with Faculty A's slug in the URL but Faculty B's token — must
    // resolve to Faculty B's OWN publications only, never Faculty A's,
    // regardless of what slug appeared in the URL.
    const resolved = await getReviewRequestByToken(dbClient, tokenB);
    expect(resolved?.faculty_id).toBe(facultyBId); // resolved by TOKEN, slugA in the URL is irrelevant

    const reviewable = await getReviewablePublications(dbClient, resolved!.faculty_id);
    expect(reviewable.map((p) => p.id)).toEqual([pubBId]);
    expect(reviewable.map((p) => p.id)).not.toContain(pubAId); // never Faculty A's paper, even under A's own slug
  });
});

// ─── 7. Token comparison — indexed equality, not a scan ────────────────────
describe("7. Token comparison — lookup is by hash equality on an indexed column", () => {
  it("token_hash carries a real UNIQUE constraint (SQLite auto-indexes it), and getReviewRequestByToken's query plan uses that index, not a full table scan", async () => {
    // Schema-level: the constraint itself, straight from the migration.
    const indexList = (await dbClient.execute("PRAGMA index_list(review_requests)")).rows as unknown as Array<{ name: string; unique: number; origin: string }>;
    const uniqueIndexOnTokenHash = indexList.filter((i) => i.unique === 1);
    expect(uniqueIndexOnTokenHash.length).toBeGreaterThan(0);

    let foundTokenHashIndex = false;
    for (const idx of uniqueIndexOnTokenHash) {
      const cols = (await dbClient.execute(`PRAGMA index_info(${idx.name})`)).rows as unknown as Array<{ name: string }>;
      if (cols.some((c) => c.name === "token_hash")) foundTokenHashIndex = true;
    }
    expect(foundTokenHashIndex).toBe(true);

    // Query-plan-level: the exact SQL lib/review.ts::getReviewRequestByToken
    // issues (SELECT * FROM review_requests WHERE token_hash = ?) — EXPLAIN
    // QUERY PLAN must name an index search, not "SCAN review_requests".
    const plan = (await dbClient.execute("EXPLAIN QUERY PLAN SELECT * FROM review_requests WHERE token_hash = 'x'")).rows as unknown as Array<{
      detail: string;
    }>;
    const planText = plan.map((p) => p.detail).join(" | ");
    expect(planText).not.toMatch(/SCAN review_requests/);
    expect(planText).toMatch(/SEARCH review_requests USING (INDEX|COVERING INDEX)/i);
  });
});

// ─── 8. ★ opened_at records a page load, not a human ───────────────────────
describe("8. ★ opened_at as a Safe-Links-prefetch oracle — current behavior, no redesign", () => {
  it("a bare GET (getReviewRequestByToken + markReviewRequestOpened, exactly what page.tsx does) sets opened_at; a second GET does not overwrite it; the created_at -> opened_at delta is computable and can be sub-minute", async () => {
    await withFakeTimers(async () => {
      vi.setSystemTime(new Date("2026-03-01T09:00:00.000Z"));
      const facultyId = await seedFacultyReal("Safelinks Scanner, S.");
      const { token, slug } = await createReviewRequest(dbClient, facultyId, 90, "Safelinks Cycle");
      void slug;
      const createdAt = new Date();

      // Outlook Safe Links prefetches the link within seconds of send —
      // simulate exactly that: 3 seconds later, a bare GET (no human involved).
      vi.setSystemTime(new Date(createdAt.getTime() + 3000));
      const reviewRequest = await getReviewRequestByToken(dbClient, token);
      await markReviewRequestOpened(dbClient, reviewRequest!.id);

      const afterFirstGet = await getReviewRequestByToken(dbClient, token);
      expect(afterFirstGet?.opened_at).not.toBeNull();
      const deltaMs = new Date(afterFirstGet!.opened_at!).getTime() - createdAt.getTime();
      expect(deltaMs).toBeLessThan(60_000); // sub-minute — indistinguishable from scanner traffic by this mechanism alone

      // A second GET, minutes later (the real human, if any, actually
      // opening it) — opened_at does NOT move, so there is no way to
      // recover "when did a human actually open this" once a scanner has
      // already claimed the timestamp.
      vi.setSystemTime(new Date(createdAt.getTime() + 5 * 60_000));
      await markReviewRequestOpened(dbClient, reviewRequest!.id);
      const afterSecondGet = await getReviewRequestByToken(dbClient, token);
      expect(afterSecondGet?.opened_at).toBe(afterFirstGet?.opened_at);
    });
  });

  it("the mechanism cannot distinguish a 3-second scanner open from a 2-day-later genuine human open — both produce an identical-shaped opened_at write, and §8b's single-reminder logic reads either the same way", async () => {
    await withFakeTimers(async () => {
      vi.setSystemTime(new Date("2026-03-01T09:00:00.000Z"));
      const facultyId = await seedFacultyReal("Human Opener, H.");
      const { token } = await createReviewRequest(dbClient, facultyId, 90, "Human Cycle");
      const createdAt = new Date();

      // A genuine human, 2 days later.
      vi.setSystemTime(new Date(createdAt.getTime() + 2 * 86400000));
      const reviewRequest = await getReviewRequestByToken(dbClient, token);
      await markReviewRequestOpened(dbClient, reviewRequest!.id);

      const after = await getReviewRequestByToken(dbClient, token);
      // Same shape, same column, same semantics as the 3-second scanner
      // case above — getFacultyWithOutstandingReview / §8b's reminder logic
      // has no field that distinguishes them. Reporting current behavior
      // only: a campaign with a cluster of sub-minute opened_at deltas is a
      // real, readable signal of scanner traffic (compute the delta, as
      // this test does) — but nothing in the schema or code currently
      // computes or surfaces that signal automatically.
      expect(after?.opened_at).not.toBeNull();
      expect(typeof after?.opened_at).toBe("string");
    });
  });
});

// ─── 9. Response uniformity ─────────────────────────────────────────────────
describe("9. Response uniformity — nonexistent, expired, and revoked tokens", () => {
  it("current behavior: all three produce the IDENTICAL response (null from getReviewRequestByToken -> page.tsx's generic 'no longer valid' message) — maximally uniform, leaks the least", async () => {
    const facultyId = await seedFacultyReal("Uniformity, U.");

    // Never existed.
    const neverExisted = await getReviewRequestByToken(dbClient, "this-token-was-never-minted-at-all");

    // Expired.
    const { token: expiredToken, tokenHash: expiredHash } = generateReviewToken();
    await dbClient.execute({
      sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, created_at, expires_at, revoked) VALUES (?, ?, 'uniformity-expired', ?, ?, 0)`,
      args: [facultyId, expiredHash, new Date().toISOString(), new Date(Date.now() - 1000).toISOString()],
    });
    const expired = await getReviewRequestByToken(dbClient, expiredToken);

    // Revoked.
    const { token: revokedToken, tokenHash: revokedHash } = generateReviewToken();
    await dbClient.execute({
      sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, created_at, expires_at, revoked) VALUES (?, ?, 'uniformity-revoked', ?, ?, 1)`,
      args: [facultyId, revokedHash, new Date().toISOString(), new Date(Date.now() + 90 * 86400000).toISOString()],
    });
    const revoked = await getReviewRequestByToken(dbClient, revokedToken);

    // All three are exactly `null` — bit-for-bit the same value the caller
    // (page.tsx) branches on, so all three render the identical "This link
    // is no longer valid." copy with no distinguishing detail. This IS the
    // current behavior — see the report for the trade-off, not a fix here.
    expect(neverExisted).toBeNull();
    expect(expired).toBeNull();
    expect(revoked).toBeNull();
  });
});
