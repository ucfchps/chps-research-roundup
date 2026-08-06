// Phase 5 hardening, Session 3, item D (★ overlapping/concurrent runs).
// Standing rule: report, don't fix. Every ingester follows the same shape
// (lib/matching.ts::findMatch) — read `existing` fresh, decide in memory,
// then either UPDATE an existing row or INSERT a new one, with no
// transaction spanning the read and the write and no advisory lock. Two
// overlapping invocations of the SAME job against the SAME DB (a manual
// re-run landing mid-schedule, a CI retry racing the original run — a real
// possibility given docs/phase5-surface-inventory.md's finding that
// ingest-pubmed-orcid has never completed inside its 30-minute CI timeout)
// can both read `existing` before either write commits.
//
// publications.doi has a real UNIQUE constraint (db/migrations/001_initial.sql)
// but publications.title_normalized does not. This file demonstrates both
// halves of that asymmetry with the real orchestration functions, not a
// reimplementation: a DOI-bearing race is caught by the DB (ugly, but no
// duplicate); a title-only race (needs_metadata / gray-lit discoveries, the
// exact shape a Scholar alert or an ORCID no-DOI work produces) is NOT
// caught by anything and silently produces two rows for one paper.
import { describe, expect, it, vi } from "vitest";
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
const { runIngestCrossref } = await import("../../scripts/ingest-crossref");
const { __resetTokenCacheForTests } = await import("../../lib/gmail");

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "scholar-alerts");
function fixtureHtml(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, `${name}.decoded.html`), "utf-8");
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

async function newDb(): Promise<{ client: Client; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "concurrency-test-"));
  const client = createClient({ url: `file:${path.join(dir, "test.db")}` });
  await runMigrations(client, path.join(__dirname, "..", "..", "db", "migrations"));
  return { client, dir };
}

// A plain setTimeout delay turned out NOT to force a race here: Node drains
// all pending microtasks after each individual timer callback (not just
// after the whole timers phase), and this project's local-file libsql calls
// resolve via microtask, not a real macrotask — so "run A's timer fires ->
// run A's entire await chain (including its DB read+write) drains to
// completion -> THEN run B's timer fires" is what actually happened, every
// time, which is a real serialization, not a race. A barrier that makes N
// concurrent callers block on the SAME fetch until all N have arrived forces
// their post-fetch continuations to interleave at the microtask level
// instead — deterministically reproducing the race this test exists to prove,
// rather than depending on scheduler luck.
function makeBarrier(n: number): () => Promise<void> {
  let count = 0;
  const resolvers: Array<() => void> = [];
  return () =>
    new Promise<void>((resolve) => {
      resolvers.push(resolve);
      count++;
      if (count === n) resolvers.forEach((r) => r());
    });
}

