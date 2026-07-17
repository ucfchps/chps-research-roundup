// See master plan §5 (Layer 2), §7 (merge), §9/§13 item 8 (ingest-crossref),
// §11. This tests the new searchByAuthor query-building (lib/crossref.ts) and
// the orchestration in scripts/ingest-crossref.ts — NOT a second copy of the
// merge engine or author-linking, both of which are already covered by
// tests/matching.test.ts and tests/scholar-ingest.test.ts. DB-backed cases use
// the same temp-SQLite-via-runMigrations pattern as
// tests/ingest-scholar.integration.test.ts / tests/duplicates.test.ts /
// tests/release.test.ts; the global-fetch-stub router mirrors
// tests/ingest-scholar.integration.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";

// lib/crossref.ts validates CROSSREF_MAILTO at import time — set it before
// the dynamic import, same reason tests/crossref.test.ts does this.
process.env.CROSSREF_MAILTO ??= "test@example.com";

const { searchByAuthor } = await import("../lib/crossref");
const { runIngestCrossref, assertScopeIsSafe } = await import("../scripts/ingest-crossref");

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function crossrefItem(opts: {
  doi: string;
  title: string;
  authors: { given: string; family: string; affiliation?: string }[];
  containerTitle?: string;
  volume?: string;
  issue?: string;
  page?: string;
  year?: number;
}) {
  return {
    DOI: opts.doi,
    title: [opts.title],
    type: "journal-article",
    author: opts.authors.map((a) => ({ given: a.given, family: a.family, affiliation: a.affiliation ? [{ name: a.affiliation }] : [] })),
    "container-title": [opts.containerTitle ?? "Test Journal"],
    volume: opts.volume ?? "1",
    issue: opts.issue ?? "1",
    page: opts.page ?? "1-10",
    issued: { "date-parts": [[opts.year ?? 2026]] },
  };
}

function searchResponse(items: unknown[]) {
  return jsonResponse({ message: { items } });
}

describe("searchByAuthor — query construction", () => {
  beforeEach(() => {
    // mockImplementation (not mockResolvedValue) — a fresh Response per call,
    // since a Response body can only be read once and some of these tests
    // call searchByAuthor more than once.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => searchResponse([])));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queries query.author with the given authorName, and omits query.affiliation when none is given", async () => {
    await searchByAuthor({ authorName: "Richard I. Zraick" });

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain(`query.author=${encodeURIComponent("Richard I. Zraick")}`);
    expect(url).not.toContain("query.affiliation");
  });

  it("includes query.affiliation as a ranking hint when affiliationHint is provided", async () => {
    await searchByAuthor({ authorName: "Richard I. Zraick", affiliationHint: "University of Central Florida" });

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain(`query.affiliation=${encodeURIComponent("University of Central Florida")}`);
  });

  it("formats sincePubDate as a from-pub-date filter", async () => {
    await searchByAuthor({ authorName: "Richard I. Zraick", sincePubDate: "2025-01-15" });

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain(encodeURIComponent("from-pub-date:2025-01-15"));
  });

  it("defaults rows to 20, and honors an explicit rows value", async () => {
    await searchByAuthor({ authorName: "Richard I. Zraick" });
    const [defaultUrl] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(defaultUrl).toContain("rows=20");

    await searchByAuthor({ authorName: "Richard I. Zraick", rows: 5 });
    const [explicitUrl] = vi.mocked(fetch).mock.calls[1] as [string];
    expect(explicitUrl).toContain("rows=5");
  });
});

describe("searchByAuthor — surname gate (false-positive guard, real case: 'Adams' pulled in unrelated authors)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a candidate whose author list doesn't contain the searched surname at all is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        searchResponse([
          crossrefItem({ doi: "10.1/unrelated", title: "An Unrelated Osteology Paper", authors: [{ given: "Someone", family: "Nobody" }] }),
        ])
      )
    );

    const result = await searchByAuthor({ authorName: "Alauna Adams", surnameHint: "Adams" });

    expect(result.resolutions).toEqual([]);
    expect(result.rejectedBySurnameGate).toBe(1);
  });

  it("a candidate whose author list DOES contain the searched surname passes through, even if it turns out to be a different person (§8b's review flow handles that residual risk)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        searchResponse([
          crossrefItem({ doi: "10.1/same-surname", title: "A Paper By A Different Adams Entirely", authors: [{ given: "Some Other", family: "Adams" }] }),
        ])
      )
    );

    const result = await searchByAuthor({ authorName: "Alauna Adams", surnameHint: "Adams" });

    expect(result.resolutions).toHaveLength(1);
    expect(result.resolutions[0].doi).toBe("10.1/same-surname");
    expect(result.rejectedBySurnameGate).toBe(0);
  });

  it("with no surnameHint given, nothing is rejected — the gate is opt-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        searchResponse([crossrefItem({ doi: "10.1/unrelated", title: "An Unrelated Osteology Paper", authors: [{ given: "Someone", family: "Nobody" }] })])
      )
    );

    const result = await searchByAuthor({ authorName: "Alauna Adams" });

    expect(result.resolutions).toHaveLength(1);
    expect(result.rejectedBySurnameGate).toBe(0);
  });
});

