// Ground truth: docs/scholar-alert-notes.md (all sections) and every fixture in
// tests/fixtures/scholar-alerts/. See master plan §5a. No network — pure parser.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// lib/scholar-alert.ts imports lib/ai.ts (for the AI fallback), which imports
// lib/db.ts, which throws at module load without real Turso credentials.
// Same pattern as tests/ai.test.ts — mock the db module so this file stays a
// pure, no-network unit test regardless of environment.
const executeMock = vi.fn();
vi.mock("../lib/db", () => ({
  execute: (...args: unknown[]) => executeMock(...args),
}));

import { parseAlertEmail } from "../lib/scholar-alert";

function fixtureHtml(name: string): string {
  return readFileSync(path.join(__dirname, "fixtures", "scholar-alerts", `${name}.decoded.html`), "utf-8");
}

describe("parseAlertEmail — real fixtures", () => {
  it("alert-multi-real-vanryckeghem-citations: all 4 articles, own title+year each, not 1 and not a CSS-inflated count", () => {
    const result = parseAlertEmail(
      fixtureHtml("alert-multi-real-vanryckeghem-citations"),
      "Martine Vanryckeghem - new articles"
    );

    if (result.kind !== "articles") throw new Error(`expected articles, got ${JSON.stringify(result)}`);
    expect(result.scholarUserId).toBe("qK9t_4EAAAAJ");
    expect(result.displayName).toBe("Martine Vanryckeghem");
    expect(result.articles).toHaveLength(4);
    expect(result.articles.map((a) => a.title)).toEqual([
      "Behavior Assessment Battery for Children and Adolescents who Stutter",
      "Behavior Assessment Battery voor Kinderen en Jongeren die Stotteren",
      "Behavior Assessment Battery for Adults who Stutter",
      "KiddyCAT: Communication Attitude Test for French Preschoolers who Stutter. Hogrefe, France",
    ]);
    expect(result.articles.map((a) => a.year)).toEqual([2026, 2026, 2025, 2025]);
  });

  it("the two deliberately near-duplicate titles in that fixture stay as separate entries — no collapsing at this layer", () => {
    const result = parseAlertEmail(
      fixtureHtml("alert-multi-real-vanryckeghem-citations"),
      "Martine Vanryckeghem - new articles"
    );
    if (result.kind !== "articles") throw new Error("expected articles");

    const titles = result.articles.map((a) => a.title);
    expect(new Set(titles).size).toBe(4); // all 4 distinct, none merged
  });

  it("pair-citation-tag-schellhase: [CITATION]-tagged, no-snippet template parses successfully", () => {
    const result = parseAlertEmail(fixtureHtml("pair-citation-tag-schellhase"), "Kristen Couper Schellhase - new articles");

    if (result.kind !== "articles") throw new Error(`expected articles, got ${JSON.stringify(result)}`);
    expect(result.scholarUserId).toBe("ez1ilMIAAAAJ");
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].title).toBe(
      "Exploring Job Satisfaction and Intention to Leave Among Athletic Trainers Working With Tactical Athletes in Military Clinical Practice Settings"
    );
    expect(result.articles[0].year).toBe(2026);
    expect(result.articles[0].snippet).toBeNull();
  });

  it("pair-normal-tag-mangum: normal-tagged variant of the SAME underlying paper parses successfully, with a snippet", () => {
    const result = parseAlertEmail(fixtureHtml("pair-normal-tag-mangum"), "L. Colby Mangum, PhD, ATC - new articles");

    if (result.kind !== "articles") throw new Error(`expected articles, got ${JSON.stringify(result)}`);
    expect(result.scholarUserId).toBe("5yIzMuQAAAAJ");
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].title).toBe(
      "Exploring Job Satisfaction and Intention to Leave Among Athletic Trainers Working With Tactical Athletes in Military Clinical Practice Settings"
    );
    expect(result.articles[0].snippet).not.toBeNull();
  });

  it.each([
    ["alert-single-hanney-olecranon", "WfdV37IAAAAJ"],
    ["alert-single-stock-limbdisuse", "hs_VC0kAAAAJ"],
    ["alert-single-fukuda-bioimpedance", "xHh28EYAAAAJ"],
    ["alert-single-norte-acl", "z_Rs1EcAAAAJ"],
    ["alert-single-backes-polyvictimization", "AnyUZ0MAAAAJ"],
    ["alert-nonlatin-title-stout", "UKQpz6UAAAAJ"],
  ])("%s: footer href yields the correct case-sensitive Scholar user ID", (fixture, expectedId) => {
    const result = parseAlertEmail(fixtureHtml(fixture), "irrelevant for this assertion - new articles");
    if (result.kind !== "articles") throw new Error(`expected articles, got ${JSON.stringify(result)}`);
    expect(result.scholarUserId).toBe(expectedId);
  });

  it("alert-nonlatin-title-stout: non-Latin title passed through verbatim, not transliterated", () => {
    const result = parseAlertEmail(fixtureHtml("alert-nonlatin-title-stout"), "Jeffrey R Stout - new articles");
    if (result.kind !== "articles") throw new Error("expected articles");
    expect(result.articles[0].title).toBe("痛みの定量化: 運動科学における疼痛評価の方法論的レビュー");
    expect(result.articles[0].year).toBe(2026);
  });

  it("alert-multi-synthetic: 2 articles, real + hand-built", () => {
    const result = parseAlertEmail(fixtureHtml("alert-multi-synthetic"), "William J. Hanney - new articles");
    if (result.kind !== "articles") throw new Error("expected articles");
    expect(result.articles).toHaveLength(2);
    expect(result.articles[1].title).toContain("[SYNTHETIC FIXTURE]");
  });
});

