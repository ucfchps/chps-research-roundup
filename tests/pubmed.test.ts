// Ground truth: tests/fixtures/pubmed/sample-summaries.json — real
// eutils.ncbi.nlm.nih.gov esummary pulls for three actual CHPS publications
// (§5 Layer 3, §13 item 10). See also lib/names.ts's toPubmedQueryName /
// fromPubmedAuthorName, tested in tests/names.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPubmedAuthorQuery, getPubmedRecords, parsePubmedYear, searchPubmedByAuthor } from "../lib/pubmed";
import sampleSummaries from "./fixtures/pubmed/sample-summaries.json";

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
