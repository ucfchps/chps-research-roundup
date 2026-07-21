// Ground truth: docs/wp-directory-notes.md §9 — ORCID is stored as a full URL,
// and the final character of a real ORCID iD can be the checksum digit "X".
// getOrcidWorks/parseOrcidGroups ground truth: tests/fixtures/orcid/sample-works.json
// (§13 item 10 — real pub.orcid.org/v3.0/{id}/works pulls for two CHPS faculty).
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrcidWorks, orcidId, parseOrcidGroups } from "../lib/orcid";
import sampleWorks from "./fixtures/orcid/sample-works.json";

const groups = sampleWorks.group as unknown as Parameters<typeof parseOrcidGroups>[0];
// Fixture cases are indexed by their _case field, in file order:
// 0: in-window journal-article, DOI present
// 1: DUPLICATE work-summaries, same DOI (dedup case)
// 2: in-window preprint, DOI present, journal-title null
// 3: type=annotation, DOI-bearing, published (real edge case)
// 4: DOI-absent (wosuid only), year 2017 — well outside any window
// 5: DOI-absent (pmid only), year bumped to 2026 — in-window

describe("orcidId — named sample records from §10", () => {
  it.each([
    ["Michael J. Rovito", "https://orcid.org/0000-0001-8086-3460", "0000-0001-8086-3460"],
    ["Matt S. Stock", "https://orcid.org/0000-0003-1156-1084", "0000-0003-1156-1084"],
    ["L. Colby Mangum", "https://orcid.org/0000-0001-6443-2951", "0000-0001-6443-2951"],
    ["Kimberley Gryglewicz", "https://orcid.org/0000-0003-4395-2354", "0000-0003-4395-2354"],
    ["A’Naja Newsome", "https://orcid.org/0000-0002-4916-0705", "0000-0002-4916-0705"],
    ["Ethan Hill", "https://orcid.org/0000-0002-5573-3370", "0000-0002-5573-3370"],
    ["Shellene Mazany", "https://orcid.org/0009-0004-6362-4256", "0009-0004-6362-4256"],
  ])("%s -> %s", (_name, url, expected) => {
    expect(orcidId(url)).toBe(expected);
  });
});

describe("orcidId — the trailing checksum digit can be X", () => {
  it("does not truncate an iD ending in X", () => {
    expect(orcidId("https://orcid.org/0000-0002-1825-009X")).toBe("0000-0002-1825-009X");
  });

  it("accepts the www. host variant", () => {
    expect(orcidId("https://www.orcid.org/0000-0002-1825-009X")).toBe("0000-0002-1825-009X");
  });
});

describe("orcidId — never throws", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["not a URL at all", "not a url"],
    ["wrong host", "https://scholar.google.com/citations?user=abc123"],
    ["orcid.org with no iD in the path", "https://orcid.org/"],
  ])("%s -> null", (_label, input) => {
    expect(() => orcidId(input as string | null | undefined)).not.toThrow();
    expect(orcidId(input as string | null | undefined)).toBeNull();
  });
});

// now=2026-07-21, lookbackYears=3 -> cutoff year 2024 (currentYear - lookbackYears + 1),
// inclusive: {2024, 2025, 2026} are in-window.
const NOW = new Date("2026-07-21T00:00:00Z");

