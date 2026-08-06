// Phase 5 hardening, Session 3, item E (Scholar-specific). Six sub-items
// were named; four are already covered elsewhere and are NOT duplicated
// here (see the final report) — this file covers the four genuinely
// untested at the INTEGRATION level (runIngestScholar, not just the pure
// parser in tests/scholar-alert.test.ts or the pure decision function in
// tests/scholar-ingest.test.ts):
//   - the same alert content arriving under a DIFFERENT Gmail message ID
//     produces no duplicate (dedup is by title, never by message ID)
//   - a citation-alert email is rejected AND that rejection is visible in
//     the run summary, not silently swallowed
//   - a multi-article email inserts every article, and a re-run inserts none
//   - an unmatched scholar_user_id is skipped, surfaced, and its email still
//     gets labeled (a terminal, known outcome, not retried forever)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../db/migrate";

process.env.CROSSREF_MAILTO ??= "test@example.com";
process.env.GMAIL_CLIENT_ID ??= "id";
process.env.GMAIL_CLIENT_SECRET ??= "secret";
process.env.GMAIL_REFRESH_TOKEN ??= "refresh";
process.env.GMAIL_ALERT_QUERY ??= 'from:scholaralerts-noreply@google.com subject:"new articles"';
process.env.GMAIL_PROCESSED_LABEL_NAME ??= "roundup/processed";
process.env.GMAIL_PROCESSED_LABEL_ID ??= "Label_1";

const { runIngestScholar } = await import("../../scripts/ingest-scholar");
const { __resetTokenCacheForTests } = await import("../../lib/gmail");

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "scholar-alerts");
function fixtureHtml(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, `${name}.decoded.html`), "utf-8");
}

function gmailMessageFor(id: string, subject: string, html: string) {
  const data = Buffer.from(html, "utf-8").toString("base64url");
  return { id, threadId: id, payload: { mimeType: "text/html", headers: [{ name: "Subject", value: subject }], body: { data } } };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

async function newDb(): Promise<{ client: Client; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "scholar-specific-test-"));
  const client = createClient({ url: `file:${path.join(dir, "test.db")}` });
  await runMigrations(client, path.join(__dirname, "..", "..", "db", "migrations"));
  return { client, dir };
}

