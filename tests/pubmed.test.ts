// Ground truth: tests/fixtures/pubmed/sample-summaries.json — real
// eutils.ncbi.nlm.nih.gov esummary pulls for three actual CHPS publications
// (§5 Layer 3, §13 item 10). See also lib/names.ts's toPubmedQueryName /
// fromPubmedAuthorName, tested in tests/names.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPubmedAuthorQuery,
  extractAffiliationsFromXml,
  formatPubmedDiagnostics,
  getPubmedAffiliations,
  getPubmedDiagnostics,
  getPubmedRecords,
  parsePubmedYear,
  resetPubmedDiagnostics,
  searchPubmedByAuthor,
} from "../lib/pubmed";
import sampleSummaries from "./fixtures/pubmed/sample-summaries.json";
import { withFakeTimers } from "./helpers/fake-timers";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Real esummary only returns docsums for the ids actually requested — mirror
// that instead of always handing back the full 3-record fixture regardless
// of the URL, so each test's `records[0]` is the record it actually asked for.
function summaryFixtureFor(...uids: string[]): unknown {
  const result: Record<string, unknown> = { uids };
  for (const uid of uids) result[uid] = (sampleSummaries.result as Record<string, unknown>)[uid];
  return { header: sampleSummaries.header, result };
}

function stubEsummaryFetch(...uids: string[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(summaryFixtureFor(...uids))));
}

describe("parsePubmedYear — real fixture formats", () => {
  it.each([
    ["2026 Jul 2", 2026],
    ["2026 May 17", 2026],
    ["2026 May 15", 2026],
  ])("%s -> %d", (pubdate, expected) => {
    expect(parsePubmedYear(pubdate)).toBe(expected);
  });

  it("returns null, never throws, on an unrecognized shape", () => {
    expect(() => parsePubmedYear("")).not.toThrow();
    expect(parsePubmedYear("")).toBeNull();
    expect(parsePubmedYear("no year here")).toBeNull();
  });
});