describe("parseOrcidGroups — real fixture, group-level iteration", () => {
  it("dedupes a group with two work-summary entries asserting the same DOI to exactly one candidate", () => {
    const { works } = parseOrcidGroups(groups, { lookbackYears: 3, now: NOW });
    const matches = works.filter((w) => w.doi === "10.3390/jfmk11020200");
    expect(matches).toHaveLength(1);
  });

  it("a group whose only type is 'annotation' is still processed — type is not used as an allowlist", () => {
    const { works } = parseOrcidGroups(groups, { lookbackYears: 3, now: NOW });
    const annotation = works.find((w) => w.doi === "10.14434/josotl.v24i2.35196");
    expect(annotation).toMatchObject({
      title: "Changing Attitudes Towards Research Through a Course-based Undergraduate Research Experience",
      year: 2024,
    });
  });

  it("a group published outside the lookback window is skipped and counted, not silently dropped", () => {
    // The wosuid-only 2017 case — 9 years before "now" under any reasonable
    // lookback definition.
    const { works, skippedOutOfWindow } = parseOrcidGroups(groups, { lookbackYears: 3, now: NOW });
    expect(works.find((w) => w.title.startsWith("Vastus Lateralis"))).toBeUndefined();
    expect(skippedOutOfWindow).toBeGreaterThanOrEqual(1);
  });

  it("extracts title/year/doi/journal/url for the common in-window, single-summary, DOI-present case", () => {
    const { works } = parseOrcidGroups(groups, { lookbackYears: 3, now: NOW });
    const common = works.find((w) => w.doi === "10.1123/jsr.2024-0440");
    expect(common).toEqual({
      title: "Development and Reliability of 2 Visual-Cognitive Dual-Task Agility Assessments for Return to Sport",
      year: 2026,
      doi: "10.1123/jsr.2024-0440",
      journal: "Journal of Sport Rehabilitation",
      url: "https://doi.org/10.1123/jsr.2024-0440",
    });
  });

  it("carries the work-summary's own url (publications.url is NOT NULL, and a needs_metadata ORCID stub has no other source for one)", () => {
    const { works } = parseOrcidGroups(groups, { lookbackYears: 3, now: NOW });
    const noDoi = works.find((w) => w.title.startsWith("We Don't Know our Own Strength"));
    expect(noDoi?.url).toBe("https://doi.org/10.1093/ptj/pzab204");
  });

  it("a preprint with a null journal-title resolves with journal: null (Crossref/title resolution fills it in downstream, not ORCID)", () => {
    const { works } = parseOrcidGroups(groups, { lookbackYears: 3, now: NOW });
    const preprint = works.find((w) => w.doi === "10.1101/2025.10.12.25337781");
    expect(preprint).toMatchObject({ journal: null, year: 2025 });
  });

  it("a group with no DOI at all (only a non-doi external-id) yields doi: null, for the title-fallback resolution path", () => {
    const { works } = parseOrcidGroups(groups, { lookbackYears: 3, now: NOW });
    const noDoi = works.find((w) => w.title.startsWith("We Don't Know our Own Strength"));
    expect(noDoi).toMatchObject({ doi: null, year: 2026 });
  });

  it("a group missing publication-date.year entirely is skipped and counted (fail closed)", () => {
    const noYear = [
      {
        "external-ids": { "external-id": [{ "external-id-type": "doi", "external-id-value": "10.1/no-year" }] },
        "work-summary": [{ type: "journal-article", title: { title: { value: "No Year Paper" } }, url: { value: "https://doi.org/10.1/no-year" }, "publication-date": null }],
      },
    ] as unknown as Parameters<typeof parseOrcidGroups>[0];

    const { works, skippedMissingYear } = parseOrcidGroups(noYear, { lookbackYears: 3, now: NOW });
    expect(works).toEqual([]);
    expect(skippedMissingYear).toBe(1);
  });

  it("a denylisted type (e.g. data-set) is excluded", () => {
    const dataset = [
      {
        "external-ids": { "external-id": [{ "external-id-type": "doi", "external-id-value": "10.1/a-dataset" }] },
        "work-summary": [{ type: "data-set", title: { title: { value: "Some Dataset" } }, "publication-date": { year: { value: "2026" } } }],
      },
    ] as unknown as Parameters<typeof parseOrcidGroups>[0];

    const { works } = parseOrcidGroups(dataset, { lookbackYears: 3, now: NOW });
    expect(works).toEqual([]);
  });

  it("never throws on a malformed group (no work-summary at all) — skips and counts it", () => {
    const malformed = [{ "external-ids": {}, "work-summary": [] }] as unknown as Parameters<typeof parseOrcidGroups>[0];
    expect(() => parseOrcidGroups(malformed, { lookbackYears: 3, now: NOW })).not.toThrow();
    const { works, skippedMalformed } = parseOrcidGroups(malformed, { lookbackYears: 3, now: NOW });
    expect(works).toEqual([]);
    expect(skippedMalformed).toBe(1);
  });
});

describe("getOrcidWorks — network layer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches https://pub.orcid.org/v3.0/{orcidId}/works with an Accept: application/json header, and returns the parsed, in-window works", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ group: groups }), { status: 200 }))
    );

    const works = await getOrcidWorks("0000-0003-1156-1084");

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://pub.orcid.org/v3.0/0000-0003-1156-1084/works");
    expect((init.headers as Record<string, string>).Accept).toBe("application/json");
    expect(works.some((w) => w.doi === "10.1123/jsr.2024-0440")).toBe(true);
  });

  it("throws OrcidUnavailableError on a non-OK, non-retryable response", async () => {
    // 400, not 5xx/429 — fetchWithRetry doesn't retry it, so this fails fast
    // (a 5xx case would exhaust the real retry backoff, ~seconds, like
    // tests/ingest-crossref.test.ts's own retry-exhaustion case).
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })));
    await expect(getOrcidWorks("0000-0003-1156-1084")).rejects.toThrow(/ORCID/);
  });
});
