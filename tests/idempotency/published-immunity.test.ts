// Phase 5 hardening, Session 3, item I (published-record immunity — §6b:
// "a published record is permanently settled"). tests/refresh-metadata.test.ts
// already covers this for refresh-metadata ("a publication with roundup_id
// set is not selected by either query"). This file covers the three
// remaining jobs — ingest-scholar, ingest-crossref, ingest-pubmed-orcid —
// none of which had a test proving a re-discovery of an ALREADY-PUBLISHED
// paper (a real shape: Crossref/PubMed/a Scholar alert can all still surface
// a paper long after its roundup shipped) leaves roundup_id/status/released_at
// alone. The merge engine supports this by construction
// (promoteFromNeedsMetadata only ever promotes FROM needs_metadata; nothing
// else in the merge path writes status) — this proves it holds through the
// real orchestration, not just by reading the code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/test-db";
import { seedFaculty, seedPublication, seedRoundup } from "../helpers/fixtures";

process.env.CROSSREF_MAILTO ??= "test@example.com";
process.env.GMAIL_CLIENT_ID ??= "id";
process.env.GMAIL_CLIENT_SECRET ??= "secret";
process.env.GMAIL_REFRESH_TOKEN ??= "refresh";
process.env.GMAIL_ALERT_QUERY ??= 'from:scholaralerts-noreply@google.com subject:"new articles"';
process.env.GMAIL_PROCESSED_LABEL_NAME ??= "roundup/processed";
process.env.GMAIL_PROCESSED_LABEL_ID ??= "Label_1";

const { runIngestCrossref } = await import("../../scripts/ingest-crossref");
const { runIngestPubmedOrcid } = await import("../../scripts/ingest-pubmed-orcid");
const { runIngestScholar } = await import("../../scripts/ingest-scholar");
const { __resetTokenCacheForTests } = await import("../../lib/gmail");

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const PUBLISHED_DOI = "10.1234/already-in-a-roundup";
const PUBLISHED_TITLE = "A Paper That Already Shipped In A Prior Roundup";

