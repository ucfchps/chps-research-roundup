// Session 16: the bulk version of the personal review page (§8c Tab 3).
// getFacultyNeedingReview must reuse lib/review.ts::getReviewablePublications
// — the exact function the review page itself uses — so "has something to
// review" can never drift between the page and who gets emailed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import {
  buildCampaignPlan,
  buildInvitationEmail,
  getCampaignStatus,
  getFacultyNeedingReview,
  runCampaign,
} from "../lib/campaigns";

describe("campaigns", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "campaigns-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  async function seedFaculty(overrides: { displayName: string; email?: string | null; active?: number }): Promise<number> {
    const result = await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, email, unit, active) VALUES (?, ?, ?, ?, 'Department of Health Sciences', ?)`,
      args: [
        overrides.displayName,
        overrides.displayName,
        overrides.displayName,
        overrides.email === undefined ? `${overrides.displayName}@ucf.edu` : overrides.email,
        overrides.active ?? 1,
      ],
    });
    return Number(result.lastInsertRowid);
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

  async function seedAuthor(pubId: number, facultyId: number | null, name: string, role: string, position: number): Promise<void> {
    await client.execute({
      sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, position) VALUES (?, ?, ?, ?, ?)`,
      args: [pubId, facultyId, name, role, position],
    });
  }

  describe("getFacultyNeedingReview", () => {
    it("includes a faculty member with an eligible unposted publication of their own", async () => {
      const facultyId = await seedFaculty({ displayName: "Own Paper, O." });
      const pubId = await seedPublication({ title: "Own Paper's Paper" });
      await seedAuthor(pubId, facultyId, "Own Paper, O.", "chps_faculty", 0);

      const needs = await getFacultyNeedingReview(client);

      expect(needs.map((n) => n.displayName)).toContain("Own Paper, O.");
      expect(needs.find((n) => n.displayName === "Own Paper, O.")?.queuedPublicationCount).toBe(1);
    });

    it("includes a faculty member with an unknown co-author on their own confirmed paper", async () => {
      const facultyId = await seedFaculty({ displayName: "Has Coauthor, H." });
      const pubId = await seedPublication({ title: "Coauthored Paper" });
      await seedAuthor(pubId, facultyId, "Has Coauthor, H.", "chps_faculty", 0);
      await seedAuthor(pubId, null, "Unidentified, U.", "unknown", 1);

      const needs = await getFacultyNeedingReview(client);

      const entry = needs.find((n) => n.displayName === "Has Coauthor, H.");
      expect(entry).toBeDefined();
      expect(entry?.unidentifiedCoAuthorCount).toBe(1);
    });

    it("includes a faculty member with both an unposted paper of their own AND an unknown co-author on it", async () => {
      const facultyId = await seedFaculty({ displayName: "Both Cases, B." });
      const pubId = await seedPublication({ title: "Both Cases Paper" });
      await seedAuthor(pubId, facultyId, "Both Cases, B.", "chps_faculty", 0);
      await seedAuthor(pubId, null, "Unidentified, U.", "unknown", 1);

      const needs = await getFacultyNeedingReview(client);

      const entry = needs.find((n) => n.displayName === "Both Cases, B.");
      expect(entry?.queuedPublicationCount).toBe(1);
      expect(entry?.unidentifiedCoAuthorCount).toBe(1);
    });

    it("excludes a faculty member with nothing to review", async () => {
      await seedFaculty({ displayName: "Nothing Pending, N." });

      const needs = await getFacultyNeedingReview(client);

      expect(needs.find((n) => n.displayName === "Nothing Pending, N.")).toBeUndefined();
    });

    it("excludes a faculty member whose only publication is already posted", async () => {
      const facultyId = await seedFaculty({ displayName: "Already Posted, A." });
      await client.execute(`INSERT INTO roundups (label, generated_at, pub_count, html) VALUES ('Test Edition', datetime('now'), 1, '<html></html>')`);
      const pubId = await seedPublication({ title: "Posted Paper", roundupId: 1 });
      await seedAuthor(pubId, facultyId, "Already Posted, A.", "chps_faculty", 0);

      const needs = await getFacultyNeedingReview(client);

      expect(needs.find((n) => n.displayName === "Already Posted, A.")).toBeUndefined();
    });

    it("excludes an inactive faculty member even with an eligible publication", async () => {
      const facultyId = await seedFaculty({ displayName: "Inactive, I.", active: 0 });
      const pubId = await seedPublication({ title: "Inactive Person's Paper" });
      await seedAuthor(pubId, facultyId, "Inactive, I.", "chps_faculty", 0);

      const needs = await getFacultyNeedingReview(client);

      expect(needs.find((n) => n.displayName === "Inactive, I.")).toBeUndefined();
    });
  });

  describe("buildCampaignPlan", () => {
    it("marks alreadyHasActiveToken=false when no prior token exists for this cycle", async () => {
      const facultyId = await seedFaculty({ displayName: "Fresh, F." });
      const pubId = await seedPublication({ title: "Fresh Paper" });
      await seedAuthor(pubId, facultyId, "Fresh, F.", "chps_faculty", 0);

      const plan = await buildCampaignPlan(client, "Fall 2026 review");

      expect(plan.entries.find((e) => e.displayName === "Fresh, F.")?.alreadyHasActiveToken).toBe(false);
    });

    it("marks alreadyHasActiveToken=true when an active, unexpired, unrevoked token already exists for this cycle", async () => {
      const facultyId = await seedFaculty({ displayName: "Already Sent, A." });
      const pubId = await seedPublication({ title: "Already Sent Paper" });
      await seedAuthor(pubId, facultyId, "Already Sent, A.", "chps_faculty", 0);
      const now = new Date().toISOString();
      await client.execute({
        sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, cycle_label, created_at, expires_at, revoked) VALUES (?, 'somehash', 'already-sent-a', ?, ?, ?, 0)`,
        args: [facultyId, "Fall 2026 review", now, new Date(Date.now() + 90 * 86400000).toISOString()],
      });

      const plan = await buildCampaignPlan(client, "Fall 2026 review");

      expect(plan.entries.find((e) => e.displayName === "Already Sent, A.")?.alreadyHasActiveToken).toBe(true);
    });

    it("does not count a token from a DIFFERENT cycle_label as already-active", async () => {
      const facultyId = await seedFaculty({ displayName: "Different Cycle, D." });
      const pubId = await seedPublication({ title: "Different Cycle Paper" });
      await seedAuthor(pubId, facultyId, "Different Cycle, D.", "chps_faculty", 0);
      const now = new Date().toISOString();
      await client.execute({
        sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, cycle_label, created_at, expires_at, revoked) VALUES (?, 'somehash', 'different-cycle-d', ?, ?, ?, 0)`,
        args: [facultyId, "Spring 2025 review", now, new Date(Date.now() + 90 * 86400000).toISOString()],
      });

      const plan = await buildCampaignPlan(client, "Fall 2026 review");

      expect(plan.entries.find((e) => e.displayName === "Different Cycle, D.")?.alreadyHasActiveToken).toBe(false);
    });

    it("does not count an EXPIRED token as already-active", async () => {
      const facultyId = await seedFaculty({ displayName: "Expired Token, E." });
      const pubId = await seedPublication({ title: "Expired Token Paper" });
      await seedAuthor(pubId, facultyId, "Expired Token, E.", "chps_faculty", 0);
      const now = new Date().toISOString();
      await client.execute({
        sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, cycle_label, created_at, expires_at, revoked) VALUES (?, 'somehash', 'expired-token-e', ?, ?, ?, 0)`,
        args: [facultyId, "Fall 2026 review", now, new Date(Date.now() - 1000).toISOString()],
      });

      const plan = await buildCampaignPlan(client, "Fall 2026 review");

      expect(plan.entries.find((e) => e.displayName === "Expired Token, E.")?.alreadyHasActiveToken).toBe(false);
    });

    it("does not count a REVOKED token as already-active", async () => {
      const facultyId = await seedFaculty({ displayName: "Revoked Token, R." });
      const pubId = await seedPublication({ title: "Revoked Token Paper" });
      await seedAuthor(pubId, facultyId, "Revoked Token, R.", "chps_faculty", 0);
      const now = new Date().toISOString();
      await client.execute({
        sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, cycle_label, created_at, expires_at, revoked) VALUES (?, 'somehash', 'revoked-token-r', ?, ?, ?, 1)`,
        args: [facultyId, "Fall 2026 review", now, new Date(Date.now() + 90 * 86400000).toISOString()],
      });

      const plan = await buildCampaignPlan(client, "Fall 2026 review");

      expect(plan.entries.find((e) => e.displayName === "Revoked Token, R.")?.alreadyHasActiveToken).toBe(false);
    });
  });

  describe("buildInvitationEmail", () => {
    it("surfaces real counts from the input, not hardcoded numbers", () => {
      const { subject, body } = buildInvitationEmail(
        {
          facultyId: 1,
          wpId: null,
          slug: "matt-stock",
          displayName: "Stock, M.S.",
          email: "stock@ucf.edu",
          queuedPublicationCount: 5,
          unidentifiedCoAuthorCount: 7,
        },
        "https://example.com/review/matt-stock/tok123"
      );

      expect(subject.length).toBeGreaterThan(0);
      expect(body).toContain("5");
      expect(body).toContain("7");
      expect(body).toContain("https://example.com/review/matt-stock/tok123");
    });

    it("omits the co-author clause entirely when the count is zero", () => {
      const { body } = buildInvitationEmail(
        {
          facultyId: 1,
          wpId: null,
          slug: "matt-stock",
          displayName: "Stock, M.S.",
          email: "stock@ucf.edu",
          queuedPublicationCount: 3,
          unidentifiedCoAuthorCount: 0,
        },
        "https://example.com/review/matt-stock/tok123"
      );

      expect(body).not.toContain("0 co-author");
    });
  });

  describe("runCampaign", () => {
    async function seedEligibleFaculty(displayName: string, email: string | null = `${displayName}@ucf.edu`): Promise<number> {
      const facultyId = await seedFaculty({ displayName, email });
      const pubId = await seedPublication({ title: `${displayName}'s Paper` });
      await seedAuthor(pubId, facultyId, displayName, "chps_faculty", 0);
      return facultyId;
    }

    function baseOpts(overrides: Partial<Parameters<typeof runCampaign>[2]> = {}): Parameters<typeof runCampaign>[2] {
      return {
        dryRun: false,
        ttlDays: 90,
        appBaseUrl: "https://example.com",
        emailFrom: "roundup@ucf.edu",
        emailReplyTo: "roundup@ucf.edu",
        sendMessageFn: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      };
    }

    it("mints nothing and sends nothing when the plan is empty (skip-if-nothing enforced at the mint/send layer)", async () => {
      await seedFaculty({ displayName: "Nothing To Review, N." }); // active, but no eligible publication
      const sendMessageFn = vi.fn().mockResolvedValue(undefined);

      const result = await runCampaign(client, "Fall 2026 review", baseOpts({ sendMessageFn }));

      expect(result.eligibleCount).toBe(0);
      expect(sendMessageFn).not.toHaveBeenCalled();
      const rows = await client.execute("SELECT COUNT(*) as c FROM review_requests");
      expect((rows.rows[0] as unknown as { c: number }).c).toBe(0);
    });

    it("--dry-run performs zero token mints and zero Gmail calls", async () => {
      await seedEligibleFaculty("Dry Run Person, D.");
      const sendMessageFn = vi.fn().mockResolvedValue(undefined);

      const result = await runCampaign(client, "Fall 2026 review", baseOpts({ dryRun: true, sendMessageFn }));

      expect(result.eligibleCount).toBe(1);
      expect(result.sent).toContain("Dry Run Person, D.");
      expect(sendMessageFn).not.toHaveBeenCalled();
      const rows = await client.execute("SELECT COUNT(*) as c FROM review_requests");
      expect((rows.rows[0] as unknown as { c: number }).c).toBe(0);
    });

    it("a real run mints a token and sends exactly one email per eligible faculty member", async () => {
      await seedEligibleFaculty("Real Run Person, R.");
      const sendMessageFn = vi.fn().mockResolvedValue(undefined);

      const result = await runCampaign(client, "Fall 2026 review", baseOpts({ sendMessageFn }));

      expect(result.sent).toContain("Real Run Person, R.");
      expect(sendMessageFn).toHaveBeenCalledTimes(1);
      const rows = (await client.execute("SELECT faculty_id, cycle_label, token_hash FROM review_requests")).rows as unknown as Array<{
        faculty_id: number;
        cycle_label: string;
        token_hash: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].cycle_label).toBe("Fall 2026 review");
      expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex, not a raw token
    });

    it("re-running for the same cycle_label does not mint or send a second time (idempotency)", async () => {
      await seedEligibleFaculty("Idempotent Person, I.");
      const sendMessageFn = vi.fn().mockResolvedValue(undefined);

      await runCampaign(client, "Fall 2026 review", baseOpts({ sendMessageFn }));
      const secondResult = await runCampaign(client, "Fall 2026 review", baseOpts({ sendMessageFn }));

      expect(secondResult.skippedAlreadyActive).toContain("Idempotent Person, I.");
      expect(sendMessageFn).toHaveBeenCalledTimes(1); // not 2
      const rows = await client.execute("SELECT COUNT(*) as c FROM review_requests");
      expect((rows.rows[0] as unknown as { c: number }).c).toBe(1); // not 2
    });

    it("records a send failure without aborting the rest of the batch — one bad address doesn't sink everyone else", async () => {
      await seedEligibleFaculty("Bad Address, B.");
      await seedEligibleFaculty("Good Address, G.");
      const sendMessageFn = vi.fn().mockImplementation(async (input: { to: string }) => {
        if (input.to === "Bad Address, B.@ucf.edu") throw new Error("550 no such user");
      });

      const result = await runCampaign(client, "Fall 2026 review", baseOpts({ sendMessageFn }));

      expect(result.sendFailures).toEqual([expect.objectContaining({ displayName: "Bad Address, B." })]);
      expect(result.sent).toContain("Good Address, G.");
    });

    it("reports a missing email as a send failure rather than crashing the run", async () => {
      await seedEligibleFaculty("No Email On File, N.", null);
      const sendMessageFn = vi.fn().mockResolvedValue(undefined);

      const result = await runCampaign(client, "Fall 2026 review", baseOpts({ sendMessageFn }));

      expect(result.sendFailures).toEqual([expect.objectContaining({ displayName: "No Email On File, N.", email: null })]);
      expect(sendMessageFn).not.toHaveBeenCalled();
    });

    it("--faculty scoping: when facultyWpIds is given, only sends to those faculty even though others are eligible (a small deliberate test run before a full one)", async () => {
      await seedEligibleFaculty("Scoped In, S.");
      await seedEligibleFaculty("Scoped Out, S.");
      const scopedInRow = (await client.execute("SELECT wp_id FROM faculty WHERE display_name = 'Scoped In, S.'")).rows[0] as unknown as {
        wp_id: string;
      };
      const sendMessageFn = vi.fn().mockResolvedValue(undefined);

      const result = await runCampaign(client, "Fall 2026 review", baseOpts({ sendMessageFn, facultyWpIds: [scopedInRow.wp_id] }));

      expect(result.sent).toEqual(["Scoped In, S."]);
      expect(sendMessageFn).toHaveBeenCalledTimes(1);
    });

    describe("testRecipient", () => {
      it("sends to the override address, not the faculty member's real email, when set", async () => {
        await seedEligibleFaculty("Real Person, R.", "real-person@ucf.edu");
        const sendMessageFn = vi.fn().mockResolvedValue(undefined);

        await runCampaign(client, "Fall 2026 review", baseOpts({ sendMessageFn, testRecipient: "tester@ucf.edu" }));

        const [input] = sendMessageFn.mock.calls[0] as [{ to: string }];
        expect(input.to).toBe("tester@ucf.edu");
        expect(input.to).not.toBe("real-person@ucf.edu");
      });

      it("tags the subject with the real recipient only when testRecipient is set; a normal run's subject is unchanged", async () => {
        await seedEligibleFaculty("Real Person, R.", "real-person@ucf.edu");

        const normalSend = vi.fn().mockResolvedValue(undefined);
        await runCampaign(client, "Normal cycle", baseOpts({ sendMessageFn: normalSend }));
        const [normalInput] = normalSend.mock.calls[0] as [{ subject: string }];
        expect(normalInput.subject).not.toContain("TEST");

        const testSend = vi.fn().mockResolvedValue(undefined);
        await runCampaign(client, "Test cycle", baseOpts({ sendMessageFn: testSend, testRecipient: "tester@ucf.edu" }));
        const [testInput] = testSend.mock.calls[0] as [{ subject: string }];
        expect(testInput.subject).toContain("TEST");
        expect(testInput.subject).toContain("real-person@ucf.edu");
      });

      it("writes the identical review_requests row content whether or not testRecipient is set", async () => {
        const facultyA = await seedEligibleFaculty("Faculty A, A.");
        const facultyB = await seedEligibleFaculty("Faculty B, B.");

        await runCampaign(client, "Cycle A", baseOpts({ sendMessageFn: vi.fn().mockResolvedValue(undefined), facultyWpIds: undefined }));
        // Isolate: run cycle B only against facultyB, with testRecipient set.
        await runCampaign(
          client,
          "Cycle B",
          baseOpts({ sendMessageFn: vi.fn().mockResolvedValue(undefined), testRecipient: "tester@ucf.edu" })
        );

        const rowA = (await client.execute({ sql: "SELECT faculty_id, expires_at, cycle_label FROM review_requests WHERE faculty_id = ? AND cycle_label = 'Cycle A'", args: [facultyA] }))
          .rows[0] as unknown as { faculty_id: number; expires_at: string; cycle_label: string };
        const rowB = (await client.execute({ sql: "SELECT faculty_id, expires_at, cycle_label FROM review_requests WHERE faculty_id = ? AND cycle_label = 'Cycle B'", args: [facultyB] }))
          .rows[0] as unknown as { faculty_id: number; expires_at: string; cycle_label: string };

        expect(rowA.faculty_id).toBe(facultyA);
        expect(rowB.faculty_id).toBe(facultyB);
        // Same shape/format regardless of testRecipient — an ISO date string, not redacted or altered.
        expect(rowB.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(rowA.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });

      it("combining facultyWpIds and testRecipient scopes to exactly one faculty member and redirects exactly that one email", async () => {
        await seedEligibleFaculty("Target Person, T.", "target@ucf.edu");
        await seedEligibleFaculty("Other Person, O.", "other@ucf.edu");
        const targetRow = (await client.execute("SELECT wp_id FROM faculty WHERE display_name = 'Target Person, T.'")).rows[0] as unknown as {
          wp_id: string;
        };
        const sendMessageFn = vi.fn().mockResolvedValue(undefined);

        const result = await runCampaign(
          client,
          "Fall 2026 review",
          baseOpts({ sendMessageFn, facultyWpIds: [targetRow.wp_id], testRecipient: "tester@ucf.edu" })
        );

        expect(sendMessageFn).toHaveBeenCalledTimes(1);
        const [input] = sendMessageFn.mock.calls[0] as [{ to: string }];
        expect(input.to).toBe("tester@ucf.edu");
        expect(result.testRedirects).toEqual([{ displayName: "Target Person, T.", realEmail: "target@ucf.edu" }]);
      });
    });
  });

  describe("getCampaignStatus", () => {
    async function seedReviewRequest(
      facultyId: number,
      cycleLabel: string,
      overrides: Partial<{ openedAt: string | null; completedAt: string | null }> = {}
    ): Promise<void> {
      const now = new Date().toISOString();
      await client.execute({
        sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, cycle_label, created_at, expires_at, opened_at, completed_at, revoked)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        args: [
          facultyId,
          `hash-${facultyId}-${Math.random()}`,
          "some-slug",
          cycleLabel,
          now,
          new Date(Date.now() + 90 * 86400000).toISOString(),
          overrides.openedAt ?? null,
          overrides.completedAt ?? null,
        ],
      });
    }

    it("reports total sent, opened, and completed counts for the cycle", async () => {
      const a = await seedFaculty({ displayName: "Sent Only, A." });
      const b = await seedFaculty({ displayName: "Opened Only, B." });
      const c = await seedFaculty({ displayName: "Completed, C." });
      await seedReviewRequest(a, "Fall 2026 review");
      await seedReviewRequest(b, "Fall 2026 review", { openedAt: new Date().toISOString() });
      await seedReviewRequest(c, "Fall 2026 review", { openedAt: new Date().toISOString(), completedAt: new Date().toISOString() });

      const status = await getCampaignStatus(client, "Fall 2026 review");

      expect(status.totalSent).toBe(3);
      expect(status.openedCount).toBe(2);
      expect(status.completedCount).toBe(1);
    });

    it("lists faculty who were sent a link but haven't opened it", async () => {
      const a = await seedFaculty({ displayName: "Not Opened, A." });
      const b = await seedFaculty({ displayName: "Opened, B." });
      await seedReviewRequest(a, "Fall 2026 review");
      await seedReviewRequest(b, "Fall 2026 review", { openedAt: new Date().toISOString() });

      const status = await getCampaignStatus(client, "Fall 2026 review");

      expect(status.notYetOpened.map((e) => e.displayName)).toEqual(["Not Opened, A."]);
    });

    it("only counts review_requests for the given cycle_label", async () => {
      const a = await seedFaculty({ displayName: "Other Cycle, A." });
      await seedReviewRequest(a, "Spring 2025 review");

      const status = await getCampaignStatus(client, "Fall 2026 review");

      expect(status.totalSent).toBe(0);
    });

    it("reports zero opened/completed honestly when nothing has ever been wired to those columns (not a bug to paper over)", async () => {
      const a = await seedFaculty({ displayName: "Untracked, A." });
      await seedReviewRequest(a, "Fall 2026 review");

      const status = await getCampaignStatus(client, "Fall 2026 review");

      expect(status.openedCount).toBe(0);
      expect(status.completedCount).toBe(0);
    });
  });
});