describe("assertScopeIsSafe — refuses an unscoped real run without an explicit override", () => {
  it("throws when the run is real, unscoped, and no override is given", () => {
    expect(() => assertScopeIsSafe({ dryRun: false, facultyWpId: null }, false)).toThrow(/unscoped/i);
  });

  it("does not throw for a dry-run, even unscoped", () => {
    expect(() => assertScopeIsSafe({ dryRun: true, facultyWpId: null }, false)).not.toThrow();
  });

  it("does not throw for a real run scoped to a single faculty member", () => {
    expect(() => assertScopeIsSafe({ dryRun: false, facultyWpId: "1069" }, false)).not.toThrow();
  });

  it("does not throw for a real, unscoped run when the override is explicitly passed", () => {
    expect(() => assertScopeIsSafe({ dryRun: false, facultyWpId: null }, true)).not.toThrow();
  });
});

describe("runIngestCrossref — integration", () => {
  let dbDir: string;
  let client: Client;

  async function seedFaculty(wpId: string, displayName: string, fullName: string): Promise<number> {
    const result = await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, active) VALUES (?, ?, ?, ?, ?, ?, 1)`,
      args: [wpId, wpId, displayName, fullName, `${wpId}@example.com`, "Department of Health Sciences"],
    });
    return Number(result.lastInsertRowid);
  }

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "ingest-crossref-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  // Routes by the decoded query.author value so each test controls exactly
  // what each faculty member's search "returns."
  function stubFetch(byAuthorName: Record<string, Response | (() => Response)>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const match = url.match(/query\.author=([^&]+)/);
        const authorName = match ? decodeURIComponent(match[1]) : "";
        const entry = byAuthorName[authorName];
        if (!entry) throw new Error(`unexpected fetch for author "${authorName}": ${url}`);
        return typeof entry === "function" ? entry() : entry;
      })
    );
  }

  it("a candidate that matches an existing publication (by DOI) merges rather than duplicating", async () => {
    const facultyId = await seedFaculty("1", "Zraick, R.I.", "Richard I. Zraick");
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, journal, year, volume, issue, pages, status, source, first_seen_at, date_added, created_at)
            VALUES ('10.1234/existing', 'An Existing Paper', 'an existing paper', 'https://doi.org/10.1234/existing', 'Old Journal', 2025, NULL, NULL, NULL, 'pending_merge', 'scholar', ?, ?, ?)`,
      args: [now, now.slice(0, 10), now],
    });

    stubFetch({
      "Richard I. Zraick": () =>
        searchResponse([
          crossrefItem({ doi: "10.1234/existing", title: "An Existing Paper", authors: [{ given: "Richard", family: "Zraick" }], containerTitle: "Real Journal", volume: "5", issue: "2", page: "10-20" }),
        ]),
    });

    const summary = await runIngestCrossref(client, { dryRun: false, facultyWpId: "1" });

    expect(summary.merged).toBe(1);
    expect(summary.insertedNew).toBe(0);

    const pubs = await client.execute("SELECT id, journal, volume, status FROM publications");
    expect(pubs.rows).toHaveLength(1); // no duplicate row
    expect(pubs.rows[0].journal).toBe("Real Journal"); // crossref (>= scholar priority) won the merge
    expect(pubs.rows[0].status).toBe("pending_merge");

    void facultyId;
  });

  it("a needs_metadata publication matched by a Crossref sweep candidate is promoted to pending_merge, not left stuck or duplicated, with first_seen_at reset to a fresh buffer window (§7)", async () => {
    await seedFaculty("1", "Zraick, R.I.", "Richard I. Zraick");
    const createdAt = new Date().toISOString();
    // Deliberately stale — this is the case the fix is for: a stub that has
    // been sitting in needs_metadata for weeks before a resolution arrives.
    // If first_seen_at is left untouched, the promoted record would already
    // be ~720h past a 60h MERGE_BUFFER_HOURS the moment it's promoted —
    // release-buffer would release it on its very next run instead of
    // giving it a real buffer window.
    const staleFirstSeenAt = new Date(Date.now() - 30 * 86400000).toISOString();
    const stub = await client.execute({
      sql: `INSERT INTO publications (title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
            VALUES ('A Gray Lit Paper', 'a gray lit paper', 'https://scholar.google.com/x', 'needs_metadata', 'scholar', ?, ?, ?)`,
      args: [staleFirstSeenAt, staleFirstSeenAt.slice(0, 10), createdAt],
    });
    const stubId = Number(stub.lastInsertRowid);

    stubFetch({
      "Richard I. Zraick": () =>
        searchResponse([crossrefItem({ doi: "10.1234/gray-lit-resolved", title: "A Gray Lit Paper", authors: [{ given: "Richard", family: "Zraick" }] })]),
    });

    const beforeRun = Date.now();
    const summary = await runIngestCrossref(client, { dryRun: false, facultyWpId: "1" });

    expect(summary.merged).toBe(1);
    expect(summary.insertedNew).toBe(0);

    const pubs = await client.execute("SELECT id, doi, status, first_seen_at FROM publications");
    expect(pubs.rows).toHaveLength(1); // promoted in place, not duplicated
    expect(pubs.rows[0].id).toBe(stubId);
    expect(pubs.rows[0].status).toBe("pending_merge"); // promoted out of needs_metadata (§15.11)
    expect(pubs.rows[0].doi).toBe("10.1234/gray-lit-resolved");
    // The stale timestamp must be gone — first_seen_at is now "this run," not
    // 30 days ago, so release-buffer gives it a full fresh buffer window.
    expect(Date.parse(pubs.rows[0].first_seen_at as string)).toBeGreaterThanOrEqual(beforeRun);
  });

  it("a resolved candidate merging into an already pending_merge record leaves first_seen_at untouched (no promotion happened, nothing to reset)", async () => {
    await seedFaculty("1", "Zraick, R.I.", "Richard I. Zraick");
    const staleFirstSeenAt = new Date(Date.now() - 30 * 86400000).toISOString();
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, journal, year, volume, issue, pages, status, source, first_seen_at, date_added, created_at)
            VALUES ('10.1234/already-pending', 'Already Pending Paper', 'already pending paper', 'https://doi.org/10.1234/already-pending', 'Old Journal', 2025, NULL, NULL, NULL, 'pending_merge', 'crossref', ?, ?, ?)`,
      args: [staleFirstSeenAt, staleFirstSeenAt.slice(0, 10), now],
    });

    stubFetch({
      "Richard I. Zraick": () =>
        searchResponse([
          crossrefItem({ doi: "10.1234/already-pending", title: "Already Pending Paper", authors: [{ given: "Richard", family: "Zraick" }], containerTitle: "Newer Journal" }),
        ]),
    });

    await runIngestCrossref(client, { dryRun: false, facultyWpId: "1" });

    const pubs = await client.execute("SELECT first_seen_at FROM publications WHERE doi = '10.1234/already-pending'");
    // Already pending_merge -> promoteFromNeedsMetadata never fires -> the
    // original (still-stale) first_seen_at must survive unchanged.
    expect(pubs.rows[0].first_seen_at).toBe(staleFirstSeenAt);
  });

  it("§15.11: distinguishes 'no candidates at all' from 'candidates but none linked' from 'linked at least one', per faculty member", async () => {
    // Person A: search comes back completely empty.
    await seedFaculty("1", "Nobody, N.", "Nobody Nothing");
    // Person B: search finds a candidate whose author list DOES contain the
    // surname (passes the gate) but the first initial doesn't match — a real
    // Smith, just not THIS Smith — so buildAuthorInputs leaves it unlinked.
    await seedFaculty("2", "Smith, A.", "Alice Smith");
    // Person C: a real, clean link.
    await seedFaculty("3", "Zraick, R.I.", "Richard I. Zraick");

    stubFetch({
      "Nobody Nothing": () => searchResponse([]),
      "Alice Smith": () =>
        searchResponse([crossrefItem({ doi: "10.1/someone-elses-smith", title: "A Different Smith's Paper", authors: [{ given: "Bob", family: "Smith" }] })]),
      "Richard I. Zraick": () =>
        searchResponse([crossrefItem({ doi: "10.1/zraick-paper", title: "A Real Zraick Paper", authors: [{ given: "Richard", family: "Zraick" }] })]),
    });

    const summary = await runIngestCrossref(client, { dryRun: false, facultyWpId: null });

    const byWpId = new Map(summary.facultySweepOutcomes.map((f) => [f.wpId, f]));
    expect(byWpId.get("1")).toMatchObject({ candidatesSeen: 0, linked: false });
    expect(byWpId.get("2")).toMatchObject({ candidatesSeen: 1, linked: false });
    expect(byWpId.get("3")).toMatchObject({ candidatesSeen: 1, linked: true });

    // All three have no ORCID/no Scholar profile (seedFaculty sets neither) —
    // §11's "no Scholar coverage" bucket, and yet their outcomes differ completely.
    expect(summary.facultySweepOutcomes.every((f) => f.noScholarCoverage)).toBe(true);
  });

  it("a candidate rejected by the surname gate never reaches the merge engine — no row inserted, reported in the summary", async () => {
    await seedFaculty("1", "Adams, A.", "Alauna Adams");

    stubFetch({
      "Alauna Adams": () =>
        searchResponse([
          crossrefItem({ doi: "10.1/unrelated-osteology", title: "Decision Trees for Osteological Sex Estimation", authors: [{ given: "Someone", family: "Nobody" }] }),
        ]),
    });

    const summary = await runIngestCrossref(client, { dryRun: false, facultyWpId: "1" });

    expect(summary.candidatesSeen).toBe(0); // never became a "candidate" the merge engine saw
    expect(summary.merged).toBe(0);
    expect(summary.insertedNew).toBe(0);
    expect(summary.rejectedBySurnameGate).toBe(1);
    expect(summary.rejectedBySurnameGateByFaculty).toEqual([{ wpId: "1", displayName: "Adams, A.", count: 1 }]);

    const pubs = await client.execute("SELECT COUNT(*) as n FROM publications");
    expect(pubs.rows[0].n).toBe(0); // no row ever created for the unrelated paper
  });

  it("a genuinely new candidate inserts with status = 'pending_merge', never needs_metadata", async () => {
    await seedFaculty("1", "Zraick, R.I.", "Richard I. Zraick");

    stubFetch({
      "Richard I. Zraick": () =>
        searchResponse([crossrefItem({ doi: "10.1234/brand-new", title: "A Brand New Paper", authors: [{ given: "Richard", family: "Zraick" }] })]),
    });

    const summary = await runIngestCrossref(client, { dryRun: false, facultyWpId: "1" });

    expect(summary.insertedNew).toBe(1);
    expect(summary.merged).toBe(0);

    const pubs = await client.execute("SELECT doi, status, source FROM publications WHERE doi = '10.1234/brand-new'");
    expect(pubs.rows).toHaveLength(1);
    expect(pubs.rows[0].status).toBe("pending_merge");
    expect(pubs.rows[0].source).toBe("crossref");
  });

  it("running the identical candidate set twice produces the same DB state (idempotency)", async () => {
    await seedFaculty("1", "Zraick, R.I.", "Richard I. Zraick");

    stubFetch({
      "Richard I. Zraick": () =>
        searchResponse([crossrefItem({ doi: "10.1234/repeat", title: "A Repeated Paper", authors: [{ given: "Richard", family: "Zraick" }] })]),
    });

    const first = await runIngestCrossref(client, { dryRun: false, facultyWpId: "1" });
    expect(first.insertedNew).toBe(1);

    const second = await runIngestCrossref(client, { dryRun: false, facultyWpId: "1" });
    expect(second.insertedNew).toBe(0);
    expect(second.merged).toBe(1);

    const pubs = await client.execute("SELECT COUNT(*) as n FROM publications WHERE doi = '10.1234/repeat'");
    expect(pubs.rows[0].n).toBe(1);
    const authors = await client.execute("SELECT COUNT(*) as n FROM publication_authors");
    expect(authors.rows[0].n).toBe(1); // no duplicate author row either
  });

  it("an author matching a faculty row gets linked and role = 'chps_faculty'; an unmatched author stays unlinked", async () => {
    const facultyId = await seedFaculty("1", "Zraick, R.I.", "Richard I. Zraick");

    stubFetch({
      "Richard I. Zraick": () =>
        searchResponse([
          crossrefItem({
            doi: "10.1234/coauthored",
            title: "A Coauthored Paper",
            authors: [
              { given: "Richard", family: "Zraick" },
              { given: "Xavier", family: "Nobody" },
            ],
          }),
        ]),
    });

    await runIngestCrossref(client, { dryRun: false, facultyWpId: "1" });

    const authors = await client.execute("SELECT name, faculty_id, role FROM publication_authors ORDER BY position");
    expect(authors.rows).toHaveLength(2);
    expect(authors.rows[0]).toMatchObject({ faculty_id: facultyId, role: "chps_faculty" });
    expect(authors.rows[1]).toMatchObject({ faculty_id: null, role: "unknown" });
  });

  it("a name-only match (family+initial, no ORCID cross-check) whose Crossref affiliation string doesn't mention UCF is flagged 'unconfirmed', named with the paper and faculty member — not blocked, still inserted", async () => {
    // The real case that motivated this: a marine-fisheries paper's
    // "Adams, A." author matched Alauna Adams (School of Social Work) on
    // family+initial alone. Her real affiliation would never appear here.
    await seedFaculty("1", "Adams, A.", "Alauna Adams");

    stubFetch({
      "Alauna Adams": () =>
        searchResponse([
          crossrefItem({
            doi: "10.1/fisheries",
            title: "Evaluation of the Flats Fishery in the Yucatan Peninsula",
            authors: [{ given: "A.", family: "Adams", affiliation: "Bonefish & Tarpon Trust, Coral Gables, FL" }],
          }),
        ]),
    });

    const summary = await runIngestCrossref(client, { dryRun: false, facultyWpId: "1" });

    expect(summary.insertedNew).toBe(1); // not blocked — this is informational only
    expect(summary.nameOnlyMatchUnconfirmed).toEqual([
      {
        publicationTitle: "Evaluation of the Flats Fishery in the Yucatan Peninsula",
        facultyWpId: "1",
        facultyDisplayName: "Adams, A.",
        affiliation: "Bonefish & Tarpon Trust, Coral Gables, FL",
      },
    ]);
  });

  it("a name-only match whose Crossref affiliation string DOES mention a UCF variant is not flagged", async () => {
    await seedFaculty("1", "Zraick, R.I.", "Richard I. Zraick");

    stubFetch({
      "Richard I. Zraick": () =>
        searchResponse([
          crossrefItem({
            doi: "10.1/ucf-confirmed",
            title: "A Paper With Confirmed UCF Affiliation",
            authors: [{ given: "Richard", family: "Zraick", affiliation: "University of Central Florida, Orlando, FL, USA" }],
          }),
        ]),
    });

    const summary = await runIngestCrossref(client, { dryRun: false, facultyWpId: "1" });

    expect(summary.insertedNew).toBe(1);
    expect(summary.nameOnlyMatchUnconfirmed).toEqual([]);
  });

  it("a name-only match with no affiliation string at all is flagged, with affiliation reported as null", async () => {
    await seedFaculty("1", "Zraick, R.I.", "Richard I. Zraick");

    stubFetch({
      "Richard I. Zraick": () =>
        searchResponse([crossrefItem({ doi: "10.1/no-affiliation", title: "A Paper With No Affiliation Data", authors: [{ given: "Richard", family: "Zraick" }] })]),
    });

    const summary = await runIngestCrossref(client, { dryRun: false, facultyWpId: "1" });

    expect(summary.nameOnlyMatchUnconfirmed).toEqual([
      { publicationTitle: "A Paper With No Affiliation Data", facultyWpId: "1", facultyDisplayName: "Zraick, R.I.", affiliation: null },
    ]);
  });

  it(
    "a CrossrefUnavailableError from one faculty member's query doesn't abort the loop — the run continues and reports the rest normally",
    async () => {
      await seedFaculty("1", "Zraick, R.I.", "Richard I. Zraick");
      await seedFaculty("2", "Second, A.", "Alice Second");

      stubFetch({
        "Richard I. Zraick": () => new Response("server error", { status: 500 }),
        "Alice Second": () => searchResponse([crossrefItem({ doi: "10.1234/alice-paper", title: "Alice's Paper", authors: [{ given: "Alice", family: "Second" }] })]),
      });

      const summary = await runIngestCrossref(client, { dryRun: false, facultyWpId: null });

      expect(summary.facultySwept).toBe(2);
      expect(summary.skippedFaculty).toEqual([{ wpId: "1", displayName: "Zraick, R.I.", error: expect.any(String) }]);
      // Alice's candidate still got processed normally despite Richard's outage.
      expect(summary.candidatesSeen).toBe(1);
      expect(summary.insertedNew).toBe(1);

      const pubs = await client.execute("SELECT doi FROM publications");
      expect(pubs.rows).toEqual([{ doi: "10.1234/alice-paper" }]);
    },
    15000 // the 500 exhausts fetchWithRetry's real backoff budget (~3.5-5s), same cost as tests/crossref.test.ts's own retry-exhaustion tests
  );
});
