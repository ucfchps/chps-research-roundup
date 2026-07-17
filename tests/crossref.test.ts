// Drives most cases from tests/fixtures/crossref-cases.json — real, hand-captured
// Crossref responses (tests/fixtures/crossref/*.json) checked against the live
// reference roundup post. See master plan §5 (Layer 2), §5a rules 6-8, §7, §13
// item 7, §15.2/15.7/15.8, and the Session 6 prompt. Adding a case is a data
// edit to crossref-cases.json, not a code edit — except case 7, which is
// informational only (§15.8, as amended) and deliberately has no hard
// pass/fail assertion here.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lib/crossref.ts validates CROSSREF_MAILTO at import time (like lib/db.ts
// validates Turso vars) — set it before the dynamic import, same reason
// scripts/check-ai.ts imports lib/ai.ts dynamically after config().
process.env.CROSSREF_MAILTO ??= "test@example.com";

const { resolveByTitle, resolveByDoi, formatCrossrefAuthorName, isUcfAffiliation, CrossrefUnavailableError } =
  await import("../lib/crossref");
const { formatCitation } = await import("../lib/citation");

function fixtureJson(relPath: string): unknown {
  return JSON.parse(readFileSync(path.join(__dirname, "fixtures", relPath), "utf-8"));
}

interface Case {
  id: number;
  label: string;
  fixture: string;
  input: { title: string; year?: number; surnameHint?: string };
  expect: "resolve" | "null";
  expected_doi: string | null;
  reject_doi?: string;
  test_status?: string;
}

const cases = fixtureJson("crossref-cases.json") as Case[];

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

// Ground truth pulled by hand from the same real curl captures cited in
// crossref-cases.json's notes — see the Session 6 discrepancy report for
// anything that disagrees with the live post itself.
const EXPECTED_METADATA: Record<
  number,
  { journal: string | null; volume: string | null; issue: string | null; pages: string | null }
> = {
  1: { journal: "Journal of Speech, Language, and Hearing Research", volume: "68", issue: "4", pages: "1743-1757" },
  3: { journal: "Health Education Journal", volume: "84", issue: "5", pages: "558-573" },
  4: { journal: "Families in Society: The Journal of Contemporary Social Services", volume: null, issue: null, pages: null },
  5: { journal: "Journal of Substance Use", volume: "31", issue: "1", pages: "82-90" },
  6: { journal: "International Journal of Developmental Disabilities", volume: null, issue: null, pages: "1-10" },
  8: { journal: "The Laryngoscope", volume: "135", issue: "12", pages: "4830-4839" },
  9: { journal: "Medical Education", volume: "59", issue: "6", pages: "660-661" },
  10: { journal: "Journal of Voice", volume: null, issue: null, pages: null },
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// A synthetic Crossref search-result item, for the edge cases the ten real
// fixtures don't happen to exercise (year gating, missing surname, etc).
function syntheticItem(opts: {
  title?: string;
  doi?: string;
  type?: string;
  year?: number;
  authorFamilies?: string[] | null;
  containerTitle?: string | null;
  shortContainerTitle?: string | null;
  volume?: string | null;
  issue?: string | null;
  page?: string | null;
}) {
  const families = opts.authorFamilies === undefined ? ["Doe"] : opts.authorFamilies;
  return {
    DOI: opts.doi ?? "10.9999/synthetic",
    title: [opts.title ?? "Untitled Synthetic Item"],
    type: opts.type ?? "journal-article",
    author: families
      ? families.map((family, i) => ({
          given: i === 0 ? "Jane" : "X.",
          family,
          sequence: i === 0 ? "first" : "additional",
          affiliation: [],
        }))
      : undefined,
    "container-title": opts.containerTitle === undefined ? ["Test Journal"] : opts.containerTitle ? [opts.containerTitle] : null,
    "short-container-title":
      opts.shortContainerTitle === undefined ? null : opts.shortContainerTitle ? [opts.shortContainerTitle] : null,
    volume: opts.volume ?? null,
    issue: opts.issue ?? null,
    page: opts.page ?? null,
    issued: opts.year !== undefined ? { "date-parts": [[opts.year]] } : null,
  };
}

function syntheticSearch(items: unknown[]) {
  return { message: { items } };
}

describe("resolveByTitle — fixture-driven ground truth", () => {
  for (const c of cases) {
    if (c.test_status === "informational") continue;

    it(`case ${c.id}: ${c.label}`, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(fixtureJson(c.fixture)));

      const result = await resolveByTitle(c.input.title, c.input.year, c.input.surnameHint);

      if (c.expect === "null") {
        expect(result).toBeNull();
        return;
      }

      expect(result).not.toBeNull();
      expect(result!.doi).toBe(c.expected_doi);
      if (c.reject_doi) expect(result!.doi).not.toBe(c.reject_doi);

      const expected = EXPECTED_METADATA[c.id];
      if (expected) {
        expect(result!.journal).toBe(expected.journal);
        expect(result!.volume).toBe(expected.volume);
        expect(result!.issue).toBe(expected.issue);
        expect(result!.pages).toBe(expected.pages);
      }
    });
  }

  // ★ Case 7 — informational only (§15.8, as amended). The live post's own
  // hand-typed title wording genuinely differs from Crossref's registered
  // title ("compared to" vs "and"). Whether the gate accepts or rejects this
  // is implementation-dependent and NOT a bug either way — log the outcome,
  // don't assert it.
  it("case 7 (Anderson/Hanney) — logs the outcome, asserts nothing", async () => {
    const case7 = cases.find((c) => c.id === 7)!;
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(fixtureJson(case7.fixture)));

    const result = await resolveByTitle(case7.input.title, case7.input.year, case7.input.surnameHint);

    console.log(
      `[Session 6 discrepancy report] case 7 (Anderson/Hanney): resolveByTitle ${
        result ? `resolved to DOI ${result.doi}` : "returned null"
      } for the live post's own title wording.`
    );
  });
});