describe("getPubmedRecords — real esummary fixture", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("batches all pmids into a single esummary call (comma-joined), not one request per pmid", async () => {
    stubEsummaryFetch("42387281", "42200906", "41740644");

    await getPubmedRecords(["42387281", "42200906", "41740644"]);

    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain("id=42387281%2C42200906%2C41740644");
  });

  it("uses fulljournalname, not the abbreviated source, for the journal field", async () => {
    stubEsummaryFetch("42387281");
    const records = await getPubmedRecords(["42387281"]);
    expect(records[0].journal).toBe("Exercise and sport sciences reviews");
  });

  it("treats empty-string volume/issue/pages as absent (null), not as a real value", async () => {
    stubEsummaryFetch("42387281");
    const records = await getPubmedRecords(["42387281"]);
    expect(records[0]).toMatchObject({ volume: null, issue: null, pages: null });
  });

  it("an article-number-style pages value ('150228') survives as a real, non-null value", async () => {
    stubEsummaryFetch("41740644");
    const records = await getPubmedRecords(["41740644"]);
    expect(records[0].pages).toBe("150228");
    expect(records[0].issue).toBeNull(); // this record's issue IS an empty string
  });

  it("extracts the DOI from articleids", async () => {
    stubEsummaryFetch("42387281");
    const records = await getPubmedRecords(["42387281"]);
    expect(records[0].doi).toBe("10.1249/JES.0000000000000392");
  });

  it("builds url from the DOI when one is present (publications.url is NOT NULL, and PubMed's own record here has no separate 'url' field)", async () => {
    stubEsummaryFetch("42387281");
    const records = await getPubmedRecords(["42387281"]);
    expect(records[0].url).toBe("https://doi.org/10.1249/JES.0000000000000392");
  });

  it("parses pubdate into a year via parsePubmedYear", async () => {
    stubEsummaryFetch("42200906");
    const records = await getPubmedRecords(["42200906"]);
    expect(records[0].year).toBe(2026);
  });

  it("the full 11-author list survives in original position order — no re-sorting by name", async () => {
    stubEsummaryFetch("42387281");
    const records = await getPubmedRecords(["42387281"]);
    expect(records[0].authors).toHaveLength(11);
    expect(records[0].authors[0]).toEqual({ name: "Stock, M.S.", position: 0 });
    expect(records[0].authors[10]).toEqual({ name: "Carr, J.C.", position: 10 });
  });

  it("converts each author from PubMed form to citation form ('Stock MS' -> 'Stock, M.S.')", async () => {
    stubEsummaryFetch("41740644");
    const records = await getPubmedRecords(["41740644"]);
    // Real fixture case: Stock MS is 4th of 5 authors here, not first — position order must be preserved.
    expect(records[0].authors).toEqual([
      { name: "Fraterrigo, N.J.", position: 0 },
      { name: "DiMaio, R.S.", position: 1 },
      { name: "Girts, R.M.", position: 2 },
      { name: "Stock, M.S.", position: 3 },
      { name: "Harmon, K.K.", position: 4 },
    ]);
  });

  it("falls back to a pubmed.ncbi.nlm.nih.gov URL when a record has no DOI in articleids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          result: {
            uids: ["99"],
            "99": { uid: "99", pubdate: "2026", fulljournalname: "J", title: "No DOI Paper", authors: [], articleids: [{ idtype: "pubmed", value: "99" }] },
          },
        })
      )
    );
    const records = await getPubmedRecords(["99"]);
    expect(records[0].url).toBe("https://pubmed.ncbi.nlm.nih.gov/99/");
  });

  it("returns [] for an empty pmid list without making a request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const records = await getPubmedRecords([]);
    expect(records).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("searchPubmedByAuthor — query construction", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("converts the roster citation-form name to PubMed query form ('Zraick, R.I.' -> 'Zraick RI') before searching", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ esearchresult: { idlist: [] } })));

    await searchPubmedByAuthor("Zraick, R.I.", "University of Central Florida");

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain(encodeURIComponent("Zraick RI[Author]"));
  });

  it("sets an explicit, generous retmax — NCBI's esearch defaults to 20 and would otherwise silently truncate a prolific author's real result set (confirmed live: 140 total hits for a real CHPS faculty member)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ esearchresult: { idlist: [] } })));

    await searchPubmedByAuthor("Stock, M.S.", "University of Central Florida");

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    const retmax = Number(new URL(url).searchParams.get("retmax"));
    expect(retmax).toBeGreaterThanOrEqual(200);
  });

  it("returns the idlist from esearchresult", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ esearchresult: { idlist: ["42387281", "42200906"] } })));

    const pmids = await searchPubmedByAuthor("Stock, M.S.", "University of Central Florida");

    expect(pmids).toEqual(["42387281", "42200906"]);
  });

  it("affiliation is never a hard filter — a real paper whose search result set is unaffected by affiliationHint is still returned (never AND-ed into the boolean query as an exclusion)", async () => {
    // PubMed's esearch is Boolean field-matching (no relevance-ranking
    // equivalent to Crossref's query.affiliation) — AND-ing affiliation in
    // would silently exclude a real UCF faculty member's paper carrying a
    // different institution's affiliation (visiting scholar, prior job,
    // multi-site study). Prove the query never encodes "[Affiliation]" at all.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ esearchresult: { idlist: ["1"] } })));

    await searchPubmedByAuthor("Stock, M.S.", "Some Completely Different Institution");

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).not.toContain("Affiliation");
  });

  it("warns when NCBI's true hit count substantially exceeds the returned idlist — visibility only, doesn't change the returned pmids", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ esearchresult: { count: "970", idlist: Array.from({ length: 250 }, (_, i) => String(i)) } }))
    );

    const pmids = await searchPubmedByAuthor("Stock, M.", "University of Central Florida");

    expect(pmids).toHaveLength(250); // unaffected — visibility only
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/970/));
    warnSpy.mockRestore();
  });

  it("does not warn when count is close to what was returned", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ esearchresult: { count: "2", idlist: ["1", "2"] } })));

    await searchPubmedByAuthor("Stock, M.S.", "University of Central Florida");

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// §13 item 10 bug fix: prefer the richer full_name source over the
// sometimes-sparse display_name for building the PubMed query.
describe("buildPubmedAuthorQuery — prefers full_name, falls back to display_name", () => {
  it("uses full_name when it parses cleanly, source: 'full_name'", () => {
    expect(buildPubmedAuthorQuery({ display_name: "Stock, M.", full_name: "Matt S. Stock" })).toEqual({
      queryName: "Stock MS",
      source: "full_name",
    });
  });

  it("falls back to display_name when full_name is null, source: 'display_name_fallback'", () => {
    expect(buildPubmedAuthorQuery({ display_name: "Zraick, R.I.", full_name: null })).toEqual({
      queryName: "Zraick RI",
      source: "display_name_fallback",
    });
  });

  it("falls back to display_name when full_name doesn't parse (the corrupted Lee, E.M. case) — the fallback recovers full initials here, not a degradation", () => {
    expect(buildPubmedAuthorQuery({ display_name: "Lee, E.M.", full_name: "Eunkyung “Muriel” Lee" })).toEqual({
      queryName: "Lee EM",
      source: "display_name_fallback",
    });
  });
});