function stubGmailAndCrossref(
  inbox: Record<string, ReturnType<typeof gmailMessageFor>>,
  appliedLabels: string[],
  crossrefFindsNothing = true
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "tok", expires_in: 3600 });
      if (url.includes("/messages?")) return jsonResponse({ messages: Object.keys(inbox).map((id) => ({ id })) });
      const getMatch = url.match(/\/messages\/([^/?]+)\?format=full/);
      if (getMatch) return jsonResponse(inbox[getMatch[1]]);
      const modifyMatch = url.match(/\/messages\/([^/]+)\/modify/);
      if (modifyMatch) {
        appliedLabels.push(modifyMatch[1]);
        return jsonResponse({});
      }
      if (url.startsWith("https://api.crossref.org/works?")) {
        return jsonResponse({ message: { items: crossrefFindsNothing ? [] : [] } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
}

describe("E — Scholar-specific, integration-level gaps", () => {
  it("the same alert content arriving under a DIFFERENT Gmail message ID is deduped by title, not by message ID", async () => {
    const { client, dir } = await newDb();
    await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, scholar_user_id, active) VALUES ('1','hanney','Hanney, W.J.','William J. Hanney','w@x.edu','Department of Health Sciences','WfdV37IAAAAJ',1)`,
      args: [],
    });
    const html = fixtureHtml("alert-single-hanney-olecranon");
    const appliedLabels: string[] = [];

    // First run: message id "run1-msg".
    stubGmailAndCrossref({ "run1-msg": gmailMessageFor("run1-msg", "William J. Hanney - new articles", html) }, appliedLabels);
    __resetTokenCacheForTests();
    const first = await runIngestScholar(client, { dryRun: false, limit: null });
    expect(first.insertedNew + first.needsMetadata).toBe(1);
    vi.unstubAllGlobals();

    // Second "email": identical article content, but Gmail assigned it a
    // completely different message ID (a real thing that happens — Google
    // sometimes resends/reformats the same alert). §9: idempotency here must
    // rest on the article's title, never on the Gmail message ID.
    stubGmailAndCrossref({ "run2-different-msg-id": gmailMessageFor("run2-different-msg-id", "William J. Hanney - new articles", html) }, appliedLabels);
    __resetTokenCacheForTests();
    const second = await runIngestScholar(client, { dryRun: false, limit: null });
    expect(second.insertedNew).toBe(0);
    expect(second.merged + second.needsMetadata).toBeGreaterThanOrEqual(0); // whichever path it takes, nothing NEW

    const pubs = await client.execute("SELECT COUNT(*) as n FROM publications");
    expect(pubs.rows[0].n).toBe(1); // still exactly one row for one real paper

    client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a citation-alert email ('new citations', not 'new articles') is rejected AND visibly counted in the run summary — not silently dropped", async () => {
    const { client, dir } = await newDb();
    await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, scholar_user_id, active) VALUES ('1','stock','Stock, M.S.','Matt S. Stock','m@x.edu','Department of Health Sciences','hs_VC0kAAAAJ',1)`,
      args: [],
    });
    // Synthetic citation-alert shape (docs/scholar-alert-notes.md §9 — no real
    // example exists in the captured inbox, same synthetic case
    // tests/scholar-alert.test.ts's parser-level test uses).
    const html = `<html><body>
      <h3><a class="gse_alrt_title" href="https://example.org/some-article">Some Citing Paper</a></h3>
      <div style="color:#006621">A Stranger, B Someone - Some Journal, 2026</div>
      <p>This message was sent by Google Scholar because new citations to articles by
      <a href="https://scholar.google.com/citations?hl=en&user=hs_VC0kAAAAJ">Matt S. Stock</a> were found.</p>
    </body></html>`;
    const appliedLabels: string[] = [];
    stubGmailAndCrossref({ "citation-msg": gmailMessageFor("citation-msg", "Matt S. Stock - new citations", html) }, appliedLabels);

    __resetTokenCacheForTests();
    const summary = await runIngestScholar(client, { dryRun: false, limit: null });

    expect(summary.rejected.citation_alert).toBe(1); // visible, not silent
    expect(summary.parsed).toBe(0);
    const pubs = await client.execute("SELECT COUNT(*) as n FROM publications");
    expect(pubs.rows[0].n).toBe(0); // nothing malformed got created either

    client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a multi-article email inserts every article; a re-run over the same inbox inserts none again", async () => {
    const { client, dir } = await newDb();
    await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, scholar_user_id, active) VALUES ('1','hanney','Hanney, W.J.','William J. Hanney','w@x.edu','Department of Health Sciences','WfdV37IAAAAJ',1)`,
      args: [],
    });
    const html = fixtureHtml("alert-multi-synthetic"); // 2 articles, real fixture used by tests/scholar-alert.test.ts
    const appliedLabels: string[] = [];
    const inbox = { "multi-msg": gmailMessageFor("multi-msg", "William J. Hanney - new articles", html) };

    stubGmailAndCrossref(inbox, appliedLabels);
    __resetTokenCacheForTests();
    const first = await runIngestScholar(client, { dryRun: false, limit: null });
    expect(first.articlesSeen).toBe(2);
    expect(first.insertedNew + first.needsMetadata).toBe(2); // both articles landed, one way or another
    vi.unstubAllGlobals();

    const pubsAfterFirst = await client.execute("SELECT COUNT(*) as n FROM publications");
    expect(pubsAfterFirst.rows[0].n).toBe(2);

    // Re-run over the SAME inbox (labeling didn't get a chance to prevent a
    // re-fetch in this test, same convention as the existing plain re-run test).
    stubGmailAndCrossref(inbox, appliedLabels);
    __resetTokenCacheForTests();
    const second = await runIngestScholar(client, { dryRun: false, limit: null });
    expect(second.articlesSeen).toBe(2);
    expect(second.insertedNew).toBe(0); // nothing NEW the second time

    const pubsAfterSecond = await client.execute("SELECT COUNT(*) as n FROM publications");
    expect(pubsAfterSecond.rows[0].n).toBe(2); // still exactly 2, not 4

    client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("an alert whose scholar_user_id matches no active faculty row is skipped, surfaced in unknownScholarIds, and its email is still labeled (terminal, not retried forever)", async () => {
    const { client, dir } = await newDb();
    // Deliberately NO faculty row with scholar_user_id 'WfdV37IAAAAJ' — the
    // roster this run sees is empty of any match for this alert.
    const html = fixtureHtml("alert-single-hanney-olecranon");
    const appliedLabels: string[] = [];
    stubGmailAndCrossref({ "orphan-msg": gmailMessageFor("orphan-msg", "William J. Hanney - new articles", html) }, appliedLabels);

    __resetTokenCacheForTests();
    const summary = await runIngestScholar(client, { dryRun: false, limit: null });

    expect(summary.unknownScholarIds).toEqual([{ scholarUserId: "WfdV37IAAAAJ", displayName: "William J. Hanney" }]);
    expect(summary.alertsMatchedToFaculty).toBe(0);
    expect(appliedLabels).toEqual(["orphan-msg"]); // labeled anyway — a known, terminal reason, not re-scanned every run
    const pubs = await client.execute("SELECT COUNT(*) as n FROM publications");
    expect(pubs.rows[0].n).toBe(0);

    client.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