describe("resolveByTitle — the acceptance gate", () => {
  it("case 10 (Awan): author order is preserved exactly as Crossref returned it", async () => {
    const c = cases.find((cc) => cc.id === 10)!;
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(fixtureJson(c.fixture)));

    const result = await resolveByTitle(c.input.title, c.input.year, c.input.surnameHint);

    expect(result!.authors.map((a) => a.name)).toEqual([
      "Awan, S.N.",
      "Park, Y.",
      "Anand, S.",
      "Shrivastav, R.",
      "Eddins, D.A.",
    ]);
  });

  it("rejects the 'Key Study Documents' high-rank wrong-title hit with no author key at all, without throwing", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(fixtureJson("crossref/01-stock-limb-disuse.json")));

    const result = await resolveByTitle(
      "Limb Disuse Trials in Humans: Key Insights on Study Design, Ethics, and Project Execution",
      2026,
      "Stock"
    );

    expect(result).not.toBeNull();
    expect(result!.doi).toBe("10.1249/jes.0000000000000392");
  });

  it("the ahead-of-print Stock record resolves with volume/issue/pages all null, and formatCitation degrades cleanly", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(fixtureJson("crossref/01-stock-limb-disuse.json")));

    const result = await resolveByTitle(
      "Limb Disuse Trials in Humans: Key Insights on Study Design, Ethics, and Project Execution",
      2026,
      "Stock"
    );

    expect(result!.volume).toBeNull();
    expect(result!.issue).toBeNull();
    expect(result!.pages).toBeNull();

    const publication = {
      id: 0,
      doi: result!.doi,
      title: result!.title,
      title_normalized: "",
      url: result!.url,
      journal: result!.journal,
      year: result!.year,
      volume: result!.volume,
      issue: result!.issue,
      pages: result!.pages,
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
    const authors = result!.authors.map((a, i) => ({
      id: i,
      publication_id: 0,
      faculty_id: null,
      name: a.name,
      role: "unknown" as const,
      role_set_by: null,
      role_set_at: null,
      position: a.position,
    }));

    const html = formatCitation(publication, authors);
    expect(html).not.toMatch(/,\s*\(/);
    expect(html).not.toContain(", .");
    expect(html).toContain("<em>Exercise and Sport Sciences Reviews</em>.");
  });

  it("a candidate whose year is off by 2 is rejected", async () => {
    const item = syntheticItem({ title: "A Totally Unique Test Title For Year Gating", year: 2023, authorFamilies: ["Smith"] });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(syntheticSearch([item])));

    const result = await resolveByTitle("A Totally Unique Test Title For Year Gating", 2025, "Smith");

    expect(result).toBeNull();
  });

  it("a candidate whose year is off by 1 is accepted", async () => {
    const item = syntheticItem({ title: "A Totally Unique Test Title For Year Gating", year: 2024, authorFamilies: ["Smith"] });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(syntheticSearch([item])));

    const result = await resolveByTitle("A Totally Unique Test Title For Year Gating", 2025, "Smith");

    expect(result).not.toBeNull();
  });

  it("surnameHint absent from the author list is rejected (common-surname false positive)", async () => {
    const item = syntheticItem({ title: "A Totally Unique Test Title For Surname Gating", year: 2025, authorFamilies: ["Nguyen"] });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(syntheticSearch([item])));

    const result = await resolveByTitle("A Totally Unique Test Title For Surname Gating", 2025, "Smith");

    expect(result).toBeNull();
  });

  it("a candidate with an absent author key fails the surnameHint check (not merely an empty list)", async () => {
    const item = syntheticItem({
      title: "A Totally Unique Test Title For No Author Key",
      year: 2025,
      authorFamilies: null,
    });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(syntheticSearch([item])));

    const result = await resolveByTitle("A Totally Unique Test Title For No Author Key", 2025, "Smith");

    expect(result).toBeNull();
  });

  it("uses short-container-title when container-title is absent", async () => {
    const item = syntheticItem({
      title: "Short Container Title Test",
      containerTitle: null,
      shortContainerTitle: "Short J.",
    });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(syntheticSearch([item])));

    const result = await resolveByTitle("Short Container Title Test");

    expect(result!.journal).toBe("Short J.");
  });

  it.each([
    [[2024], 2024],
    [[2003, 12], 2003],
    [[2026, 7, 2], 2026],
  ])("issued.date-parts %j yields year %d", async (dateParts, expectedYear) => {
    const item = syntheticItem({ title: "Date Parts Variability Test" });
    (item as { issued: unknown }).issued = { "date-parts": [dateParts] };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(syntheticSearch([item])));

    const result = await resolveByTitle("Date Parts Variability Test");

    expect(result!.year).toBe(expectedYear);
  });

  it("a preprint with no published counterpart among the results is still accepted and returned as-is", async () => {
    const preprint = syntheticItem({
      title: "Lonely Preprint Test Title",
      type: "posted-content",
      doi: "10.9999/lonely-preprint",
      authorFamilies: ["Alpha", "Beta"],
      containerTitle: null,
    });
    const unrelated = syntheticItem({
      title: "Something Completely Different",
      type: "journal-article",
      doi: "10.9999/unrelated",
      authorFamilies: ["Gamma"],
    });

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(syntheticSearch([preprint, unrelated])));

    const result = await resolveByTitle("Lonely Preprint Test Title");

    expect(result).not.toBeNull();
    expect(result!.doi).toBe("10.9999/lonely-preprint");
    expect(result!.type).toBe("posted-content");
  });

  it("includes mailto and a descriptive User-Agent for Crossref's polite pool", async () => {
    const item = syntheticItem({ title: "Etiquette Test Title" });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(syntheticSearch([item])));

    await resolveByTitle("Etiquette Test Title");

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("mailto=");
    const headers = new Headers(init.headers);
    expect(headers.get("User-Agent")).toContain("test@example.com");
  });
});

