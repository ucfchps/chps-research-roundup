// Phase 5 hardening, Session 3, item B (cross-job re-run). Every existing
// idempotency test re-runs the SAME job twice. None of them prove that a
// record created by one source and later re-seen by a DIFFERENT source
// merges instead of duplicating — the real, everyday shape (a paper first
// picked up by ingest-crossref's author sweep, then re-seen a day later by
// ingest-pubmed-orcid's PubMed sweep for the same faculty member) is
// genuinely untested. tests/ingest-pubmed-orcid.test.ts has a merge test
// between ORCID and PubMed, but that's two sources INSIDE one job/one run —
// not a genuine cross-SCRIPT A -> B -> A sequence against a real DB across
// separate invocations, which is what this file adds.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/test-db";
import { snapshotTables } from "../helpers/snapshot";
import { assertReRunInvariants } from "../helpers/invariants";
import { seedFaculty } from "../helpers/fixtures";

process.env.CROSSREF_MAILTO ??= "test@example.com";
const { runIngestCrossref } = await import("../../scripts/ingest-crossref");
const { runIngestPubmedOrcid } = await import("../../scripts/ingest-pubmed-orcid");

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const SHARED_DOI = "10.1234/cross-job-shared-paper";
const SHARED_TITLE = "A Paper Discovered By Two Different Sources";

function crossrefItem() {
  return {
    DOI: SHARED_DOI,
    title: [SHARED_TITLE],
    type: "journal-article",
    author: [{ given: "Richard", family: "Zraick", affiliation: [{ name: "University of Central Florida" }] }],
    "container-title": ["Original Journal"],
    volume: "1", issue: "1", page: "1-10",
    issued: { "date-parts": [[2026]] },
  };
}

describe("B — cross-job re-run: Crossref discovers it, PubMed re-sees it, Crossref sweeps again", () => {
  let db: TestDb;
  let facultyWpId: string;

  beforeEach(async () => {
    db = await createTestDb();
    facultyWpId = "1";
    await seedFaculty(db.client, { wp_id: facultyWpId, display_name: "Zraick, R.I.", full_name: "Richard I. Zraick" });
  });

  afterEach(async () => {
    await db.teardown();
    vi.unstubAllGlobals();
  });

  it("a Crossref-discovered publication re-seen by ingest-pubmed-orcid's PubMed sweep merges into the SAME row, then a third Crossref sweep changes nothing further", async () => {
    // Step A: ingest-crossref discovers and inserts the paper.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.match(/query\.author=/)) return jsonResponse({ message: { items: [crossrefItem()] } });
        throw new Error(`unexpected fetch (step A): ${url}`);
      })
    );
    const stepA = await runIngestCrossref(db.client, { dryRun: false, facultyWpId });
    expect(stepA.insertedNew).toBe(1);

    const afterA = await db.client.execute("SELECT id, doi, source FROM publications");
    expect(afterA.rows).toHaveLength(1);
    expect(afterA.rows[0]).toMatchObject({ doi: SHARED_DOI, source: "crossref" });
    const publicationId = afterA.rows[0].id;

    // Step B: ingest-pubmed-orcid's PubMed sweep re-discovers the SAME DOI
    // for the same faculty member — findMatch's DOI ladder must merge this
    // into the existing row, not create a second one.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("esearch.fcgi")) return jsonResponse({ esearchresult: { idlist: ["999"] } });
        if (url.includes("esummary.fcgi")) {
          return jsonResponse({
            result: {
              uids: ["999"],
              "999": {
                uid: "999", pubdate: "2026 Jul 2", fulljournalname: "Original Journal", title: SHARED_TITLE,
                volume: "1", issue: "1", pages: "1-10", authors: [{ name: "Zraick R", authtype: "Author" }],
                articleids: [{ idtype: "doi", value: SHARED_DOI }],
              },
            },
          });
        }
        throw new Error(`unexpected fetch (step B): ${url}`);
      })
    );
    const stepB = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId });
    expect(stepB.insertedNew).toBe(0);
    expect(stepB.merged).toBe(1); // merged into A's row, not duplicated

    const afterB = await db.client.execute("SELECT id, doi FROM publications");
    expect(afterB.rows).toHaveLength(1); // still exactly one row
    expect(afterB.rows[0].id).toBe(publicationId); // the SAME row A created

    // Step A': re-run ingest-crossref one more time with the identical
    // candidate. Full A -> B -> A convergence: nothing should move.
    const beforeSecondA = await snapshotTables(db.client);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.match(/query\.author=/)) return jsonResponse({ message: { items: [crossrefItem()] } });
        throw new Error(`unexpected fetch (step A'): ${url}`);
      })
    );
    const stepA2 = await runIngestCrossref(db.client, { dryRun: false, facultyWpId });
    const afterSecondA = await snapshotTables(db.client);

    expect(stepA2.insertedNew).toBe(0);
    expect(stepA2.merged).toBe(1);
    expect(() => assertReRunInvariants(beforeSecondA, afterSecondA)).not.toThrow();

    const finalPubs = await db.client.execute("SELECT COUNT(*) as n FROM publications");
    expect(finalPubs.rows[0].n).toBe(1);
    const finalAuthors = await db.client.execute("SELECT COUNT(*) as n FROM publication_authors");
    expect(finalAuthors.rows[0].n).toBe(1); // no duplicate author row across all three runs
  });
});