// docs/phase5-findings.md #2 (Session 12): real, untrimmed efetch captures —
// see tests/fixtures/api/README.md for exactly what each real PMID proves.
const NORTE_AND_COLLISION_XML = readFileSync(
  path.join(__dirname, "fixtures", "api", "pubmed-efetch-norte-and-collision.xml"),
  "utf-8"
);
const OLD_NO_AFFILIATION_XML = readFileSync(path.join(__dirname, "fixtures", "api", "pubmed-efetch-old-no-affiliation.xml"), "utf-8");

describe("extractAffiliationsFromXml — real efetch captures", () => {
  it("affiliation present and UCF-matching (real Norte G. paper, single author with a match)", () => {
    const result = extractAffiliationsFromXml(NORTE_AND_COLLISION_XML);
    const affiliations = result.get("41765003")!;
    expect(affiliations.length).toBeGreaterThan(0);
    expect(affiliations.some((a) => a.includes("University of Central Florida"))).toBe(true);
  });

  it("affiliation present but on only the 5th of 6 authors, not the first (real Norte G. co-authored paper)", () => {
    const result = extractAffiliationsFromXml(NORTE_AND_COLLISION_XML);
    const affiliations = result.get("42246438")!;
    expect(affiliations).toHaveLength(6); // one per author, all 6 have SOME affiliation coded
    expect(affiliations[0]).toContain("University of Toledo"); // first author — not UCF
    expect(affiliations.some((a) => a.includes("University of Central Florida"))).toBe(true); // Norte, 5th of 6
  });

  it("affiliation present and clearly non-UCF (real global name-collision papers, Chinese institutions)", () => {
    const result = extractAffiliationsFromXml(NORTE_AND_COLLISION_XML);
    for (const pmid of ["42561073", "42561035", "42561017"]) {
      const affiliations = result.get(pmid)!;
      expect(affiliations.length).toBeGreaterThan(0);
      expect(affiliations.some((a) => a.includes("University of Central Florida"))).toBe(false);
    }
  });

  it("captures every <AffiliationInfo> block when an author has more than one (real dual-institution author)", () => {
    const result = extractAffiliationsFromXml(NORTE_AND_COLLISION_XML);
    const affiliations = result.get("42561073")!;
    // Palmer PI has two AffiliationInfo blocks, both University of Edinburgh —
    // both must survive extraction, not just the first.
    const edinburgh = affiliations.filter((a) => a.includes("University of Edinburgh"));
    expect(edinburgh.length).toBeGreaterThanOrEqual(2);
  });

  it("affiliation absent on every author (real 1970s records — a genuine PubMed coverage gap, not a parse failure)", () => {
    const result = extractAffiliationsFromXml(OLD_NO_AFFILIATION_XML);
    for (const pmid of ["120000", "150000", "200000"]) {
      expect(result.has(pmid)).toBe(true);
      expect(result.get(pmid)).toEqual([]);
    }
  });

  it("decodes XML entities in affiliation text (real '&amp;' in the Norte lab name)", () => {
    const result = extractAffiliationsFromXml(NORTE_AND_COLLISION_XML);
    const affiliations = result.get("42268385")!;
    expect(affiliations.some((a) => a.includes("Neuroplasticity, & Sarcopenia"))).toBe(true);
    expect(affiliations.some((a) => a.includes("&amp;"))).toBe(false);
  });

  it("malformed XML never throws — returns an empty map rather than crashing", () => {
    expect(() => extractAffiliationsFromXml("<PubmedArticleSet><PubmedArticle><unclosed")).not.toThrow();
    expect(extractAffiliationsFromXml("<PubmedArticleSet><PubmedArticle><unclosed")).toEqual(new Map());
    expect(() => extractAffiliationsFromXml("")).not.toThrow();
    expect(() => extractAffiliationsFromXml("not xml at all, just text")).not.toThrow();
  });

  it("a PubmedArticle with no PMID at all is skipped, not crashed on or mis-keyed", () => {
    const xml = "<PubmedArticleSet><PubmedArticle><MedlineCitation><Article><ArticleTitle>No PMID here</ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>";
    expect(extractAffiliationsFromXml(xml).size).toBe(0);
  });
});