describe("resolveByTitle — distinguishing 'not found' from 'Crossref is down'", () => {
  it("the gray-literature case returns null, asserted as null, not a thrown error", async () => {
    const c = cases.find((cc) => cc.id === 2)!;
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(fixtureJson(c.fixture)));

    await expect(resolveByTitle(c.input.title, c.input.year, c.input.surnameHint)).resolves.toBeNull();
  });

  it("throws CrossrefUnavailableError on a 500 (never returns null)", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("server error", { status: 500 }));

    await expect(resolveByTitle("Anything")).rejects.toBeInstanceOf(CrossrefUnavailableError);
  });

  it("throws CrossrefUnavailableError on a 429 past the retry budget (never returns null)", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}, 429, { "retry-after": "0" }));

    await expect(resolveByTitle("Anything")).rejects.toBeInstanceOf(CrossrefUnavailableError);
  });

  it("a 429 followed by a 200 succeeds after retry", async () => {
    const item = syntheticItem({ title: "Retry Success Title" });
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(jsonResponse(syntheticSearch([item])));

    const result = await resolveByTitle("Retry Success Title");

    expect(result).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("resolveByDoi", () => {
  function singleWorkResponse(item: unknown) {
    return { message: item };
  }

  it("resolves a DOI directly, with no acceptance gate", async () => {
    const item = syntheticItem({ title: "Direct Doi Test", doi: "10.5555/direct" });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(singleWorkResponse(item)));

    const result = await resolveByDoi("10.5555/direct");

    expect(result!.doi).toBe("10.5555/direct");
    expect(result!.title).toBe("Direct Doi Test");
  });

  it("returns null on a 404 (DOI not registered) rather than throwing", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const result = await resolveByDoi("10.5555/nonexistent");

    expect(result).toBeNull();
  });

  it("throws CrossrefUnavailableError on a 500", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("server error", { status: 500 }));

    await expect(resolveByDoi("10.5555/whatever")).rejects.toBeInstanceOf(CrossrefUnavailableError);
  });

  it("normalizes DOI casing/prefix so both forms resolve to the same result", async () => {
    const item = syntheticItem({ title: "Doi Case Test", doi: "10.1234/abc" });
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(singleWorkResponse(item)))
      .mockResolvedValueOnce(jsonResponse(singleWorkResponse(item)));

    const a = await resolveByDoi("HTTPS://DOI.ORG/10.1234/ABC");
    const b = await resolveByDoi("10.1234/abc");

    expect(a!.doi).toBe("10.1234/abc");
    expect(b!.doi).toBe("10.1234/abc");
  });
});

