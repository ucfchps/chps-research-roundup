// ops-notes.md §5/§6, §13 item 10 follow-up — step 8's key requirement: prove
// the three real ingestion entry points (Crossref-direct search, Scholar
// alert -> Crossref title resolution, ORCID work -> Crossref DOI resolution)
// all route through the SAME confirmation gate (buildAuthorInputs,
// lib/scholar-ingest.ts) and produce IDENTICAL role/role_set_by behavior for
// an identical author+affiliation input — not three separately-written
// assertions that could quietly drift apart. One shared fixture, reused
// verbatim in each ingester's own mocked Crossref response, driven through
// each ingester's actual exported entry point.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";

process.env.CROSSREF_MAILTO ??= "test@example.com";
process.env.GMAIL_CLIENT_ID ??= "id";
process.env.GMAIL_CLIENT_SECRET ??= "secret";
process.env.GMAIL_REFRESH_TOKEN ??= "refresh";
process.env.GMAIL_ALERT_QUERY ??= 'from:scholaralerts-noreply@google.com subject:"new articles"';
process.env.GMAIL_PROCESSED_LABEL_NAME ??= "roundup/processed";
process.env.GMAIL_PROCESSED_LABEL_ID ??= "Label_1";

const { runIngestCrossref } = await import("../scripts/ingest-crossref");
const { runIngestScholar } = await import("../scripts/ingest-scholar");
const { runIngestPubmedOrcid } = await import("../scripts/ingest-pubmed-orcid");
const { __resetTokenCacheForTests } = await import("../lib/gmail");

// ★ THE shared fixture: one CrossrefResolutionAuthor-shaped entry, reused
// verbatim (not re-typed) across all three ingesters' mocked Crossref
// responses below. A real, non-UCF-confirming affiliation string — the
// same class of evidence as the confirmed real "Zhu, Y." case
// (ops-notes.md §5) — so all three should independently land on
// role='unknown', role_set_by='ingest:unconfirmed_name_match_conflicting_affiliation'.
const SHARED_AUTHOR = { given: "Yong", family: "Zhu", affiliation: [{ name: "Department of Ophthalmology, University of Pennsylvania" }] };
const SHARED_TITLE = "A Shared-Fixture Test Paper";
const SHARED_DOI = "10.1/shared-fixture";

function crossrefWorksResponse(doi: string, title: string) {
  return new Response(
    JSON.stringify({
      message: {
        items: [
          {
            DOI: doi,
            title: [title],
            type: "journal-article",
            author: [SHARED_AUTHOR],
            "container-title": ["Test Journal"],
            volume: "1",
            issue: "1",
            page: "1-10",
            issued: { "date-parts": [[2026]] },
          },
        ],
      },
    }),
    { status: 200 }
  );
}

function crossrefWorkResponse(doi: string, title: string) {
  return new Response(
    JSON.stringify({
      message: {
        DOI: doi,
        title: [title],
        type: "journal-article",
        author: [SHARED_AUTHOR],
        "container-title": ["Test Journal"],
        volume: "1",
        issue: "1",
        page: "1-10",
        issued: { "date-parts": [[2026]] },
      },
    }),
    { status: 200 }
  );
}

async function seedFaculty(client: Client, wpId: string, displayName: string, fullName: string, orcid: string | null, scholarUserId: string | null): Promise<number> {
  const result = await client.execute({
    sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, orcid, scholar_user_id, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    args: [wpId, wpId, displayName, fullName, `${wpId}@example.com`, "Department of Health Sciences", orcid, scholarUserId],
  });
  return Number(result.lastInsertRowid);
}

async function freshDb(): Promise<{ dir: string; client: Client }> {
  const dir = mkdtempSync(path.join(tmpdir(), "shared-gate-test-"));
  const client = createClient({ url: `file:${path.join(dir, "test.db")}` });
  await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  return { dir, client };
}

interface Outcome {
  role: string;
  roleSetBy: string;
}

async function readOutcome(client: Client): Promise<Outcome> {
  const rows = await client.execute("SELECT role, role_set_by FROM publication_authors WHERE name = 'Zhu, Y.'");
  expect(rows.rows).toHaveLength(1);
  return { role: String(rows.rows[0].role), roleSetBy: String(rows.rows[0].role_set_by) };
}

