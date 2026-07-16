// The test this project exists for: two alerts, two different CHPS faculty,
// same paper -> ONE publication row, both linked as chps_faculty. Uses the
// real pair-citation-tag-schellhase / pair-normal-tag-mangum fixtures (see
// docs/scholar-alert-notes.md §3-4) — same paper, two different faculty
// followers, two different email templates.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const { runIngestScholar } = await import("../scripts/ingest-scholar");
const { __resetTokenCacheForTests } = await import("../lib/gmail");

const FIXTURES_DIR = path.join(__dirname, "fixtures", "scholar-alerts");

function fixtureHtml(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, `${name}.decoded.html`), "utf-8");
}

function gmailMessageFor(id: string, subject: string, html: string) {
  const data = Buffer.from(html, "utf-8").toString("base64url");
  return {
    id,
    threadId: id,
    payload: { mimeType: "text/html", headers: [{ name: "Subject", value: subject }], body: { data } },
  };
}

const SCHELLHASE_MSG = gmailMessageFor(
  "msg-schellhase",
  "Kristen Couper Schellhase - new articles",
  fixtureHtml("pair-citation-tag-schellhase")
);
const MANGUM_MSG = gmailMessageFor(
  "msg-mangum",
  "L. Colby Mangum, PhD, ATC - new articles",
  fixtureHtml("pair-normal-tag-mangum")
);

