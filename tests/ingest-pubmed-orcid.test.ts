// See master plan §5 Layer 3, §7 (merge), §9/§13 item 10 (ingest-pubmed-orcid).
// Mirrors tests/ingest-crossref.test.ts's DB-backed pattern (temp-SQLite via
// runMigrations, global-fetch-stub router) — NOT a second copy of the merge
// engine or author-linking, both already covered by tests/matching.test.ts
// and tests/scholar-ingest.test.ts. Unit-level ORCID/PubMed parsing is
// already covered against the real fixtures in tests/orcid.test.ts and
// tests/pubmed.test.ts; this file uses small synthetic API responses to keep
// the DB-integration surface focused, except for the one case that must use
// the real, confirmed shared DOI (10.3390/jfmk11020200, present in both
// tests/fixtures/orcid/sample-works.json and tests/fixtures/pubmed/sample-summaries.json).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";

process.env.CROSSREF_MAILTO ??= "test@example.com";

const { runIngestPubmedOrcid } = await import("../scripts/ingest-pubmed-orcid");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function orcidWorksResponse(groups: unknown[]) {
  return jsonResponse({ group: groups });
}

function orcidGroup(opts: { doi: string | null; title: string; year: number; type?: string; journal?: string | null; url: string }) {
  return {
    "external-ids": { "external-id": opts.doi ? [{ "external-id-type": "doi", "external-id-value": opts.doi }] : [] },
    "work-summary": [
      {
        type: opts.type ?? "journal-article",
        title: { title: { value: opts.title } },
        "publication-date": { year: { value: String(opts.year) } },
        "journal-title": opts.journal !== undefined ? { value: opts.journal } : null,
        url: { value: opts.url },
      },
    ],
  };
}

function crossrefWorksResponse(items: unknown[]) {
  return jsonResponse({ message: { items } });
}

function crossrefWorkResponse(item: unknown) {
  return jsonResponse({ message: item });
}

function crossrefItem(opts: { doi: string; title: string; authors: { given: string; family: string }[]; journal?: string; year?: number }) {
  return {
    DOI: opts.doi,
    title: [opts.title],
    type: "journal-article",
    author: opts.authors.map((a) => ({ given: a.given, family: a.family, affiliation: [] })),
    "container-title": [opts.journal ?? "Test Journal"],
    volume: "1",
    issue: "1",
    page: "1-10",
    issued: { "date-parts": [[opts.year ?? 2026]] },
  };
}

function esearchResponse(idlist: string[]) {
  return jsonResponse({ esearchresult: { idlist } });
}

function esummaryResponse(records: { uid: string; title: string; pubdate: string; journal: string; authors: string[]; doi?: string; volume?: string; issue?: string; pages?: string }[]) {
  const result: Record<string, unknown> = { uids: records.map((r) => r.uid) };
  for (const r of records) {
    result[r.uid] = {
      uid: r.uid,
      pubdate: r.pubdate,
      fulljournalname: r.journal,
      title: r.title,
      volume: r.volume ?? "",
      issue: r.issue ?? "",
      pages: r.pages ?? "",
      authors: r.authors.map((name) => ({ name, authtype: "Author" })),
      articleids: r.doi ? [{ idtype: "doi", value: r.doi }] : [],
    };
  }
  return jsonResponse({ result });
}