describe("formatCrossrefAuthorName", () => {
  it("the ordinary case: Matt S. Stock -> Stock, M.S.", () => {
    expect(formatCrossrefAuthorName({ given: "Matt S.", family: "Stock" })).toBe("Stock, M.S.");
  });

  it("initials already compressed, no spaces: Harry C.S. Wingfield -> Wingfield, H.C.S.", () => {
    expect(formatCrossrefAuthorName({ given: "Harry C.S.", family: "Wingfield" })).toBe("Wingfield, H.C.S.");
  });

  it("lowercase particle is never capitalized: Luc J.C. van Loon -> van Loon, L.J.C.", () => {
    expect(formatCrossrefAuthorName({ given: "Luc J.C.", family: "van Loon" })).toBe("van Loon, L.J.C.");
  });

  it("hyphenated surname stays intact: Lori Ploutz-Snyder -> Ploutz-Snyder, L.", () => {
    expect(formatCrossrefAuthorName({ given: "Lori", family: "Ploutz-Snyder" })).toBe("Ploutz-Snyder, L.");
  });

  it("hyphenated given name -> both initials: Jean-Paul -> ..., J.-P.", () => {
    expect(formatCrossrefAuthorName({ given: "Jean-Paul", family: "Sartre" })).toBe("Sartre, J.-P.");
  });

  it("organizational author (name, no family/given) is verbatim", () => {
    expect(formatCrossrefAuthorName({ name: "World Health Organization" })).toBe("World Health Organization");
  });

  it("an entry with neither family, given, nor name is skipped, never stringified as 'undefined'", () => {
    expect(formatCrossrefAuthorName({})).toBeNull();
  });
});

describe("isUcfAffiliation", () => {
  it("matches the fully spelled-out form", () => {
    expect(isUcfAffiliation("University of Central Florida, Orlando, FL, USA")).toBe(true);
  });

  // The exact string that slipped through on the real Zraick ingest-crossref
  // run (§9) before this fix — a genuine UCF affiliation flagged as
  // "unconfirmed" purely because the regex required "university" spelled out.
  it("matches 'Univ. of Central Florida' (the real string that missed before this fix)", () => {
    expect(isUcfAffiliation("Univ. of Central Florida")).toBe(true);
  });

  it("matches 'Univ of Central Florida' (no period)", () => {
    expect(isUcfAffiliation("Univ of Central Florida")).toBe(true);
  });

  it("matches 'U. of Central Florida'", () => {
    expect(isUcfAffiliation("U. of Central Florida")).toBe(true);
  });

  it("matches a bare 'UCF'", () => {
    expect(isUcfAffiliation("UCF, Orlando, FL")).toBe(true);
  });

  // Real strings observed this session (full-roster dry-run) — embedded in a
  // longer department/lab string, not at the start.
  it("matches when embedded mid-string, e.g. 'Commun. Sci. and Disord., Univ. of Central Florida, Orlando, FL'", () => {
    expect(isUcfAffiliation("Commun. Sci. and Disord., Univ. of Central Florida, Orlando, FL")).toBe(true);
  });

  it("does not match 'University of Florida' (a real, different institution seen this session — no 'Central')", () => {
    expect(isUcfAffiliation("University of Florida")).toBe(false);
  });

  it("does not match 'University of North Florida' or 'University of South Florida'", () => {
    expect(isUcfAffiliation("University of North Florida")).toBe(false);
    expect(isUcfAffiliation("University of South Florida")).toBe(false);
  });

  it("does not match null, undefined, or an empty string", () => {
    expect(isUcfAffiliation(null)).toBe(false);
    expect(isUcfAffiliation(undefined)).toBe(false);
    expect(isUcfAffiliation("")).toBe(false);
  });
});
