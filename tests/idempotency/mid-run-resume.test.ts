// Phase 5 hardening, Session 3, item C (mid-run failure and resume).
// Load-bearing for ingest-pubmed-orcid specifically: docs/phase5-surface-inventory.md's
// Discrepancies section documents 13 consecutive real CI timeouts at exactly
// `timeout-minutes: 30`, every one restarting from roster position 1 with no
// resume state — runIngestPubmedOrcid's own loop (`for (const f of scoped) {
// ...await sweepOrcid...; await sweepPubmed...; }`) has no outer try/catch
// and no checkpoint written anywhere (no "last processed wp_id" in settings
// or otherwise). This test proves what actually makes that safe in
// production: not a resume mechanism (there isn't one), but the merge
// engine's own idempotency — a full restart-from-scratch after a mid-run
// crash converges to the exact same final state a single uninterrupted run
// would have produced, because every already-applied candidate re-merges
// into its own row instead of duplicating.
//
// Method note: a genuine CI-timeout/process-kill has no JS-catchable shape —
// it just stops the process mid-loop. Simulating it by throwing from the
// fetch mock turned out to be the WRONG model here: every real external I/O
// call in this job's per-faculty path (ORCID, Crossref DOI resolution,
// PubMed) is already routed through fetchWithRetry and wrapped in its own
// Unavailable error, caught per-faculty by sweepOrcid/sweepPubmed — so an
// injected fetch failure just exercises that existing graceful-skip path,
// not an abrupt kill. The faithful way to model "the process died after
// faculty #1" is to actually stop after faculty #1: run the job scoped to
// just that one faculty member (as if the process were killed the instant
// after committing that work), then run the real restart — the unscoped job
// again from the top, exactly what production actually does on the next
// scheduled invocation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/test-db";
import { seedFaculty } from "../helpers/fixtures";

process.env.CROSSREF_MAILTO ??= "test@example.com";
const { runIngestPubmedOrcid } = await import("../../scripts/ingest-pubmed-orcid");

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const FACULTY = [
  { wpId: "1", displayName: "Alpha, A.", fullName: "Alice Alpha", uid: "101", doi: "10.1/alpha-paper", title: "Alpha's Paper" },
  { wpId: "2", displayName: "Bravo, B.", fullName: "Bob Bravo", uid: "102", doi: "10.1/bravo-paper", title: "Bravo's Paper" },
  { wpId: "3", displayName: "Charlie, C.", fullName: "Carol Charlie", uid: "103", doi: "10.1/charlie-paper", title: "Charlie's Paper" },
];

// esearch calls happen in roster order (one per faculty member, no
// affiliation/uid in the query) — route by call order rather than trying to
// pattern-match the URL, and let esummary route by the uid it's actually
// asked for.
function stubEsearchEsummaryByCallOrder(faculty: typeof FACULTY) {
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.includes("esearch.fcgi")) {
        const f = faculty[n];
        n++;
        return jsonResponse({ esearchresult: { idlist: [f.uid] } });
      }
      if (url.includes("esummary.fcgi")) {
        const uid = new URL(url).searchParams.get("id");
        const f = faculty.find((ff) => ff.uid === uid)!;
        return jsonResponse({
          result: {
            uids: [f.uid],
            [f.uid]: {
              uid: f.uid, pubdate: "2026 Jul 2", fulljournalname: "J", title: f.title,
              authors: [{ name: f.displayName.replace(",", ""), authtype: "Author" }], articleids: [{ idtype: "doi", value: f.doi }],
            },
          },
        });
      }
      if (url.includes("efetch.fcgi")) {
        // Session 12: sweepPubmed now efetches affiliation for genuinely new
        // candidates. This test's assertions are all about doi/title/merge
        // counts, not affiliation buckets — an empty AuthorList (no coded
        // affiliation, a real shape per tests/fixtures/api/pubmed-efetch-
        // old-no-affiliation.xml) is a valid, uneventful response here.
        const ids = new URL(url).searchParams.get("id")?.split(",") ?? [];
        const articles = ids.map((id) => `<PubmedArticle><MedlineCitation><PMID>${id}</PMID></MedlineCitation></PubmedArticle>`).join("");
        return new Response(`<PubmedArticleSet>${articles}</PubmedArticleSet>`, { status: 200 });
      }
      throw new Error(`unrouted: ${url}`);
    })
  );
}

describe("C — mid-run failure and resume (ingest-pubmed-orcid)", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    for (const f of FACULTY) {
      await seedFaculty(db.client, { wp_id: f.wpId, display_name: f.displayName, full_name: f.fullName, orcid: null });
    }
  });

  afterEach(async () => {
    await db.teardown();
    vi.unstubAllGlobals();
  });

  it("a crash after faculty #1 leaves #2 and #3 untouched; a full restart-from-scratch converges to the same final state as one clean uninterrupted run", async () => {
    // --- Reference run: a single, uninterrupted pass over all 3 faculty, on
    // a SEPARATE db, to know what "correct final state" looks like.
    const reference = await createTestDb();
    for (const f of FACULTY) await seedFaculty(reference.client, { wp_id: f.wpId, display_name: f.displayName, full_name: f.fullName, orcid: null });
    stubEsearchEsummaryByCallOrder(FACULTY);
    await runIngestPubmedOrcid(reference.client, { dryRun: false, facultyWpId: null });
    const referencePubs = (
      await reference.client.execute("SELECT doi, title FROM publications ORDER BY doi")
    ).rows.map((r) => ({ doi: r.doi, title: r.title }));
    await reference.teardown();
    vi.unstubAllGlobals();

    // --- Real sequence: the process gets through faculty #1 and is then
    // killed (modeled as scoping this invocation to faculty #1 only — see
    // the method note above for why an injected exception is the wrong model).
    stubEsearchEsummaryByCallOrder([FACULTY[0]]);
    const stepOne = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: FACULTY[0].wpId });
    expect(stepOne.insertedNew).toBe(1);
    vi.unstubAllGlobals();

    const afterCrash = (await db.client.execute("SELECT doi FROM publications")).rows.map((r) => r.doi);
    expect(afterCrash).toEqual(["10.1/alpha-paper"]); // only faculty #1 landed before the (simulated) kill

    // Restart from scratch — a real production restart is literally "run the
    // job again," roster position 1, with no memory of the interrupted run.
    stubEsearchEsummaryByCallOrder(FACULTY);
    const resumed = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: null });

    // Alpha's candidate re-arrives and MERGES (findMatch on DOI) rather than
    // duplicating — this is what actually makes "just restart it" safe.
    expect(resumed.merged).toBe(1); // alpha
    expect(resumed.insertedNew).toBe(2); // bravo, charlie — genuinely new this pass

    const finalPubs = (await db.client.execute("SELECT doi, title FROM publications ORDER BY doi")).rows.map((r) => ({ doi: r.doi, title: r.title }));
    expect(finalPubs).toHaveLength(3);
    expect(finalPubs).toEqual(referencePubs); // identical final state to the uninterrupted reference run
  }, 15000);
});
