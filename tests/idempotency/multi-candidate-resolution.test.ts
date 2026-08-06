// Phase 5 hardening, Session 3, items F and G. resolveByTitle's tiebreak
// mechanism (lib/crossref.ts): candidates = gate-passing items, in
// Crossref's own relevance-score order (no explicit sort= param);
// chosen = candidates.find(hasUcfAffiliation) ?? candidates[0]; then, only
// if chosen is a preprint, preferPublishedOverPreprint re-picks among the
// FULL raw item list (not just gate-passing candidates) for a non-preprint
// item sharing chosen's exact author order. This file exercises that
// mechanism with the real captured 2-candidate collision
// (tests/fixtures/api/crossref-title-search-preprint-vor-collision-lee-fatalism.json,
// the DOI 10.3390/curroncol32080461 / 10.20944/preprints202507.0230.v1 pair
// found by the empirical production replay, publications.id=113) plus two
// synthetic re-orderings never seen in production (F), and the genuinely
// uncovered shape — two non-preprint candidates — with no code changes (G).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.CROSSREF_MAILTO ??= "test@example.com";
const { resolveByTitle } = await import("../../lib/crossref");

const REAL_TITLE = "Evaluating Fatalism Among Breast Cancer Survivors in a Heterogeneous Hispanic Population: A Cross-Sectional Study";
const VOR_DOI = "10.3390/curroncol32080461";
const PREPRINT_DOI = "10.20944/preprints202507.0230.v1";

function fixtureJson(): { message: { items: unknown[] } } {
  return JSON.parse(
    readFileSync(path.join(__dirname, "..", "fixtures", "api", "crossref-title-search-preprint-vor-collision-lee-fatalism.json"), "utf-8")
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("F — multi-candidate resolution, the real production collision (publications.id=113)", () => {
  it("the affiliation tiebreak selects the VOR outright — preferPublishedOverPreprint never needs to fire", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(fixtureJson()));

    const result = await resolveByTitle(REAL_TITLE, 2025, "Lee");

    expect(result).not.toBeNull();
    expect(result!.doi).toBe(VOR_DOI);
    expect(result!.type).toBe("journal-article");
  });
});

// Two synthetic re-orderings of the SAME real author lists/titles, testing
// the two heuristic-interaction paths production has never actually hit:
// the tiebreak choosing a preprint (because IT happens to carry the
// affiliation data), and neither candidate carrying affiliation at all.
// Both must still land on the VOR — that's the whole point of
// preferPublishedOverPreprint existing.
const SHARED_AUTHORS_NO_AFFILIATION = [
  { given: "Liara", family: "Lopez Torralba" },
  { given: "Brian", family: "Sukhu" },
  { given: "Eunkyung", family: "Lee" },
];
const UCF_AFFILIATION = [{ name: "Department of Health Sciences, College of Health Professions and Sciences, University of Central Florida" }];

function withAffiliation(authors: typeof SHARED_AUTHORS_NO_AFFILIATION, affiliated: boolean) {
  return authors.map((a) => ({ ...a, affiliation: affiliated ? UCF_AFFILIATION : [] }));
}

function syntheticPreprint(opts: { doi: string; affiliated: boolean }) {
  return {
    DOI: opts.doi,
    title: [REAL_TITLE],
    type: "posted-content",
    author: withAffiliation(SHARED_AUTHORS_NO_AFFILIATION, opts.affiliated),
    "container-title": null,
    volume: null, issue: null, page: null,
    issued: { "date-parts": [[2025]] },
  };
}

function syntheticVor(opts: { doi: string; affiliated: boolean }) {
  return {
    DOI: opts.doi,
    title: [REAL_TITLE],
    type: "journal-article",
    author: withAffiliation(SHARED_AUTHORS_NO_AFFILIATION, opts.affiliated),
    "container-title": ["Current Oncology"],
    volume: "32", issue: "8", page: "461",
    issued: { "date-parts": [[2025]] },
  };
}

describe("F — two constructed orderings never seen in production, both must still resolve to the VOR", () => {
  it("the PREPRINT carries the affiliation data (tiebreak picks it) — preferPublishedOverPreprint must re-pick the VOR", async () => {
    const preprint = syntheticPreprint({ doi: PREPRINT_DOI, affiliated: true });
    const vor = syntheticVor({ doi: VOR_DOI, affiliated: false });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: { items: [preprint, vor] } }));

    const result = await resolveByTitle(REAL_TITLE, 2025, "Lee");

    expect(result).not.toBeNull();
    expect(result!.doi).toBe(VOR_DOI);
  });

  it("NEITHER candidate carries affiliation data — candidates[0] (the preprint, by item order) decides, and preferPublishedOverPreprint must re-pick the VOR", async () => {
    const preprint = syntheticPreprint({ doi: PREPRINT_DOI, affiliated: false });
    const vor = syntheticVor({ doi: VOR_DOI, affiliated: false });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: { items: [preprint, vor] } }));

    const result = await resolveByTitle(REAL_TITLE, 2025, "Lee");

    expect(result).not.toBeNull();
    expect(result!.doi).toBe(VOR_DOI);
  });
});

describe("G — the uncovered shape: two non-preprint candidates, both journal-article, both possibly UCF-affiliated. Current behavior only, no new logic added.", () => {
  it("both candidates carry a UCF affiliation — the tiebreak's .find() takes the FIRST one in Crossref's own relevance order; the second, equally-affiliated candidate is silently never considered", async () => {
    const first = syntheticVor({ doi: "10.1/first-in-relevance-order", affiliated: true });
    const second = syntheticVor({ doi: "10.1/second-in-relevance-order", affiliated: true });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: { items: [first, second] } }));

    const result = await resolveByTitle(REAL_TITLE, 2025, "Lee");

    // Current, unguarded behavior: whichever Crossref listed first wins.
    // Nothing in resolveByTitle distinguishes "the only UCF-affiliated
    // candidate" from "the first of several equally UCF-affiliated
    // candidates" — hasUcfAffiliation is a boolean predicate, not a ranking.
    expect(result!.doi).toBe("10.1/first-in-relevance-order");

    // Confirm it's genuinely position-sensitive, not something else about
    // "first" — swap the order and the answer flips.
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: { items: [second, first] } }));
    const swapped = await resolveByTitle(REAL_TITLE, 2025, "Lee");
    expect(swapped!.doi).toBe("10.1/second-in-relevance-order");
  });

  it("neither candidate carries affiliation data — candidates[0] (raw Crossref relevance order) decides, same as the single-preprint case, with no preprint re-pick to correct it this time (both are journal-article already)", async () => {
    const first = syntheticVor({ doi: "10.1/first-no-affiliation", affiliated: false });
    const second = syntheticVor({ doi: "10.1/second-no-affiliation", affiliated: false });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: { items: [first, second] } }));

    const result = await resolveByTitle(REAL_TITLE, 2025, "Lee");

    expect(result!.doi).toBe("10.1/first-no-affiliation");
  });
});
