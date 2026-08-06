// Phase 5 hardening, Session 6 — §8b security model item 5 (master plan):
// "⚠️ <meta name='referrer' content='no-referrer'> on this page. It is full
// of outbound links to DOIs and publisher sites. Without this, clicking one
// sends a Referer header containing the full URL, token included, to that
// publisher's server. Also rel='noopener noreferrer' on every outbound
// link." Standing rule: report, don't fix. No modification to lib/,
// scripts/, app/, or db/.
//
// Coverage already existing, NOT duplicated here:
//   - tests/citation.test.ts: formatCitation/formatAuthor escaping for &, ",
//     ' — never tested against <script>/< / > payloads, which item 6 adds.
//   - tests/security/token-authorization.test.ts (Session 5): the full
//     attack matrix (no/expired/revoked/tampered tokens) at the ACTION
//     layer, snapshot-diffed for absence of writes — this file reuses that
//     same token setup but asks a different question of it (does anything
//     LEAK, not does anything WRITE).
//   - tests/admin-login-page.test.tsx: the established
//     react-dom/server::renderToStaticMarkup pattern for rendering a real
//     Next.js page component directly in Vitest ("No component-testing
//     library exists in this project... a real SSR render for what can [be
//     reached]") — reused here for ReviewPage.
// This file's job: everything about where the token can ESCAPE to once it's
// legitimately in the URL — the page's own referrer policy, outbound link
// attributes (including the citation formatter's own link, which the review
// page itself doesn't currently call but item 2 asks to check specifically),
// console/log leakage across the full request lifecycle including Session
// 5's rejection paths, response/error/redirect leakage, third-party
// requests, and XSS escaping of unauthenticated free-text input rendered on
// this page.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { runMigrations } from "../../db/migrate";
import { generateReviewToken } from "../../lib/tokens";
import { createReviewRequest } from "../../lib/review";
import { formatCitation } from "../../lib/citation";

process.env.CROSSREF_MAILTO ??= "test@example.com";

// Same as tests/security/token-authorization.test.ts and
// tests/security/token-lifecycle.test.ts — revalidatePath() throws outside a
// real Next.js request context ("static generation store missing").
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ★ Same ordering requirement as tests/security/token-authorization.test.ts:
// env vars must be set before the FIRST import of anything that transitively
// reaches lib/db.ts's eager module-level client singleton (page.tsx does,
// via @/lib/db). Set synchronously, at true top level, before any await import.
const dbDir = mkdtempSync(path.join(tmpdir(), "token-leakage-"));
process.env.TURSO_DATABASE_URL = `file:${path.join(dbDir, "test.db")}`;
process.env.TURSO_AUTH_TOKEN = "test-token";

const dbModule = await import("../../lib/db");
const dbClient: Client = dbModule.client;

const { renderToStaticMarkup } = await import("react-dom/server");
const { default: ReviewPage, metadata } = await import("../../app/review/[slug]/[token]/page");
const {
  setRoleAction,
  rejectAttributionAction,
  confirmOwnAttributionAction,
  editCitationAction,
  markReviewCompleteAction,
  addPublicationAction,
} = await import("../../app/review/[slug]/[token]/actions");

beforeAll(async () => {
  await runMigrations(dbClient, path.join(__dirname, "..", "..", "db", "migrations"));
});

let seq = 0;
async function seedFacultyReal(displayName: string): Promise<number> {
  seq++;
  const result = await dbClient.execute({
    sql: `INSERT INTO faculty (wp_id, slug, display_name, email, unit, active) VALUES (?, ?, ?, ?, 'Department of Health Sciences', 1)`,
    args: [`wp-${seq}`, `slug-${seq}`, displayName, `f${seq}@example.edu`],
  });
  return Number(result.lastInsertRowid);
}