describe("getPubmedAffiliations — network layer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("batches all pmids into a single efetch call (comma-joined), not one request per pmid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(NORTE_AND_COLLISION_XML, { status: 200 })));
    await getPubmedAffiliations(["42268385", "42246438"]);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain("id=42268385%2C42246438");
    expect(url).toContain("efetch.fcgi");
  });

  it("requests retmode=xml exactly once — never a duplicated retmode= param (a real NCBI 500, confirmed live)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(NORTE_AND_COLLISION_XML, { status: 200 })));
    await getPubmedAffiliations(["42268385"]);
    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url.match(/retmode=/g)).toHaveLength(1);
    expect(url).toContain("retmode=xml");
  });

  it("returns an empty map for an empty pmid list without making a request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const result = await getPubmedAffiliations([]);
    expect(result).toEqual(new Map());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("wraps a network failure in PubmedUnavailableError, same as the other PubMed calls", async () => {
    // fetchWithRetry's real exponential backoff would otherwise add real
    // wall-clock delay here (tests/helpers/fake-timers.ts's own header notes
    // this exact failure mode has caused real flakes in this repo before).
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    await withFakeTimers(() => expect(getPubmedAffiliations(["1"])).rejects.toThrow(/PubMed efetch/));
  });
});

// docs/phase5-findings.md (Session 13 diagnostic): a "successful after
// retries" result was indistinguishable from "successful first try" before
// this — these tests are what prove the fix actually distinguishes them.
describe("PubMed request diagnostics — resetPubmedDiagnostics / getPubmedDiagnostics / formatPubmedDiagnostics", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts empty after a reset, before any call", () => {
    resetPubmedDiagnostics();
    const d = getPubmedDiagnostics();
    expect(d.esearch.requests).toBe(0);
    expect(d.esummary.requests).toBe(0);
    expect(d.efetch.requests).toBe(0);
  });

  it("a single successful esearch call records exactly 1 request, 1 attempt, and its status code — not conflated with a retried call", async () => {
    resetPubmedDiagnostics();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 })));

    await searchPubmedByAuthor("Stock MS", "University of Central Florida");

    const d = getPubmedDiagnostics();
    expect(d.esearch.requests).toBe(1);
    expect(d.esearch.attempts).toBe(1); // no retry — this is exactly what distinguishes it from the next test
    expect(d.esearch.statusCounts).toEqual({ "200": 1 });
    expect(d.esearch.backoffMs).toBe(0);
  });

  it("a 429-then-200 sequence records 2 attempts for 1 request, both status codes, and non-zero backoff time — this is the case a plain 'it succeeded' summary can't see", async () => {
    resetPubmedDiagnostics();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await withFakeTimers(() => searchPubmedByAuthor("Stock MS", "University of Central Florida"));

    const d = getPubmedDiagnostics();
    expect(d.esearch.requests).toBe(1); // one logical call from the caller's point of view
    expect(d.esearch.attempts).toBe(2); // but it took two tries — this is the retry the old summary couldn't show
    expect(d.esearch.statusCounts).toEqual({ "429": 1, "200": 1 });
    expect(d.esearch.backoffMs).toBeGreaterThan(0); // real time was spent waiting between the two attempts
  });

  it("a request that throws every attempt (network error, never a status code) is tracked under an error: key, not silently dropped", async () => {
    resetPubmedDiagnostics();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));

    await withFakeTimers(() => expect(searchPubmedByAuthor("Stock MS", "x")).rejects.toThrow());

    const d = getPubmedDiagnostics();
    expect(d.esearch.attempts).toBeGreaterThan(1); // fetchWithRetry's default max attempts
    const errorKeys = Object.keys(d.esearch.statusCounts).filter((k) => k.startsWith("error:"));
    expect(errorKeys.length).toBeGreaterThan(0);
  });

  it("resetPubmedDiagnostics() between two calls means the second snapshot reflects only the second call — the per-person isolation the distribution analysis depends on", async () => {
    resetPubmedDiagnostics();
    // A Response body can only be read once — a fresh instance per call,
    // not mockResolvedValue's single shared instance, since this test calls
    // searchPubmedByAuthor twice.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }))
    );
    await searchPubmedByAuthor("Person A", "x");
    expect(getPubmedDiagnostics().esearch.requests).toBe(1);

    resetPubmedDiagnostics();
    expect(getPubmedDiagnostics().esearch.requests).toBe(0); // NOT 1 — a running total would fail this
    await searchPubmedByAuthor("Person B", "x");
    expect(getPubmedDiagnostics().esearch.requests).toBe(1); // still 1, not 2
  });

  it("formatPubmedDiagnostics only includes call types that were actually used, and surfaces the retry count", async () => {
    resetPubmedDiagnostics();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await withFakeTimers(() => searchPubmedByAuthor("Stock MS", "x"));

    const line = formatPubmedDiagnostics(getPubmedDiagnostics());
    expect(line).toContain("esearch:");
    expect(line).toContain("1 retried");
    expect(line).not.toContain("esummary:"); // never called this test — must not appear as a false zero-entry
    expect(line).not.toContain("efetch:");
  });
});