describe("★ overlapping runs — the same job invoked twice concurrently against the same DB", () => {
  it("a title-only (no-DOI) candidate races into TWO rows for one paper — findMatch's read-then-write has no lock and title_normalized has no UNIQUE constraint", async () => {
    const { client, dir } = await newDb();
    await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, scholar_user_id, active)
            VALUES ('1', 'schellhase', 'Schellhase, K.C.', 'Kristen Couper Schellhase', 'kcs@x.edu', 'School of Kinesiology and Rehabilitation Sciences', 'ez1ilMIAAAAJ', 1)`,
      args: [],
    });

    const html = fixtureHtml("pair-citation-tag-schellhase");
    const data = Buffer.from(html, "utf-8").toString("base64url");
    const message = {
      id: "msg-race",
      threadId: "msg-race",
      payload: { mimeType: "text/html", headers: [{ name: "Subject", value: "Kristen Couper Schellhase - new articles" }], body: { data } },
    };

    // Crossref finds nothing for this title -> resolveByTitle returns null ->
    // insert_needs_metadata, which carries no DOI at all (the real shape
    // ingest-scholar and ingest-pubmed-orcid's ORCID-no-DOI path both produce
    // for gray-lit / not-yet-indexed discoveries). Both concurrent runs' own
    // article-resolution fetch is gated on the SAME barrier, so both reach
    // "existingList is empty, this is new" before either has inserted.
    const crossrefGate = makeBarrier(2);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "tok", expires_in: 3600 });
        if (url.includes("/messages?")) return jsonResponse({ messages: [{ id: "msg-race" }] });
        if (url.match(/\/messages\/msg-race\?format=full/)) return jsonResponse(message);
        if (url.match(/\/messages\/msg-race\/modify/)) return jsonResponse({});
        if (url.startsWith("https://api.crossref.org/works?")) {
          await crossrefGate();
          return jsonResponse({ message: { items: [] } });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    __resetTokenCacheForTests();
    const runA = runIngestScholar(client, { dryRun: false, limit: null });
    __resetTokenCacheForTests();
    const runB = runIngestScholar(client, { dryRun: false, limit: null });
    await Promise.all([runA, runB]);

    const pubs = await client.execute("SELECT id, title, doi FROM publications");
    // ★ THE FINDING: this is 2, not 1. Both concurrent runs read an empty
    // `existing` list for the same title before either INSERT committed.
    // Neither row is malformed — each is individually a perfectly valid
    // needs_metadata row — there are just two of them for one real paper,
    // silently, with nothing (no error, no log line) marking it as a race.
    // Deterministic with the barrier above, not a scheduling-dependent flake.
    expect(pubs.rows).toHaveLength(2);
    expect(pubs.rows.map((r) => r.title)).toEqual([pubs.rows[0].title, pubs.rows[0].title]);
    expect(pubs.rows.map((r) => r.doi)).toEqual([null, null]);

    vi.unstubAllGlobals();
    client.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15000);

  it("a DOI-bearing candidate racing the same way is caught by the DB's UNIQUE(doi) constraint — no duplicate row, but the losing run's candidate throws instead of degrading gracefully", async () => {
    const { client, dir } = await newDb();
    await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, active) VALUES ('1', '1', 'Zraick, R.I.', 'Richard I. Zraick', 'r@x.edu', 'Department of Health Sciences', 1)`,
      args: [],
    });

    const crossrefItem = {
      DOI: "10.1234/race-condition-paper",
      title: ["A Race Condition Paper"],
      type: "journal-article",
      author: [{ given: "Richard", family: "Zraick", affiliation: [{ name: "University of Central Florida" }] }],
      "container-title": ["Test Journal"],
      volume: "1", issue: "1", page: "1-10",
      issued: { "date-parts": [[2026]] },
    };

    const gate = makeBarrier(2);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.match(/query\.author=/)) {
          await gate();
          return jsonResponse({ message: { items: [crossrefItem] } });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const [resultA, resultB] = await Promise.allSettled([
      runIngestCrossref(client, { dryRun: false, facultyWpId: "1" }),
      runIngestCrossref(client, { dryRun: false, facultyWpId: "1" }),
    ]);

    const pubs = await client.execute("SELECT id, doi FROM publications WHERE doi = '10.1234/race-condition-paper'");
    // The constraint does its job — exactly one row survives, never two.
    expect(pubs.rows).toHaveLength(1);

    // ★ THE OTHER HALF OF THE FINDING: the DOI constraint prevents a
    // duplicate row, but at the cost of an uncaught exception that aborts the
    // LOSING run's entire faculty sweep, not just this one candidate. Unlike
    // a CrossrefUnavailableError (caught per-faculty, logged into
    // skippedFaculty, the run continues), applyCandidate's INSERT is not
    // wrapped in any per-candidate try/catch in scripts/ingest-crossref.ts —
    // a raw SQLITE_CONSTRAINT_UNIQUE here propagates straight out of
    // runIngestCrossref. Deterministic with the barrier above.
    const outcomes = [resultA, resultB].map((r) => r.status).sort();
    expect(outcomes).toEqual(["fulfilled", "rejected"]);
    const rejected = resultA.status === "rejected" ? resultA : (resultB as PromiseRejectedResult);
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(/UNIQUE constraint failed: publications\.doi/);
    console.log(
      "[concurrency finding] concurrent runIngestCrossref on the same new DOI: one run's whole faculty sweep aborts uncaught on SQLITE_CONSTRAINT_UNIQUE — the winning run's candidate is the only one this cycle actually links authors/roundup-eligibility for; the loser's work (including any OTHER, unrelated candidates later in its own loop) is silently dropped for this run and only retried on the job's next scheduled invocation.",
      resultA.status === "rejected" ? resultA.reason : undefined,
      resultB.status === "rejected" ? resultB.reason : undefined
    );

    vi.unstubAllGlobals();
    client.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15000);
});