async function seedPublicationReal(
  title: string,
  overrides: { doi?: string | null; journal?: string | null; volume?: string | null; pages?: string | null; url?: string } = {}
): Promise<number> {
  seq++;
  const now = new Date().toISOString();
  const result = await dbClient.execute({
    sql: `INSERT INTO publications (doi, title, title_normalized, url, journal, volume, pages, status, source, first_seen_at, date_added, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_merge', 'crossref', ?, ?, ?)`,
    args: [
      overrides.doi ?? null,
      title,
      title.toLowerCase(),
      overrides.url ?? "https://doi.org/10.1/example",
      overrides.journal ?? "Journal of Testing",
      overrides.volume ?? "1",
      overrides.pages ?? "1-10",
      now,
      now.slice(0, 10),
      now,
    ],
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
  return createReviewRequest(dbClient, facultyId, 90, "Leakage Test Cycle");
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

async function renderReviewPage(slug: string, token: string): Promise<string> {
  const element = await ReviewPage({ params: Promise.resolve({ slug, token }) });
  return renderToStaticMarkup(element);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. no-referrer
// ─────────────────────────────────────────────────────────────────────────
describe("1. no-referrer on the review page", () => {
  it("the page's real Metadata export sets referrer: 'no-referrer' — this is what Next.js's own head-injection pipeline reads to emit <meta name=\"referrer\" content=\"no-referrer\">", () => {
    // Next's Metadata API resolves <head> tags via its own build/render
    // pipeline, separate from the page component's own returned JSX tree —
    // a bare react-dom/server render of ReviewPage's JSX will never contain
    // a <meta> tag no matter what the metadata export says, because that's
    // not where Next reads it from. Asserting against the REAL exported
    // object (what Next's pipeline actually consumes) is the correct and
    // precise way to prove this, not a workaround.
    expect(metadata.referrer).toBe("no-referrer");
  });

  it("source-level confirmation: the literal string Next's pipeline needs is present, unconditionally, not behind a flag or a conditional", () => {
    const source = readFileSync(path.join(__dirname, "..", "..", "app", "review", "[slug]", "[token]", "page.tsx"), "utf-8");
    expect(source).toMatch(/export const metadata[^;]*referrer:\s*["']no-referrer["']/s);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Outbound link attributes
// ─────────────────────────────────────────────────────────────────────────
describe("2. Outbound link attributes — rel must contain both noopener and noreferrer", () => {
  it("every <a> tag on a real rendered page with several publications carries rel containing both noopener and noreferrer", async () => {
    const facultyId = await seedFacultyReal("Link Attrs, L.");
    const pubIds = await Promise.all([
      seedPublicationReal("First Outbound Link Paper", { doi: "10.1/link-1", url: "https://doi.org/10.1/link-1" }),
      seedPublicationReal("Second Outbound Link Paper", { doi: "10.1/link-2", url: "https://publisher.example.com/articles/link-2" }),
      seedPublicationReal("Third Outbound Link Paper", { doi: "10.1/link-3", url: "https://another-publisher.example.org/doi/link-3" }),
    ]);
    for (const pubId of pubIds) await seedAuthorReal(pubId, facultyId, "Link Attrs, L.", "chps_faculty");
    const { token, slug } = await mintValidToken(facultyId);

    const html = await renderReviewPage(slug, token);

    const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
    expect(anchors.length).toBeGreaterThanOrEqual(3); // sanity: found real outbound links, not zero

    for (const anchor of anchors) {
      const relMatch = anchor.match(/rel="([^"]*)"/);
      expect(relMatch, `anchor has no rel attribute at all: ${anchor}`).not.toBeNull();
      const relValues = (relMatch![1] ?? "").split(/\s+/);
      expect(relValues, `anchor missing noopener: ${anchor}`).toContain("noopener");
      expect(relValues, `anchor missing noreferrer: ${anchor}`).toContain("noreferrer");
    }
  });

  it("★ the citation formatter's OWN generated <a> tag — checked specifically, per the ask — carries NO rel attribute at all", () => {
    const pub = {
      id: 1,
      doi: "10.1/formatter-link",
      title: "A Paper Formatted By formatCitation",
      title_normalized: "",
      url: "https://doi.org/10.1/formatter-link",
      journal: "Journal of Testing",
      year: 2026,
      volume: "1",
      issue: "1",
      pages: "1-10",
      status: "published" as const,
      source: "crossref" as const,
      first_seen_at: "",
      date_added: "",
      released_at: null,
      roundup_id: null,
      discovered_by_faculty_id: null,
      scholar_alert_url: null,
      created_at: "",
    };
    const authors = [
      { id: 1, publication_id: 1, faculty_id: null, name: "Author, A.", role: "unknown" as const, role_set_by: null, role_set_at: null, position: 0 },
    ];

    const html = formatCitation(pub, authors);
    const anchorMatch = html.match(/<a\b[^>]*>/);
    expect(anchorMatch).not.toBeNull();

    // CURRENT BEHAVIOR: lib/citation.ts::formatCitation emits
    // `<a href="${pub.url}">${title}</a>` with no rel attribute whatsoever —
    // confirmed here, not assumed from reading the source. Not currently a
    // live token-leak risk: app/review/[slug]/[token]/page.tsx never
    // imports or calls formatCitation (confirmed by source grep — it only
    // imports formatAuthorList from lib/citation.ts), so this HTML is never
    // rendered on a token-bearing page today; it's used for the public
    // roundup post export (lib/roundup-export.ts), whose URLs never carry a
    // token. Flagged because item 2 asks to check the formatter's output
    // specifically, and because "the citation formatter is the product"
    // (§15.6) — if this function is ever reused on the review page (a
    // plausible future refactor, since it's the shared citation-rendering
    // logic), the missing rel would become a live gap at that point with no
    // additional code change needed to introduce it.
    expect(anchorMatch![0]).not.toMatch(/rel=/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Token never in logs
// ─────────────────────────────────────────────────────────────────────────
describe("3. Token never in logs — console.log/warn/error across a full request lifecycle, including forced error paths", () => {
  it("a valid render, every write action succeeding, AND every Session-5 rejection path (no/expired/revoked/tampered token) across all six actions — nothing captured contains the raw token", async () => {
    const facultyId = await seedFacultyReal("Log Leakage, L.");
    const pubId = await seedPublicationReal("Log Leakage Paper");
    await seedAuthorReal(pubId, facultyId, "Log Leakage, L.", "chps_faculty");
    const coAuthorId = await seedAuthorReal(pubId, null, "Log Coauthor, C.", "unknown", 1);
    const { token: validToken, slug: validSlug } = await mintValidToken(facultyId);
    const { token: expiredToken, slug: expiredSlug } = await mintExpiredToken(facultyId);
    const { token: revokedToken, slug: revokedSlug } = await mintRevokedToken(facultyId);
    const tamperedToken = tamper(validToken);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Real, successful lifecycle.
    await renderReviewPage(validSlug, validToken);
    const roleFd = new FormData();
    roleFd.set("role", "grad_student");
    await setRoleAction(validToken, validSlug, coAuthorId, roleFd);
    const citationFd = new FormData();
    citationFd.set("journal", "A New Journal Name");
    await editCitationAction(validToken, validSlug, pubId, citationFd);
    await markReviewCompleteAction(validToken, validSlug);

    // Forced error paths — every rejection shape Session 5's attack matrix
    // exercised, run against every action, specifically because "error
    // handlers that echo the request are the usual culprit."
    const rejectionAttempts: Array<Promise<unknown>> = [];
    for (const [badToken, badSlug] of [
      ["", "no-token-slug"],
      [expiredToken, expiredSlug],
      [revokedToken, revokedSlug],
      [tamperedToken, validSlug],
    ] as const) {
      rejectionAttempts.push(renderReviewPage(badSlug, badToken)); // page render never throws — shows the "no longer valid" branch
      rejectionAttempts.push(setRoleAction(badToken, badSlug, coAuthorId, roleFd).catch(() => {}));
      rejectionAttempts.push(rejectAttributionAction(badToken, badSlug, coAuthorId).catch(() => {}));
      rejectionAttempts.push(confirmOwnAttributionAction(badToken, badSlug, coAuthorId).catch(() => {}));
      rejectionAttempts.push(editCitationAction(badToken, badSlug, pubId, citationFd).catch(() => {}));
      rejectionAttempts.push(markReviewCompleteAction(badToken, badSlug).catch(() => {}));
      const addFd = new FormData();
      addFd.set("title", "An Attempt During A Forced Error Path");
      addFd.set("url", "https://example.com/attempt");
      rejectionAttempts.push(addPublicationAction(badToken, badSlug, { message: null }, addFd).catch(() => {}));
    }
    await Promise.all(rejectionAttempts);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();

    const allCaptured = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)));

    const allTokensToCheck = [validToken, expiredToken, revokedToken, tamperedToken];
    for (const capturedArg of allCaptured) {
      for (const t of allTokensToCheck) {
        expect(capturedArg, `console output contained a raw token: ${capturedArg}`).not.toContain(t);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Token never in responses, errors, or redirects
// ─────────────────────────────────────────────────────────────────────────
describe("4. Token never in responses, errors, or redirects", () => {
  it("thrown error messages from every rejection path never contain the raw token, across all six actions", async () => {
    const facultyId = await seedFacultyReal("Error Leakage, E.");
    const pubId = await seedPublicationReal("Error Leakage Paper");
    const ownRowId = await seedAuthorReal(pubId, facultyId, "Error Leakage, E.", "chps_faculty", 0);
    const { token: validToken, slug } = await mintValidToken(facultyId);
    const tamperedToken = tamper(validToken);

    const capturedMessages: string[] = [];
    const fd = new FormData();
    fd.set("role", "grad_student");
    const addFd = new FormData();
    addFd.set("title", "Attempt");
    addFd.set("url", "https://example.com/attempt");

    const attempts: Array<() => Promise<unknown>> = [
      () => setRoleAction(tamperedToken, slug, ownRowId, fd),
      () => rejectAttributionAction(tamperedToken, slug, ownRowId),
      () => confirmOwnAttributionAction(tamperedToken, slug, ownRowId),
      () => editCitationAction(tamperedToken, slug, pubId, fd),
      () => markReviewCompleteAction(tamperedToken, slug),
      () => addPublicationAction(tamperedToken, slug, { message: null }, addFd),
    ];

    for (const attempt of attempts) {
      try {
        await attempt();
        throw new Error("expected this attempt to reject");
      } catch (err) {
        capturedMessages.push((err as Error).message);
      }
    }

    expect(capturedMessages).toHaveLength(6);
    for (const message of capturedMessages) {
      expect(message).not.toContain(tamperedToken);
      expect(message).not.toContain(validToken);
      // The actual message is the same static, generic string every time —
      // confirms there's no per-token interpolation to ever leak from.
      expect(message).toMatch(/no longer valid/i);
    }
  });

  it("the invalid-token page render's OWN HTML output never contains the token that was rejected", async () => {
    const facultyId = await seedFacultyReal("Response Leakage, R.");
    const { token: validToken } = await mintValidToken(facultyId);
    const tamperedToken = tamper(validToken);

    const html = await renderReviewPage("whatever-slug", tamperedToken);

    expect(html).toContain("no longer valid"); // confirms we hit the rejection branch, not a fluke pass
    expect(html).not.toContain(tamperedToken);
    expect(html).not.toContain(validToken);
  });

  it("no redirect() call exists anywhere in the review-token action surface — structurally, there is no Location header for a token to ride along in", () => {
    // next/navigation's redirect() is what would set a Location header; this
    // file's actions only ever call revalidatePath() on success, never
    // redirect() — confirmed by source, not assumed. (Contrast with the
    // ADMIN actions, which do redirect with query params — a materially
    // different, session-token-free surface, out of scope here.)
    const source = readFileSync(path.join(__dirname, "..", "..", "app", "review", "[slug]", "[token]", "actions.ts"), "utf-8");
    expect(source).not.toMatch(/\bredirect\s*\(/);
    expect(source).not.toContain('from "next/navigation"');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. No third-party requests
// ─────────────────────────────────────────────────────────────────────────
describe("5. No third-party requests from the review page", () => {
  it("rendering a real, fully-populated page never triggers an outbound fetch — the Session 1 network guard (installed globally for every test in this suite) would throw if it did", async () => {
    const facultyId = await seedFacultyReal("No Fetch, N.");
    const pubId = await seedPublicationReal("No Fetch Paper");
    await seedAuthorReal(pubId, facultyId, "No Fetch, N.", "chps_faculty");
    await seedAuthorReal(pubId, null, "No Fetch Coauthor, C.", "unknown", 1);
    const { token, slug } = await mintValidToken(facultyId);

    // No vi.stubGlobal("fetch", ...) here on purpose — this test relies on
    // the REAL global network guard tests/setup.ts installs for every file
    // in this suite (tests/helpers/http.ts::installNetworkGuard), which
    // throws immediately, naming the URL, on any unmocked fetch. A silent
    // pass here means zero fetch calls occurred; if the page (or anything it
    // imports) ever added an analytics pixel, an external font stylesheet,
    // or a CDN script, this test would start throwing.
    await expect(renderReviewPage(slug, token)).resolves.toContain("Review your publications");
  });

  it("source-level confirmation: no <script src>, no external stylesheet <link>, no fetch() call anywhere in the page or its direct components", () => {
    const pageSource = readFileSync(path.join(__dirname, "..", "..", "app", "review", "[slug]", "[token]", "page.tsx"), "utf-8");
    const formSource = readFileSync(path.join(__dirname, "..", "..", "app", "review", "[slug]", "[token]", "AddPublicationForm.tsx"), "utf-8");
    for (const source of [pageSource, formSource]) {
      expect(source).not.toMatch(/<script\b/);
      expect(source).not.toMatch(/<link\b/);
      expect(source).not.toMatch(/\bfetch\s*\(/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. No unescaped user-supplied content
// ─────────────────────────────────────────────────────────────────────────
describe("6. No unescaped user-supplied content", () => {
  it("a co-author name carrying a <script> + quote payload renders escaped, never as live markup, through the real page's dangerouslySetInnerHTML author-list surface", async () => {
    const facultyId = await seedFacultyReal("XSS Owner, X.");
    const pubId = await seedPublicationReal("XSS Test Paper");
    await seedAuthorReal(pubId, facultyId, "XSS Owner, X.", "chps_faculty", 0);
    const maliciousName = `<script>alert("stolen")</script>`;
    await seedAuthorReal(pubId, null, maliciousName, "unknown", 1);
    const { token, slug } = await mintValidToken(facultyId);

    const html = await renderReviewPage(slug, token);

    expect(html).not.toContain("<script>alert"); // never present as live markup
    expect(html).toContain("&lt;script&gt;"); // present, escaped — the name IS shown, just safely
    expect(html).toContain("&quot;stolen&quot;");
  });

  it("a submitted title carrying a <script> payload (React's own JSX-child auto-escaping, the OTHER rendering path on this page besides dangerouslySetInnerHTML) also never renders as live markup", async () => {
    const facultyId = await seedFacultyReal("XSS Title, X.");
    const maliciousTitle = `<img src=x onerror=alert(1)> My Actual Paper Title`;
    const pubId = await seedPublicationReal(maliciousTitle);
    await seedAuthorReal(pubId, facultyId, "XSS Title, X.", "chps_faculty");
    const { token, slug } = await mintValidToken(facultyId);

    const html = await renderReviewPage(slug, token);

    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("My Actual Paper Title"); // the benign part still renders
  });

  it("★ a very long title (Session 5: no payload size limit enforced on this path) still renders fully escaped, with no truncation-induced unescaped fragment", async () => {
    const facultyId = await seedFacultyReal("XSS Long, X.");
    const filler = "A".repeat(200_000);
    const maliciousLongTitle = `${filler}<script>alert(1)</script>${filler}`;
    const pubId = await seedPublicationReal(maliciousLongTitle);
    await seedAuthorReal(pubId, facultyId, "XSS Long, X.", "chps_faculty");
    const { token, slug } = await mintValidToken(facultyId);

    const html = await renderReviewPage(slug, token);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html.length).toBeGreaterThan(400_000); // the full, untruncated title round-tripped through rendering
  });
});