describe("shared confirmation gate — identical outcome across all three real ingestion entry points", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Crossref-direct search (scripts/ingest-crossref.ts)", async () => {
    const { dir, client } = await freshDb();
    try {
      await seedFaculty(client, "1", "Zhu, Y.", "Yong Zhu", null, null);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => crossrefWorksResponse(SHARED_DOI, SHARED_TITLE))
      );

      await runIngestCrossref(client, { dryRun: false, facultyWpId: "1" });
      expect(await readOutcome(client)).toEqual({ role: "unknown", roleSetBy: "ingest:unconfirmed_name_match_conflicting_affiliation" });
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ORCID work resolved by DOI via Crossref (scripts/ingest-pubmed-orcid.ts)", async () => {
    const { dir, client } = await freshDb();
    try {
      await seedFaculty(client, "1", "Zhu, Y.", "Yong Zhu", "0000-0000-0000-0001", null);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("pub.orcid.org")) {
            return new Response(
              JSON.stringify({
                group: [
                  {
                    "external-ids": { "external-id": [{ "external-id-type": "doi", "external-id-value": SHARED_DOI }] },
                    "work-summary": [
                      { type: "journal-article", title: { title: { value: SHARED_TITLE } }, "publication-date": { year: { value: "2026" } }, url: { value: `https://doi.org/${SHARED_DOI}` } },
                    ],
                  },
                ],
              }),
              { status: 200 }
            );
          }
          if (url.includes("api.crossref.org/works/")) return crossrefWorkResponse(SHARED_DOI, SHARED_TITLE);
          if (url.includes("esearch.fcgi")) return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 });
          if (url.includes("esummary.fcgi")) return new Response(JSON.stringify({ result: { uids: [] } }), { status: 200 });
          throw new Error(`unexpected fetch: ${url}`);
        })
      );

      await runIngestPubmedOrcid(client, { dryRun: false, facultyWpId: "1" });
      expect(await readOutcome(client)).toEqual({ role: "unknown", roleSetBy: "ingest:unconfirmed_name_match_conflicting_affiliation" });
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Scholar alert resolved by title via Crossref (scripts/ingest-scholar.ts)", async () => {
    const { dir, client } = await freshDb();
    try {
      await seedFaculty(client, "1", "Zhu, Y.", "Yong Zhu", null, "ZhuScholarId1");
      __resetTokenCacheForTests();

      const gmailMessage = {
        id: "msg-1",
        threadId: "msg-1",
        payload: {
          mimeType: "text/html",
          headers: [{ name: "Subject", value: "Yong Zhu - new articles" }],
          body: {
            data: Buffer.from(
              `<div><h3><a href="https://scholar.google.com/scholar_url?url=x" class="gse_alrt_title">${SHARED_TITLE}</a></h3>
               <div>Y Zhu - Test Journal, 2026</div>
               <p>This message was sent by Google Scholar because you're following new articles written by
               <a href="https://scholar.google.com/citations?hl=en&user=ZhuScholarId1">Yong Zhu</a>.</p></div>`,
              "utf-8"
            ).toString("base64url"),
          },
        },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
          if (url.includes("/messages?")) return new Response(JSON.stringify({ messages: [{ id: "msg-1" }] }), { status: 200 });
          if (url.match(/\/messages\/([^/?]+)\?format=full/)) return new Response(JSON.stringify(gmailMessage), { status: 200 });
          if (url.match(/\/messages\/([^/]+)\/modify/)) return new Response(JSON.stringify({}), { status: 200 });
          if (url.startsWith("https://api.crossref.org/works?")) return crossrefWorksResponse(SHARED_DOI, SHARED_TITLE);
          throw new Error(`unexpected fetch: ${url}`);
        })
      );

      await runIngestScholar(client, { dryRun: false, limit: null });
      expect(await readOutcome(client)).toEqual({ role: "unknown", roleSetBy: "ingest:unconfirmed_name_match_conflicting_affiliation" });
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