// ★ Includes a "Mangum" family entry deliberately — not just Schellhase's
// truncated byline names. resolveByTitle's acceptance gate rejects a
// candidate whose author list doesn't contain the given surnameHint
// (lib/crossref.ts's authorListHasSurname), and the script calls
// resolveByTitle(title, year, "Mangum") for Mangum's own alert. Without this
// entry, Mangum's alert would silently resolve to `not_found` instead of
// exercising the real Crossref-author-list merge path this test exists to
// prove — the top-level counts would still happen to pass via an idempotent
// title-match merge instead, masking the gap. Position order doesn't matter
// for the test; this models the real paper's full (untruncated) author list,
// of which the Scholar alert bylines only ever show a truncated prefix.
const CROSSREF_ITEM = {
  DOI: "10.1123/ijatt.2025-0110",
  title: ["Exploring Job Satisfaction and Intention to Leave Among Athletic Trainers Working With Tactical Athletes in Military Clinical Practice Settings"],
  type: "journal-article",
  author: [
    { given: "Kristen C.", family: "Schellhase", affiliation: [] },
    { given: "W.", family: "Adam", affiliation: [] },
    { given: "A.", family: "Layne", affiliation: [] },
    { given: "L. Colby", family: "Mangum", affiliation: [] },
  ],
  "container-title": ["International Journal of Athletic Therapy and Training"],
  volume: "31", issue: "2", page: "88-95",
  issued: { "date-parts": [[2026]] },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("ingest-scholar integration", () => {
  let dbDir: string;
  let client: Client;
  let gmailInbox: Record<string, ReturnType<typeof gmailMessageFor>>;
  let appliedLabels: string[];

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "ingest-scholar-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));

    await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, scholar_user_id, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      args: ["1", "schellhase", "Schellhase, K.C.", "Kristen Couper Schellhase", "kcs@x.edu", "School of Kinesiology and Rehabilitation Sciences", "ez1ilMIAAAAJ"],
    });
    await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, scholar_user_id, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      args: ["2", "mangum", "Mangum, L.C.", "L. Colby Mangum", "lcm@x.edu", "School of Kinesiology and Rehabilitation Sciences", "5yIzMuQAAAAJ"],
    });

    __resetTokenCacheForTests();
    gmailInbox = { "msg-schellhase": SCHELLHASE_MSG, "msg-mangum": MANGUM_MSG };
    appliedLabels = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url === "https://oauth2.googleapis.com/token") {
          return jsonResponse({ access_token: "tok", expires_in: 3600 });
        }
        if (url.includes("/messages?")) {
          return jsonResponse({ messages: Object.keys(gmailInbox).map((id) => ({ id })) });
        }
        if (url.match(/\/messages\/([^/?]+)\?format=full/)) {
          const id = url.match(/\/messages\/([^/?]+)\?format=full/)![1];
          return jsonResponse(gmailInbox[id]);
        }
        if (url.match(/\/messages\/([^/]+)\/modify/)) {
          const id = url.match(/\/messages\/([^/]+)\/modify/)![1];
          appliedLabels.push(id);
          return jsonResponse({});
        }
        if (url.startsWith("https://api.crossref.org/works?")) {
          return jsonResponse({ message: { items: [CROSSREF_ITEM] } });
        }
        throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
      })
    );
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("two alerts, two faculty, same paper -> ONE publication row, both linked and chps_faculty", async () => {
    const summary = await runIngestScholar(client, { dryRun: false, limit: null });

    expect(summary.insertedNew).toBe(1);
    expect(summary.merged).toBe(1);

    const pubs = await client.execute("SELECT id, doi, status FROM publications");
    expect(pubs.rows).toHaveLength(1);
    expect(pubs.rows[0].doi).toBe("10.1123/ijatt.2025-0110");

    const authors = await client.execute({
      sql: "SELECT name, faculty_id, role FROM publication_authors WHERE publication_id = ? ORDER BY position",
      args: [pubs.rows[0].id],
    });
    const schellhase = authors.rows.find((a) => String(a.name).includes("Schellhase"));
    const mangum = authors.rows.find((a) => String(a.name).startsWith("Mangum"));
    expect(schellhase?.faculty_id).toBeTruthy();
    expect(schellhase?.role).toBe("chps_faculty");
    // ★ The test this task is named for: BOTH faculty end up linked on the
    // same record, not just the one who happened to insert it first.
    expect(mangum?.faculty_id).toBeTruthy();
    expect(mangum?.role).toBe("chps_faculty");

    expect(appliedLabels.sort()).toEqual(["msg-mangum", "msg-schellhase"]);
  });

  it("running the whole ingest twice over the same fixtures produces identical DB state (§9)", async () => {
    await runIngestScholar(client, { dryRun: false, limit: null });
    const firstPubs = await client.execute("SELECT COUNT(*) as n FROM publications");
    const firstAuthors = await client.execute("SELECT COUNT(*) as n FROM publication_authors");

    // Re-run against the SAME inbox — simulates the label write having failed
    // (§9: idempotency rests on title/DOI matching, never on message ID or
    // the label itself).
    __resetTokenCacheForTests();
    const second = await runIngestScholar(client, { dryRun: false, limit: null });

    const secondPubs = await client.execute("SELECT COUNT(*) as n FROM publications");
    const secondAuthors = await client.execute("SELECT COUNT(*) as n FROM publication_authors");

    expect(secondPubs.rows[0].n).toBe(firstPubs.rows[0].n);
    expect(secondAuthors.rows[0].n).toBe(firstAuthors.rows[0].n);
    expect(second.insertedNew).toBe(0);
  });

  it("a human-set grad_student role on an existing record survives a re-ingest of the same paper (§15.4)", async () => {
    await runIngestScholar(client, { dryRun: false, limit: null });

    const pubs = await client.execute("SELECT id FROM publications");
    const publicationId = pubs.rows[0].id;
    await client.execute({
      sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position)
            VALUES (?, NULL, 'Grad, S.', 'grad_student', 'faculty:1', ?, 99)`,
      args: [publicationId, new Date().toISOString()],
    });

    __resetTokenCacheForTests();
    await runIngestScholar(client, { dryRun: false, limit: null });

    const grad = await client.execute({
      sql: "SELECT role, role_set_by FROM publication_authors WHERE name = 'Grad, S.'",
      args: [],
    });
    expect(grad.rows[0].role).toBe("grad_student");
    expect(grad.rows[0].role_set_by).toBe("faculty:1");
  });

  it("--dry-run writes nothing and labels nothing", async () => {
    const summary = await runIngestScholar(client, { dryRun: true, limit: null });

    expect(summary.insertedNew + summary.merged).toBeGreaterThan(0); // decisions were computed
    const pubs = await client.execute("SELECT COUNT(*) as n FROM publications");
    expect(pubs.rows[0].n).toBe(0); // nothing persisted
    expect(appliedLabels).toHaveLength(0); // nothing labeled
  });
});