describe("I — published-record immunity, ingest-scholar / ingest-crossref / ingest-pubmed-orcid", () => {
  let db: TestDb;
  let roundupId: number;
  let publicationId: number;

  beforeEach(async () => {
    db = await createTestDb();
    roundupId = await seedRoundup(db.client);
    publicationId = await seedPublication(db.client, {
      doi: PUBLISHED_DOI, title: PUBLISHED_TITLE, status: "published", roundup_id: roundupId, released_at: "2026-01-01T00:00:00.000Z",
    });
  });

  afterEach(async () => {
    await db.teardown();
    vi.unstubAllGlobals();
  });

  it("ingest-crossref re-discovering the DOI merges metadata but leaves roundup_id/status/released_at untouched", async () => {
    await seedFaculty(db.client, { wp_id: "1", display_name: "Zraick, R.I.", full_name: "Richard I. Zraick" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.match(/query\.author=/)) {
          return jsonResponse({
            message: {
              items: [
                {
                  DOI: PUBLISHED_DOI, title: [PUBLISHED_TITLE], type: "journal-article",
                  author: [{ given: "Richard", family: "Zraick", affiliation: [{ name: "University of Central Florida" }] }],
                  "container-title": ["A Different Journal Name This Time"], volume: "9", issue: "9", page: "9-99",
                  issued: { "date-parts": [[2026]] },
                },
              ],
            },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    // Not assertReRunInvariants here — this ISN'T a repeat of an identical
    // operation. A genuinely new author link (Zraick, never linked to this
    // paper before) is legitimately being added for the first time, so
    // publication_authors' row count DOES change by design; that's real
    // work, not drift. What item I actually claims is narrower: the
    // publications row's own settled fields never move.
    const summary = await runIngestCrossref(db.client, { dryRun: false, facultyWpId: "1" });

    expect(summary.merged).toBe(1);
    expect(summary.insertedNew).toBe(0);

    const row = (await db.client.execute({ sql: "SELECT status, roundup_id, released_at FROM publications WHERE id = ?", args: [publicationId] })).rows[0];
    expect(row).toMatchObject({ status: "published", roundup_id: roundupId, released_at: "2026-01-01T00:00:00.000Z" });
  });

  it("ingest-pubmed-orcid re-discovering the DOI via PubMed merges metadata but leaves roundup_id/status/released_at untouched", async () => {
    await seedFaculty(db.client, { wp_id: "1", display_name: "Stock, M.S.", full_name: "Matt Stock", orcid: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("esearch.fcgi")) return jsonResponse({ esearchresult: { idlist: ["555"] } });
        if (url.includes("esummary.fcgi")) {
          return jsonResponse({
            result: {
              uids: ["555"],
              "555": {
                uid: "555", pubdate: "2026 Jul 2", fulljournalname: "A Different Journal Name This Time", title: PUBLISHED_TITLE,
                authors: [{ name: "Stock MS", authtype: "Author" }], articleids: [{ idtype: "doi", value: PUBLISHED_DOI }],
              },
            },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const summary = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: "1" });

    expect(summary.merged).toBe(1);
    expect(summary.insertedNew).toBe(0);

    const row = (await db.client.execute({ sql: "SELECT status, roundup_id, released_at FROM publications WHERE id = ?", args: [publicationId] })).rows[0];
    expect(row).toMatchObject({ status: "published", roundup_id: roundupId, released_at: "2026-01-01T00:00:00.000Z" });
  });

  it("ingest-scholar re-discovering the same paper via a fresh alert merges metadata but leaves roundup_id/status/released_at untouched", async () => {
    const facultyInsert = await db.client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, scholar_user_id, active)
            VALUES ('1', 'stock', 'Stock, M.S.', 'Matt Stock', 'm@x.edu', 'Department of Health Sciences', 'hs_VC0kAAAAJ', 1)`,
      args: [],
    });
    void facultyInsert;

    const html = `<html><body>
      <h3><a class="gse_alrt_title" href="https://example.org/x">${PUBLISHED_TITLE}</a></h3>
      <div style="color:#006621">M Stock - A Different Journal Name This Time, 2026</div>
      <p>This message was sent by Google Scholar because you're following new articles written by
      <a href="https://scholar.google.com/citations?hl=en&user=hs_VC0kAAAAJ">Matt Stock</a>.</p>
    </body></html>`;
    const data = Buffer.from(html, "utf-8").toString("base64url");
    const message = { id: "msg-1", threadId: "msg-1", payload: { mimeType: "text/html", headers: [{ name: "Subject", value: "Matt Stock - new articles" }], body: { data } } };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "tok", expires_in: 3600 });
        if (url.includes("/messages?")) return jsonResponse({ messages: [{ id: "msg-1" }] });
        if (url.match(/\/messages\/msg-1\?format=full/)) return jsonResponse(message);
        if (url.match(/\/messages\/msg-1\/modify/)) return jsonResponse({});
        if (url.startsWith("https://api.crossref.org/works?")) {
          return jsonResponse({
            message: {
              items: [
                {
                  DOI: PUBLISHED_DOI, title: [PUBLISHED_TITLE], type: "journal-article",
                  author: [{ given: "Matt", family: "Stock", affiliation: [{ name: "University of Central Florida" }] }],
                  "container-title": ["A Different Journal Name This Time"], volume: "1", issue: "1", page: "1-10",
                  issued: { "date-parts": [[2026]] },
                },
              ],
            },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    __resetTokenCacheForTests();
    const summary = await runIngestScholar(db.client, { dryRun: false, limit: null });

    expect(summary.merged).toBe(1);
    expect(summary.insertedNew).toBe(0);

    const row = (await db.client.execute({ sql: "SELECT status, roundup_id, released_at FROM publications WHERE id = ?", args: [publicationId] })).rows[0];
    expect(row).toMatchObject({ status: "published", roundup_id: roundupId, released_at: "2026-01-01T00:00:00.000Z" });
  });
});