describe("parseAlertEmail — rejection rules (§5a.2, §15.8)", () => {
  it("no HTML part is never reached by this function — extractHtmlBody (lib/gmail.ts) returns null upstream, and the caller skips before calling parseAlertEmail", () => {
    // Documented here rather than tested here: parseAlertEmail's contract starts
    // from an already-extracted HTML string. See tests/gmail.test.ts for the
    // "no HTML part -> null" case this depends on.
    expect(true).toBe(true);
  });

  it("★ synthetic citation-alert-shaped footer (no real example exists in this inbox — confirmed in docs/scholar-alert-notes.md §9) is rejected", () => {
    const html = `<html><body>
      <h3><a class="gse_alrt_title" href="https://example.org/some-article">Some Citing Paper</a></h3>
      <div style="color:#006621">A Stranger, B Someone - Some Journal, 2026</div>
      <p>This message was sent by Google Scholar because new citations to articles by
      <a href="https://scholar.google.com/citations?hl=en&user=hs_VC0kAAAAJ">Matt S. Stock</a> were found.</p>
    </body></html>`;

    const result = parseAlertEmail(html, "Matt S. Stock - new citations");

    expect(result).toEqual({
      kind: "rejected",
      reason: "citation_alert",
      detail: expect.any(String),
    });
  });

  it("no footer at all is rejected as no_footer", () => {
    const html = `<html><body>
      <h3><a class="gse_alrt_title" href="https://example.org/a">A Paper</a></h3>
      <div style="color:#006621">Author - Journal, 2026</div>
    </body></html>`;

    const result = parseAlertEmail(html, "Someone - new articles");

    expect(result).toEqual({ kind: "rejected", reason: "no_footer", detail: expect.any(String) });
  });

  it("a footer whose link has no user param is rejected as no_scholar_id, never falls back to the subject-line name", () => {
    const html = `<html><body>
      <h3><a class="gse_alrt_title" href="https://example.org/a">A Paper</a></h3>
      <div style="color:#006621">Author - Journal, 2026</div>
      <p>This message was sent by Google Scholar because you're following new articles written by
      <a href="https://scholar.google.com/citations?hl=en">Someone Ambiguous</a>.</p>
    </body></html>`;

    const result = parseAlertEmail(html, "Someone Ambiguous - new articles");

    expect(result).toEqual({ kind: "rejected", reason: "no_scholar_id", detail: expect.any(String) });
  });

  it("a valid footer with zero article blocks is rejected as no_articles", () => {
    const html = `<html><body>
      <p>This message was sent by Google Scholar because you're following new articles written by
      <a href="https://scholar.google.com/citations?hl=en&user=hs_VC0kAAAAJ">Matt S. Stock</a>.</p>
    </body></html>`;

    const result = parseAlertEmail(html, "Matt S. Stock - new articles");

    expect(result).toEqual({ kind: "rejected", reason: "no_articles", detail: expect.any(String) });
  });
});

describe("parseAlertEmail — the parser exposes no author-list or journal field (§5a.6, §15.7)", () => {
  it("ParsedArticle has exactly title, year, scholarUrl, snippet — a future edit that adds authors/journal fails this", () => {
    const result = parseAlertEmail(fixtureHtml("alert-single-hanney-olecranon"), "William J. Hanney - new articles");
    if (result.kind !== "articles") throw new Error("expected articles");

    const keys = Object.keys(result.articles[0]).sort();
    expect(keys).toEqual(["scholarUrl", "snippet", "title", "year"]);
  });
});

describe("parseAlertEmailWithAiFallback — only reached when deterministic extraction finds zero articles", () => {
  it("degrades to the original rejection when AI is unavailable, never guesses", async () => {
    process.env.AI_PROVIDER = "groq";
    process.env.AI_MODEL = "openai/gpt-oss-120b";
    delete process.env.GROQ_API_KEY; // forces AIUnavailableError

    const html = `<html><body>
      <p>This message was sent by Google Scholar because you're following new articles written by
      <a href="https://scholar.google.com/citations?hl=en&user=hs_VC0kAAAAJ">Matt S. Stock</a>.</p>
    </body></html>`;

    const { parseAlertEmailWithAiFallback } = await import("../lib/scholar-alert");
    const result = await parseAlertEmailWithAiFallback(html, "Matt S. Stock - new articles");

    expect(result).toEqual({ kind: "rejected", reason: "no_articles", detail: expect.any(String) });
  });
});