describe("runIngestPubmedOrcid — integration", () => {
  let dbDir: string;
  let client: Client;

  async function seedFaculty(wpId: string, displayName: string, fullName: string, orcid: string | null): Promise<number> {
    const result = await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, orcid, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      args: [wpId, wpId, displayName, fullName, `${wpId}@example.com`, "School of Kinesiology and Rehabilitation Sciences", orcid],
    });
    return Number(result.lastInsertRowid);
  }

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "ingest-pubmed-orcid-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  // Routes by hostname/path — ORCID works, Crossref DOI lookup, Crossref
  // title search, PubMed esearch, PubMed esummary. `byDoi` and `byTitle`
  // let each test control exactly what each candidate resolves to.
  function stubFetch(opts: {
    orcid?: Response | (() => Response);
    byDoi?: Record<string, Response | (() => Response)>;
    byTitle?: Response | (() => Response);
    esearch?: Response | (() => Response);
    esummary?: Response | (() => Response);
  }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("pub.orcid.org")) {
          if (!opts.orcid) throw new Error(`unexpected ORCID fetch: ${url}`);
          return typeof opts.orcid === "function" ? opts.orcid() : opts.orcid;
        }
        if (url.includes("api.crossref.org/works/")) {
          const doi = decodeURIComponent(url.split("api.crossref.org/works/")[1].split("?")[0]);
          const entry = opts.byDoi?.[doi];
          if (!entry) throw new Error(`unexpected Crossref DOI fetch: ${url}`);
          return typeof entry === "function" ? entry() : entry;
        }
        if (url.includes("api.crossref.org/works?query.bibliographic")) {
          if (!opts.byTitle) throw new Error(`unexpected Crossref title fetch: ${url}`);
          return typeof opts.byTitle === "function" ? opts.byTitle() : opts.byTitle;
        }
        if (url.includes("esearch.fcgi")) {
          if (!opts.esearch) throw new Error(`unexpected esearch fetch: ${url}`);
          return typeof opts.esearch === "function" ? opts.esearch() : opts.esearch;
        }
        if (url.includes("esummary.fcgi")) {
          if (!opts.esummary) throw new Error(`unexpected esummary fetch: ${url}`);
          return typeof opts.esummary === "function" ? opts.esummary() : opts.esummary;
        }
        throw new Error(`unrouted fetch: ${url}`);
      })
    );
  }

  it("§13 item 10 fix: queries PubMed via full_name when it parses cleanly, and the summary counts it as 'full_name' sourced, no fallback warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedFaculty("1", "Stock, M.", "Matt S. Stock", null); // sparse display_name, rich full_name — the confirmed bug case
    stubFetch({ esearch: () => esearchResponse([]), esummary: () => esummaryResponse([]) });

    const summary = await runIngestPubmedOrcid(client, { dryRun: false, facultyWpId: "1" });

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain(encodeURIComponent("Stock MS[Author]")); // full_name-derived, not the sparse "Stock M"
    expect(summary.pubmedQueriedViaFullName).toBe(1);
    expect(summary.pubmedQueriedViaDisplayNameFallback).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("falls back to display_name when full_name is null, counts it, and logs a visible warning naming the faculty member", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedFaculty("1", "Zraick, R.I.", "Richard I. Zraick", null);
    // no full_name for this one — displays_name only
    await client.execute({ sql: "UPDATE faculty SET full_name = NULL WHERE wp_id = '1'" });
    stubFetch({ esearch: () => esearchResponse([]), esummary: () => esummaryResponse([]) });

    const summary = await runIngestPubmedOrcid(client, { dryRun: false, facultyWpId: "1" });

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain(encodeURIComponent("Zraick RI[Author]"));
    expect(summary.pubmedQueriedViaFullName).toBe(0);
    expect(summary.pubmedQueriedViaDisplayNameFallback).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Zraick, R.I."));
    warnSpy.mockRestore();
  });

  it("a faculty member with no orcid: the ORCID sweep is skipped entirely (no ORCID API call), PubMed still runs", async () => {
    await seedFaculty("1", "Wang, X.", "Xiaochuan Wang", null);
    stubFetch({ esearch: () => esearchResponse([]), esummary: () => esummaryResponse([]) });

    const summary = await runIngestPubmedOrcid(client, { dryRun: false, facultyWpId: "1" });

    expect(summary.facultyWithOrcidProcessed).toBe(0);
    expect(summary.facultyProcessedViaPubmed).toBe(1);
  });

  it("an ORCID work with a DOI resolves via resolveByDoi and inserts pending_merge, source = 'orcid'", async () => {
    const facultyId = await seedFaculty("1", "Stock, M.S.", "Matt Stock", "0000-0003-1156-1084");
    stubFetch({
      orcid: () =>
        orcidWorksResponse([
          orcidGroup({ doi: "10.1123/jsr.2024-0440", title: "A Dual-Task Agility Paper", year: 2026, url: "https://doi.org/10.1123/jsr.2024-0440" }),
        ]),
      byDoi: {
        "10.1123/jsr.2024-0440": () =>
          crossrefWorkResponse(crossrefItem({ doi: "10.1123/jsr.2024-0440", title: "A Dual-Task Agility Paper", authors: [{ given: "Matt", family: "Stock" }], journal: "Journal of Sport Rehabilitation" })),
      },
      esearch: () => esearchResponse([]),
      esummary: () => esummaryResponse([]),
    });

    const summary = await runIngestPubmedOrcid(client, { dryRun: false, facultyWpId: "1" });

    expect(summary.orcidWorksFetched).toBe(1);
    expect(summary.resolvedViaDoi).toBe(1);
    expect(summary.insertedNew).toBe(1);

    const pubs = await client.execute("SELECT doi, source, status, journal FROM publications");
    expect(pubs.rows).toEqual([{ doi: "10.1123/jsr.2024-0440", source: "orcid", status: "pending_merge", journal: "Journal of Sport Rehabilitation" }]);

    const authors = await client.execute("SELECT faculty_id, role FROM publication_authors");
    expect(authors.rows).toEqual([{ faculty_id: facultyId, role: "chps_faculty" }]);
  });

  it("an ORCID work with no DOI falls back to resolveByTitle", async () => {
    await seedFaculty("1", "Stock, M.S.", "Matt Stock", "0000-0003-1156-1084");
    stubFetch({
      orcid: () =>
        orcidWorksResponse([orcidGroup({ doi: null, title: "A No-DOI Survey Paper", year: 2026, url: "https://example.com/no-doi" })]),
      byTitle: () =>
        crossrefWorksResponse([crossrefItem({ doi: "10.9/resolved-by-title", title: "A No-DOI Survey Paper", authors: [{ given: "Matt", family: "Stock" }] })]),
      esearch: () => esearchResponse([]),
      esummary: () => esummaryResponse([]),
    });

    const summary = await runIngestPubmedOrcid(client, { dryRun: false, facultyWpId: "1" });

    expect(summary.resolvedViaDoi).toBe(0);
    expect(summary.resolvedViaTitleFallback).toBe(1);
    const pubs = await client.execute("SELECT doi, source FROM publications");
    expect(pubs.rows).toEqual([{ doi: "10.9/resolved-by-title", source: "orcid" }]);
  });

  it("an ORCID work that resolves via neither DOI nor title fallback inserts as needs_metadata, source = 'orcid', discovered_by_faculty_id set", async () => {
    const facultyId = await seedFaculty("1", "Stock, M.S.", "Matt Stock", "0000-0003-1156-1084");
    stubFetch({
      orcid: () =>
        orcidWorksResponse([orcidGroup({ doi: null, title: "An Unresolvable Gray-Lit Paper", year: 2026, url: "https://example.com/gray-lit" })]),
      byTitle: () => crossrefWorksResponse([]), // Crossref finds nothing
      esearch: () => esearchResponse([]),
      esummary: () => esummaryResponse([]),
    });

    const summary = await runIngestPubmedOrcid(client, { dryRun: false, facultyWpId: "1" });

    expect(summary.orcidNeedsMetadata).toBe(1);
    const pubs = await client.execute("SELECT title, status, source, discovered_by_faculty_id, url FROM publications");
    expect(pubs.rows).toEqual([
      { title: "An Unresolvable Gray-Lit Paper", status: "needs_metadata", source: "orcid", discovered_by_faculty_id: facultyId, url: "https://example.com/gray-lit" },
    ]);
    const authors = await client.execute("SELECT COUNT(*) as n FROM publication_authors");
    expect(authors.rows[0].n).toBe(0); // ORCID's works list carries no author data at all
  });

  it("PubMed candidates insert pending_merge, source = 'pubmed', with full author list in position order", async () => {
    const facultyId = await seedFaculty("1", "Stock, M.S.", "Matt Stock", null);
    stubFetch({
      esearch: () => esearchResponse(["100"]),
      esummary: () =>
        esummaryResponse([
          { uid: "100", title: "A PubMed-Discovered Paper", pubdate: "2026 Jul 2", journal: "Some Journal", doi: "10.5/pubmed-paper", authors: ["Harmon KK", "Stock MS"] },
        ]),
    });

    const summary = await runIngestPubmedOrcid(client, { dryRun: false, facultyWpId: "1" });

    expect(summary.pubmedRecordsFetched).toBe(1);
    expect(summary.insertedNew).toBe(1);
    const pubs = await client.execute("SELECT doi, source, status FROM publications");
    expect(pubs.rows).toEqual([{ doi: "10.5/pubmed-paper", source: "pubmed", status: "pending_merge" }]);
    const authors = await client.execute("SELECT name, faculty_id, position FROM publication_authors ORDER BY position");
    expect(authors.rows).toEqual([
      { name: "Harmon, K.K.", faculty_id: null, position: 0 },
      { name: "Stock, M.S.", faculty_id: facultyId, position: 1 },
    ]);
  });

  it("the real confirmed shared DOI (10.3390/jfmk11020200) from both ORCID and PubMed merges into ONE row, not two, with the higher-priority ORCID source's Crossref-tier metadata retained", async () => {
    await seedFaculty("1", "Stock, M.S.", "Matt Stock", "0000-0003-1156-1084");
    stubFetch({
      orcid: () =>
        orcidWorksResponse([
          orcidGroup({ doi: "10.3390/jfmk11020200", title: "A Comparison of Methods for Tracking Muscle Quality", year: 2026, url: "https://doi.org/10.3390/jfmk11020200" }),
        ]),
      byDoi: {
        "10.3390/jfmk11020200": () =>
          crossrefWorkResponse(
            crossrefItem({
              doi: "10.3390/jfmk11020200",
              title: "A Comparison of Methods for Tracking Muscle Quality During Early-Phase Rehabilitation Following Anterior Cruciate Ligament Reconstruction",
              authors: [{ given: "Matt", family: "Stock" }],
              journal: "Journal of Functional Morphology and Kinesiology",
            })
          ),
      },
      esearch: () => esearchResponse(["42200906"]),
      esummary: () =>
        esummaryResponse([
          {
            uid: "42200906",
            title: "A Comparison of Methods for Tracking Muscle Quality During Early-Phase Rehabilitation Following Anterior Cruciate Ligament Reconstruction.",
            pubdate: "2026 May 17",
            journal: "Journal of functional morphology and kinesiology",
            doi: "10.3390/jfmk11020200",
            volume: "11",
            issue: "2",
            authors: ["Stock MS", "Fowler HN"],
          },
        ]),
    });

    const summary = await runIngestPubmedOrcid(client, { dryRun: false, facultyWpId: "1" });

    expect(summary.insertedNew).toBe(1); // ORCID inserts first
    expect(summary.merged).toBe(1); // PubMed's candidate merges into the same row

    const pubs = await client.execute("SELECT doi, source, journal FROM publications WHERE doi = '10.3390/jfmk11020200'");
    expect(pubs.rows).toHaveLength(1); // exactly one row, not two
    // orcid (priority 4) already won the fields it filled — pubmed (priority 2) never downgrades them.
    expect(pubs.rows[0].source).toBe("orcid");
    expect(pubs.rows[0].journal).toBe("Journal of Functional Morphology and Kinesiology");
  });

  it("running the identical candidate set twice produces the same DB state (idempotency)", async () => {
    await seedFaculty("1", "Stock, M.S.", "Matt Stock", "0000-0003-1156-1084");
    stubFetch({
      orcid: () =>
        orcidWorksResponse([orcidGroup({ doi: "10.1/repeat", title: "A Repeated Paper", year: 2026, url: "https://doi.org/10.1/repeat" })]),
      byDoi: { "10.1/repeat": () => crossrefWorkResponse(crossrefItem({ doi: "10.1/repeat", title: "A Repeated Paper", authors: [{ given: "Matt", family: "Stock" }] })) },
      esearch: () => esearchResponse([]),
      esummary: () => esummaryResponse([]),
    });

    const first = await runIngestPubmedOrcid(client, { dryRun: false, facultyWpId: "1" });
    expect(first.insertedNew).toBe(1);

    const second = await runIngestPubmedOrcid(client, { dryRun: false, facultyWpId: "1" });
    expect(second.insertedNew).toBe(0);
    expect(second.merged).toBe(1);

    const pubs = await client.execute("SELECT COUNT(*) as n FROM publications WHERE doi = '10.1/repeat'");
    expect(pubs.rows[0].n).toBe(1);
    const authors = await client.execute("SELECT COUNT(*) as n FROM publication_authors");
    expect(authors.rows[0].n).toBe(1); // no duplicate author row either
  });

  it("promotes an existing needs_metadata stub to pending_merge when a later PubMed candidate resolves it, with first_seen_at reset to a fresh buffer window (§7)", async () => {
    await seedFaculty("1", "Stock, M.S.", "Matt Stock", null);
    const staleFirstSeenAt = new Date(Date.now() - 30 * 86400000).toISOString();
    const stub = await client.execute({
      sql: `INSERT INTO publications (title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
            VALUES ('A Stub Paper', 'a stub paper', 'https://scholar.google.com/x', 'needs_metadata', 'scholar', ?, ?, ?)`,
      args: [staleFirstSeenAt, staleFirstSeenAt.slice(0, 10), staleFirstSeenAt],
    });
    const stubId = Number(stub.lastInsertRowid);

    stubFetch({
      esearch: () => esearchResponse(["200"]),
      esummary: () => esummaryResponse([{ uid: "200", title: "A Stub Paper", pubdate: "2026 Jul 2", journal: "J", doi: "10.1/promoted", authors: ["Stock MS"] }]),
    });

    const beforeRun = Date.now();
    const summary = await runIngestPubmedOrcid(client, { dryRun: false, facultyWpId: "1" });

    expect(summary.merged).toBe(1);
    expect(summary.insertedNew).toBe(0);

    const pubs = await client.execute("SELECT id, status, doi, first_seen_at FROM publications");
    expect(pubs.rows).toHaveLength(1);
    expect(pubs.rows[0].id).toBe(stubId);
    expect(pubs.rows[0].status).toBe("pending_merge");
    expect(pubs.rows[0].doi).toBe("10.1/promoted");
    expect(Date.parse(pubs.rows[0].first_seen_at as string)).toBeGreaterThanOrEqual(beforeRun);
  });

  it("an OrcidUnavailableError for one faculty member doesn't abort the run — PubMed for that person and everyone else still processes", async () => {
    await seedFaculty("1", "Stock, M.S.", "Matt Stock", "0000-0003-1156-1084");
    await seedFaculty("2", "Second, A.", "Alice Second", null);

    stubFetch({
      orcid: () => new Response("server error", { status: 400 }), // non-retryable — fails fast
      esearch: () => esearchResponse([]),
      esummary: () => esummaryResponse([]),
    });

    const summary = await runIngestPubmedOrcid(client, { dryRun: false, facultyWpId: null });

    expect(summary.facultyWithOrcidProcessed).toBe(1); // attempted, but errored
    expect(summary.facultyProcessedViaPubmed).toBe(2); // both people still swept via PubMed
    expect(summary.skipped).toEqual([{ wpId: "1", displayName: "Stock, M.S.", source: "orcid", error: expect.any(String) }]);
  });

  it("a human-set role_set_by survives a merge from this ingester (guardrail also proven for Crossref in tests/ingest-crossref.test.ts)", async () => {
    const facultyId = await seedFaculty("1", "Stock, M.S.", "Matt Stock", null);
    const now = new Date().toISOString();
    const pub = await client.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
            VALUES ('10.1/human-set', 'A Human Reviewed Paper', 'a human reviewed paper', 'https://doi.org/10.1/human-set', 'pending_merge', 'scholar', ?, ?, ?)`,
      args: [now, now.slice(0, 10), now],
    });
    const pubId = Number(pub.lastInsertRowid);
    await client.execute({
      sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, 'grad_student', 'faculty:1', ?, 0)`,
      args: [pubId, facultyId, "Someone, S.", now],
    });

    stubFetch({
      esearch: () => esearchResponse(["300"]),
      esummary: () => esummaryResponse([{ uid: "300", title: "A Human Reviewed Paper", pubdate: "2026 Jul 2", journal: "J", doi: "10.1/human-set", authors: ["Someone S"] }]),
    });

    await runIngestPubmedOrcid(client, { dryRun: false, facultyWpId: "1" });

    const authors = await client.execute("SELECT role, role_set_by FROM publication_authors WHERE publication_id = ?", [pubId]);
    expect(authors.rows).toEqual([{ role: "grad_student", role_set_by: "faculty:1" }]); // untouched
  });
});
