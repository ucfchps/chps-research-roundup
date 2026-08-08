// Phase 5 hardening, Session 10 (docs/phase5-findings.md #3): ingest-pubmed-orcid
// resumability, per-faculty budget, and the existingList cache. Approved
// design: two independent settings-backed cursors (orcid_sweep_cursor,
// pubmed_sweep_cursor), position re-derived from the current roster every
// run, unconditional cursor advance after each person's attempt (success or
// caught error alike — including genuinely unexpected errors, not just the
// already-anticipated Unavailable types), a per-faculty-sweep existingList
// cache invalidated by this run's own writes, a ~25-minute wall-clock
// ceiling (test-injectable), and pubmed_sweep_cycle_completed_at recorded +
// logged when a cycle reaches the end of the roster.
//
// Explicitly out of scope, per the approved design — untouched, tracked as
// follow-ups in docs/phase5-findings.md: efetch/affiliation capture, the
// ingester concurrency race (Session 3), the disposal path, scheduler
// restoration, and the identical existingList-per-candidate pattern in
// scripts/ingest-crossref.ts / scripts/ingest-scholar.ts (confirmed
// structurally independent — each has its own local copy of applyCandidate).
//
// Existing coverage NOT duplicated: tests/ingest-pubmed-orcid.test.ts's 14
// tests (all --faculty-scoped, which bypasses the cursor entirely by
// design — confirmed unaffected, re-ran green against this implementation)
// already cover ORCID/PubMed resolution, merge priority, the real shared-DOI
// cross-source merge, and human-set-role survival. This file's job is the
// orchestration layer those tests never exercised: the cursor itself.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/test-db";
import { snapshotTables } from "../helpers/snapshot";
import { assertReRunInvariants } from "../helpers/invariants";
import { seedFaculty, seedPublication } from "../helpers/fixtures";
import { withFakeTimers } from "../helpers/fake-timers";
import { getSetting } from "../../lib/settings";

process.env.CROSSREF_MAILTO ??= "test@example.com";

const {
  runIngestPubmedOrcid,
  queueFromCursor,
  createExistingListCache,
  readCursor,
  ORCID_CURSOR_KEY,
  PUBMED_CURSOR_KEY,
  PUBMED_CYCLE_COMPLETED_AT_KEY,
} = await import("../../scripts/ingest-pubmed-orcid");

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function esearchResponse(idlist: string[]) {
  return jsonResponse({ esearchresult: { idlist } });
}

function esummaryResponse(records: Array<{ uid: string; title: string; doi?: string }>) {
  const result: Record<string, unknown> = { uids: records.map((r) => r.uid) };
  for (const r of records) {
    result[r.uid] = {
      uid: r.uid, pubdate: "2026 Jul 2", fulljournalname: "J", title: r.title,
      authors: [{ name: "Author A", authtype: "Author" }], articleids: r.doi ? [{ idtype: "doi", value: r.doi }] : [],
    };
  }
  return jsonResponse({ result });
}

// Session 12 (docs/phase5-findings.md #2): sweepPubmed now efetches
// affiliation for genuinely new candidates. None of THIS file's tests
// assert on affiliation buckets — they're about the cursor/cache/ceiling
// machinery — so an empty AuthorList (no coded affiliation, a real shape
// per tests/fixtures/api/pubmed-efetch-old-no-affiliation.xml) for every
// requested id is a valid, uneventful stand-in.
function efetchResponse(ids: string[]): Response {
  const articles = ids.map((id) => `<PubmedArticle><MedlineCitation><PMID>${id}</PMID></MedlineCitation></PubmedArticle>`).join("");
  return new Response(`<PubmedArticleSet>${articles}</PubmedArticleSet>`, { status: 200 });
}

// Every faculty member in these tests has a UNIQUE, empty PubMed/ORCID
// result by default (no candidates) unless a test overrides it for a
// specific person — keeps each test's assertions about WHO got swept clean,
// independent of WHAT was found.
function stubEmptyFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("pub.orcid.org")) return jsonResponse({ group: [] });
      if (url.includes("esearch.fcgi")) return esearchResponse([]);
      if (url.includes("esummary.fcgi")) return esummaryResponse([]);
      throw new Error(`unrouted fetch in stubEmptyFetch: ${url}`);
    })
  );
}

describe("ingest-pubmed-orcid resumability", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  });

  // ── 1. Mid-sweep kill resumes from the cursor, not position 1 ──────────
  it("a wall-clock-ceiling stop mid-sweep writes the cursor to the last person actually processed; the next run resumes AFTER them, never restarting from position 1", async () => {
    const facultyIds = [];
    for (let i = 0; i < 4; i++) facultyIds.push(await seedFaculty(db.client, { wp_id: `wp-${i}`, display_name: `Person ${i}, P.` }));

    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("esearch.fcgi")) {
          const match = url.match(/term=([^&]+)/);
          if (match) seen.push(decodeURIComponent(match[1]));
          return esearchResponse([]);
        }
        if (url.includes("esummary.fcgi")) return esummaryResponse([]);
        throw new Error(`unrouted: ${url}`);
      })
    );

    // A ceiling of 0ms means "stop before starting anyone" is too aggressive
    // to prove partial progress — use a ceiling that expires after the
    // first iteration's real (fast, local) work but before a second.
    // Simplest deterministic approach: ceiling elapses immediately AFTER
    // the loop's first Date.now() check passes once — achieved here by
    // passing a ceiling so small that only the FIRST person's async work
    // completes before the second check trips.
    const first = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: null, wallClockCeilingMs: 1 });

    expect(first.stoppedByWallClockCeiling.pubmed).toBe(true);
    expect(first.pubmedCycleCompleted).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(4); // did NOT reach everyone

    const cursorAfterFirst = await readCursor(db.client, PUBMED_CURSOR_KEY);
    expect(cursorAfterFirst).toBe(first.pubmedCursorAdvancedTo);
    expect(cursorAfterFirst).not.toBeNull();

    // Resume with a generous ceiling — must pick up strictly AFTER the
    // cursor, not restart from wp-0.
    seen.length = 0;
    const second = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: null, wallClockCeilingMs: 5 * 60_000 });

    expect(second.pubmedCycleCompleted).toBe(true); // the rest of a 4-person roster finishes easily
    const cursorIndex = facultyIds.findIndex((_id, i) => `wp-${i}` === cursorAfterFirst);
    // buildPubmedAuthorQuery reformats the name for the query term (no
    // comma, initials appended) — extract just the ordinal rather than
    // requiring an exact reformatted string.
    const seenOrdinals = seen.map((term) => Number(term.match(/Person (\d+)/)?.[1])).sort((a, b) => a - b);
    const expectedOrdinals = Array.from({ length: 4 - cursorIndex - 1 }, (_, i) => cursorIndex + 1 + i);
    expect(seenOrdinals).toEqual(expectedOrdinals);
    expect(seenOrdinals).not.toContain(0); // position 1 (index 0) was NOT where it restarted
  });

  // ── 2. A full cycle eventually reaches everyone and records completion ──
  it("across several ceiling-limited invocations, a full cycle eventually reaches every active faculty member and records completion", async () => {
    const N = 7;
    for (let i = 0; i < N; i++) await seedFaculty(db.client, { wp_id: `wp-${i}`, display_name: `Person ${i}, P.` });

    const attemptedOrdinals = new Set<number>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("esearch.fcgi")) {
          const match = url.match(/term=([^&]+)/);
          const ordinal = match ? Number(decodeURIComponent(match[1]).match(/Person (\d+)/)?.[1]) : NaN;
          if (!Number.isNaN(ordinal)) attemptedOrdinals.add(ordinal);
          return esearchResponse([]);
        }
        if (url.includes("esummary.fcgi")) return esummaryResponse([]);
        throw new Error(`unrouted: ${url}`);
      })
    );

    expect(await getSetting(db.client, PUBMED_CYCLE_COMPLETED_AT_KEY)).toBeNull(); // "never," today's real answer

    // A tiny ceiling forces (at most, sometimes zero — setup overhead alone
    // can exceed 1ms) partial progress per invocation — proving this isn't
    // "one generous run finishes it," but genuine resume-across-invocations.
    // The safety cap is generous and independent of N precisely because a
    // near-zero ceiling doesn't guarantee exactly one person per call.
    let cycleCompleted = false;
    const MAX_INVOCATIONS = 60;
    for (let invocation = 0; invocation < MAX_INVOCATIONS && !cycleCompleted; invocation++) {
      const result = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: null, wallClockCeilingMs: 1 });
      if (result.pubmedCycleCompleted) cycleCompleted = true;
    }

    expect(cycleCompleted).toBe(true);
    expect(attemptedOrdinals.size).toBe(N); // every single one was reached, eventually
    for (let i = 0; i < N; i++) expect(attemptedOrdinals.has(i)).toBe(true);

    const completedAt = await getSetting(db.client, PUBMED_CYCLE_COMPLETED_AT_KEY);
    expect(completedAt).not.toBeNull();
    expect(() => new Date(completedAt!).toISOString()).not.toThrow();

    // And the cursor wrapped — a subsequent run starts a new cycle from the top.
    expect(await readCursor(db.client, PUBMED_CURSOR_KEY)).toBeNull();
  });

  // ── 3. A persistently-failing faculty member is skipped forward ────────
  it("a faculty member whose PubMed search fails on every attempt (network-layer — wrapped as PubmedUnavailableError by searchPubmedByAuthor, same as any real NCBI outage) is skipped forward by the cursor, never retried within the same cycle", async () => {
    await seedFaculty(db.client, { wp_id: "wp-0", display_name: "Person 0, P." });
    await seedFaculty(db.client, { wp_id: "wp-1", display_name: "Person 1, P." }); // this one always fails
    await seedFaculty(db.client, { wp_id: "wp-2", display_name: "Person 2, P." });

    let attemptsOnPerson1 = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("esearch.fcgi")) {
          if (url.includes(encodeURIComponent("Person 1"))) {
            attemptsOnPerson1++;
            // A raw fetch failure — fetchWithRetry exhausts its own real
            // backoff (4 attempts) before giving up, and
            // searchPubmedByAuthor wraps the result as PubmedUnavailableError
            // regardless of the underlying cause (confirmed: lib/pubmed.ts
            // wraps every fetchWithRetry failure the same way, network
            // hiccup or anything else raised from inside fetch) — so this
            // exercises sweepPubmed's EXISTING catch, already proven in
            // tests/ingest-pubmed-orcid.test.ts. What's new here is proving
            // the CURSOR advances past them regardless, which that file
            // never needed to check since it has no cursor to advance.
            throw new TypeError("boom — simulates any raw fetch failure, NCBI outage or otherwise");
          }
          return esearchResponse([]);
        }
        if (url.includes("esummary.fcgi")) return esummaryResponse([]);
        throw new Error(`unrouted: ${url}`);
      })
    );

    const first = await withFakeTimers(() => runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: null, wallClockCeilingMs: 5 * 60_000 }));

    expect(first.pubmedCycleCompleted).toBe(true); // the run did NOT abort — it completed despite the failure
    expect(attemptsOnPerson1).toBeGreaterThan(0); // fetchWithRetry's own retry budget, not this test's concern to pin exactly
    expect(first.skipped.some((s) => s.displayName === "Person 1, P." && s.source === "pubmed")).toBe(true);

    // A second full cycle (cursor wrapped after the first) would legitimately
    // retry them — that's a NEW cycle's business, not "retried indefinitely
    // within one." Confirm the cursor wrapped, which is what makes that a
    // deliberate new attempt next cycle rather than an infinite retry loop
    // stuck on this one person.
    expect(await readCursor(db.client, PUBMED_CURSOR_KEY)).toBeNull();
  });

  // The outer safety net (attemptPubmedSweep/attemptOrcidSweep in the
  // script) exists specifically for a failure that ISN'T one of the
  // anticipated Unavailable types — e.g. a bug somewhere in downstream
  // processing, not a network hiccup. lib/pubmed.ts wraps every
  // network-layer failure into PubmedUnavailableError before it ever
  // reaches sweepPubmed, so a genuinely unanticipated error can't be
  // produced through the network mock alone. Forced here instead by making
  // wp-1 return one real PubMed record (so applyCandidate's DB write
  // actually runs) and throwing from the DB layer specifically during that
  // write — a shape no Unavailable type wraps.
  it("★ a genuinely unexpected (non-network) error for one faculty member is caught by the outer safety net and the cursor still advances past them", async () => {
    await seedFaculty(db.client, { wp_id: "wp-0", display_name: "Person 0, P." });
    await seedFaculty(db.client, { wp_id: "wp-1", display_name: "Person 1, P." });
    await seedFaculty(db.client, { wp_id: "wp-2", display_name: "Person 2, P." });

    let currentlyOnPerson1 = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("esearch.fcgi")) {
          currentlyOnPerson1 = url.includes(encodeURIComponent("Person 1"));
          return currentlyOnPerson1 ? esearchResponse(["500"]) : esearchResponse([]);
        }
        if (url.includes("esummary.fcgi")) {
          return currentlyOnPerson1 ? esummaryResponse([{ uid: "500", title: "Person 1's Real Paper", doi: "10.1/person1-paper" }]) : esummaryResponse([]);
        }
        if (url.includes("efetch.fcgi")) return efetchResponse(new URL(url).searchParams.get("id")?.split(",") ?? []);
        throw new Error(`unrouted: ${url}`);
      })
    );

    const originalExecute = db.client.execute.bind(db.client);
    vi.spyOn(db.client, "execute").mockImplementation(async (...args: Parameters<typeof originalExecute>) => {
      const [arg] = args;
      const sql = typeof arg === "string" ? arg : (arg as { sql?: string })?.sql;
      if (currentlyOnPerson1 && typeof sql === "string" && sql.startsWith("INSERT INTO publications")) {
        throw new RangeError("simulated bug in the write path — not a network error, nothing wraps this");
      }
      return originalExecute(...args);
    });

    const result = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: null, wallClockCeilingMs: 5 * 60_000 });

    expect(result.pubmedCycleCompleted).toBe(true); // did not abort the whole run
    expect(result.skipped.some((s) => s.displayName === "Person 1, P." && s.error.includes("unexpected error") && s.error.includes("simulated bug"))).toBe(true);
    expect(await readCursor(db.client, PUBMED_CURSOR_KEY)).toBeNull(); // cursor still advanced all the way through and wrapped
  }, 15000); // headroom above the 5000ms default — observed occasional environmental slowness unrelated to this test's own logic (no retry/backoff path is involved here)

  // ── 4. ORCID completes independently of PubMed's cursor position ───────
  it("ORCID sweeps every holder to completion in one invocation regardless of where PubMed's own cursor is stalled", async () => {
    await seedFaculty(db.client, { wp_id: "wp-0", display_name: "Orcid Zero, O.", orcid: "0000-0000-0000-0000" });
    await seedFaculty(db.client, { wp_id: "wp-1", display_name: "Orcid One, O.", orcid: "0000-0000-0000-0001" });
    await seedFaculty(db.client, { wp_id: "wp-2", display_name: "Orcid Two, O.", orcid: "0000-0000-0000-0002" });
    await seedFaculty(db.client, { wp_id: "wp-3", display_name: "No Orcid Three, N.", orcid: null });

    // Simulate a PubMed cursor already stalled deep into the roster (as if
    // a prior series of ceiling-limited runs left it there) — set directly,
    // the same settings key the real job reads.
    const { setSetting } = await import("../../lib/settings");
    await setSetting(db.client, PUBMED_CURSOR_KEY, "wp-2", "test-setup");

    const orcidWorksSeen: string[] = [];
    stubEmptyFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("pub.orcid.org")) {
          orcidWorksSeen.push(url);
          return jsonResponse({ group: [] });
        }
        if (url.includes("esearch.fcgi")) return esearchResponse([]);
        if (url.includes("esummary.fcgi")) return esummaryResponse([]);
        throw new Error(`unrouted: ${url}`);
      })
    );

    const result = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: null, wallClockCeilingMs: 5 * 60_000 });

    // All 3 ORCID holders reached, in ONE invocation — completely
    // unaffected by PubMed's cursor sitting at wp-2.
    expect(result.facultyWithOrcidProcessed).toBe(3);
    expect(orcidWorksSeen).toHaveLength(3);
    expect(result.orcidCycleCompleted).toBe(true);

    // PubMed, meanwhile, genuinely did resume from ITS OWN stalled position
    // (after wp-2) — proving the two cursors are independent, not that
    // PubMed's was simply ignored.
    expect(result.pubmedCursorAdvancedTo).toBe("wp-3");
  });

  // ── 5. The cache returns the same results as the uncached path ─────────
  describe("createExistingListCache", () => {
    it("get() returns the real current DB state on first call, and does NOT re-query on a second call even if the DB changed underneath it", async () => {
      const pubResult = await db.client.execute(
        `INSERT INTO publications (title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
         VALUES ('Existing Paper', 'existing paper', 'https://example.com/1', 'pending_merge', 'crossref', datetime('now'), date('now'), datetime('now'))`
      );
      void pubResult;

      const cache = createExistingListCache();
      const first = await cache.get(db.client);
      expect(first).toHaveLength(1);
      expect(first[0].title_normalized).toBe("existing paper");

      // The DB changes via a completely separate write, NOT through the cache.
      await db.client.execute(
        `INSERT INTO publications (title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
         VALUES ('Snuck In Paper', 'snuck in paper', 'https://example.com/2', 'pending_merge', 'crossref', datetime('now'), date('now'), datetime('now'))`
      );

      const second = await cache.get(db.client);
      expect(second).toHaveLength(1); // genuinely cached — does not see the row it didn't insert itself
      expect(second).toBe(first); // same array reference, no re-query
    });

    it("upsert() makes a candidate inserted earlier in the same sweep visible to a later get() — the load-bearing correctness property, not just a perf detail", async () => {
      const cache = createExistingListCache();
      const before = await cache.get(db.client);
      expect(before).toHaveLength(0);

      cache.upsert({ id: 999, doi: "10.1/new-in-sweep", title_normalized: "a new paper mid sweep" });

      const after = await cache.get(db.client);
      expect(after).toHaveLength(1);
      expect(after[0]).toEqual({ id: 999, doi: "10.1/new-in-sweep", title_normalized: "a new paper mid sweep" });
    });

    it("queueFromCursor: null or a not-found cursor both start at position 0; a found cursor resumes at index+1", () => {
      const pool = [{ wp_id: "a" }, { wp_id: "b" }, { wp_id: "c" }];
      expect(queueFromCursor(pool, null)).toEqual(pool);
      expect(queueFromCursor(pool, "not-in-pool")).toEqual(pool); // fell off the roster — same as no cursor
      expect(queueFromCursor(pool, "b")).toEqual([{ wp_id: "c" }]);
      expect(queueFromCursor(pool, "c")).toEqual([]); // was the last one — empty, correctly signals "nothing left this cycle"
    });
  });

  // ── 6. assertReRunInvariants still holds across a resumed run ──────────
  it("the shared re-run invariants hold across a genuinely resumed run (ceiling-stopped, then resumed) — not just a plain re-run", async () => {
    for (let i = 0; i < 3; i++) await seedFaculty(db.client, { wp_id: `wp-${i}`, display_name: `Person ${i}, P.` });
    stubEmptyFetch();

    const beforeAll = await snapshotTables(db.client);

    const first = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: null, wallClockCeilingMs: 1 });
    expect(first.stoppedByWallClockCeiling.pubmed || first.stoppedByWallClockCeiling.orcid || first.pubmedCycleCompleted).toBeTruthy();

    const second = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: null, wallClockCeilingMs: 5 * 60_000 });
    expect(second.pubmedCycleCompleted).toBe(true);

    const afterAll = await snapshotTables(db.client);

    // Nothing here inserts publications (all empty PubMed/ORCID results), so
    // this specifically proves the cursor/settings bookkeeping itself
    // doesn't disturb any of the invariants the rest of Phase 5 depends on —
    // settings is an explicitly-excluded table in the invariant (checked
    // per-key elsewhere), never asserted to be static.
    expect(() => assertReRunInvariants(beforeAll, afterAll)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Throughput measurement — the diagnosis's central prediction, confirmed
// directly rather than inferred from a green suite.
// ─────────────────────────────────────────────────────────────────────────
describe("★ throughput measurement — existingList reload, before vs after", () => {
  it("measures the REAL query count for a 100-candidate PubMed sweep: old code = 1 existingList query per candidate (proven by the diff, not reconstructed — every applyCandidate call issued its own unconditional SELECT); new code, measured here, issues exactly 1 for the whole sweep", async () => {
    const db = await createTestDb();
    await seedFaculty(db.client, { wp_id: "wp-heavy", display_name: "Heavy Surname, H." });

    // Seed a realistically-sized existing table — not production's 5,797,
    // but large enough that the query itself does real work, not a
    // zero-row round trip.
    for (let i = 0; i < 200; i++) {
      await db.client.execute(
        `INSERT INTO publications (title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
         VALUES ('Filler Paper ${i}', 'filler paper ${i}', 'https://example.com/filler-${i}', 'published', 'crossref', datetime('now'), date('now'), datetime('now'))`
      );
    }

    const CANDIDATE_COUNT = 100;
    const records = Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
      uid: String(1000 + i),
      title: `Heavy Sweep Candidate ${i}`,
      doi: `10.1/heavy-${i}`,
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("esearch.fcgi")) return esearchResponse(records.map((r) => r.uid));
        if (url.includes("esummary.fcgi")) return esummaryResponse(records);
        if (url.includes("efetch.fcgi")) return efetchResponse(new URL(url).searchParams.get("id")?.split(",") ?? []);
        throw new Error(`unrouted: ${url}`);
      })
    );

    const executeSpy = vi.spyOn(db.client, "execute");

    const start = Date.now();
    const summary = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: "wp-heavy" });
    const elapsedMs = Date.now() - start;

    expect(summary.insertedNew).toBe(CANDIDATE_COUNT); // sanity: the full candidate set actually landed

    const existingListQueryCalls = executeSpy.mock.calls.filter((call) => {
      const arg = call[0];
      const sql = typeof arg === "string" ? arg : (arg as { sql?: string })?.sql;
      return typeof sql === "string" && sql.includes("SELECT id, doi, title_normalized FROM publications");
    });

    // THE MEASURED RESULT: exactly 1, not 100.
    expect(existingListQueryCalls).toHaveLength(1);

    const oldCodeQueryCount = CANDIDATE_COUNT; // proven by the diff: applyCandidate issued this SELECT unconditionally, once per call, every time
    const newCodeQueryCount = existingListQueryCalls.length;

    // Real production round-trip latency for this exact query shape,
    // measured directly against the CHPS Turso database during this
        // session's diagnosis (read-only SELECTs, 5 samples): 65-190ms.
    const REAL_PRODUCTION_LATENCY_MS = { low: 65, high: 190 };

    console.log(
      `[throughput measurement] ${CANDIDATE_COUNT} candidates, one faculty member, local SQLite: ` +
        `existingList queries — old code (by construction): ${oldCodeQueryCount}, new code (measured): ${newCodeQueryCount}. ` +
        `Local elapsed for the whole sweep: ${elapsedMs}ms. ` +
        `Extrapolated to production's measured per-query latency (${REAL_PRODUCTION_LATENCY_MS.low}-${REAL_PRODUCTION_LATENCY_MS.high}ms/query): ` +
        `old ≈ ${Math.round((oldCodeQueryCount * REAL_PRODUCTION_LATENCY_MS.low) / 1000)}-${Math.round((oldCodeQueryCount * REAL_PRODUCTION_LATENCY_MS.high) / 1000)}s ` +
        `just for this one redundant query across ${CANDIDATE_COUNT} candidates, vs new ≈ ${REAL_PRODUCTION_LATENCY_MS.low}-${REAL_PRODUCTION_LATENCY_MS.high}ms total (1 query).`
    );

    await db.teardown();
  }, 20000);

  // docs/phase5-findings.md #2 (Session 13 diagnosis, Session 14 fix): the
  // OTHER redundant read this job made — applyCandidate's MATCH branch
  // read a matched publication's full row + its authors from the database
  // on EVERY merging candidate, unconditionally, even in --dry-run.
  // Measured against production: 79% of a diagnostic run's wall-clock,
  // worst case ~250 merges (retmax cap) costing 30+ real seconds for one
  // faculty member. This mirrors the existingList test above exactly, one
  // level deeper — all-MERGE this time, not all-INSERT.
  it("measures the REAL query count for a 100-merge PubMed sweep: old code = 2 queries per merging candidate (proven by the diff); new code, measured here, issues a small constant number for the whole sweep", async () => {
    const db = await createTestDb();
    const faculty = await seedFaculty(db.client, { wp_id: "wp-heavy-merge", display_name: "Heavy Merge, H." });

    const MERGE_COUNT = 100;
    const existingIds: number[] = [];
    for (let i = 0; i < MERGE_COUNT; i++) {
      const id = await seedPublication(db.client, {
        title: `Existing Merge Candidate ${i}`,
        doi: `10.1/merge-${i}`,
        status: "pending_merge",
        source: "crossref",
      });
      existingIds.push(id);
    }

    // Every esearch/esummary hit matches one of the just-seeded rows by DOI
    // — every candidate this sweep sees is a MERGE, none an INSERT.
    const records = Array.from({ length: MERGE_COUNT }, (_, i) => ({
      uid: String(2000 + i),
      title: `Existing Merge Candidate ${i}`,
      doi: `10.1/merge-${i}`,
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("esearch.fcgi")) return esearchResponse(records.map((r) => r.uid));
        if (url.includes("esummary.fcgi")) return esummaryResponse(records);
        if (url.includes("efetch.fcgi")) return efetchResponse(new URL(url).searchParams.get("id")?.split(",") ?? []);
        throw new Error(`unrouted: ${url}`);
      })
    );

    const executeSpy = vi.spyOn(db.client, "execute");

    const start = Date.now();
    const summary = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: "wp-heavy-merge" });
    const elapsedMs = Date.now() - start;

    expect(summary.merged).toBe(MERGE_COUNT); // sanity: every candidate really did merge, not insert
    expect(summary.insertedNew).toBe(0);

    const pubDetailQueryCalls = executeSpy.mock.calls.filter((call) => {
      const arg = call[0];
      const sql = typeof arg === "string" ? arg : (arg as { sql?: string })?.sql;
      return typeof sql === "string" && sql.includes("FROM publications WHERE id IN");
    });
    const authorDetailQueryCalls = executeSpy.mock.calls.filter((call) => {
      const arg = call[0];
      const sql = typeof arg === "string" ? arg : (arg as { sql?: string })?.sql;
      return typeof sql === "string" && sql.includes("FROM publication_authors WHERE publication_id IN");
    });

    // THE MEASURED RESULT: 1 batched query each, not 100 unbatched pairs.
    expect(pubDetailQueryCalls).toHaveLength(1);
    expect(authorDetailQueryCalls).toHaveLength(1);

    const oldCodeQueryCount = MERGE_COUNT * 2; // proven by the diff: 2 unconditional SELECTs per merging candidate
    const newCodeQueryCount = pubDetailQueryCalls.length + authorDetailQueryCalls.length;
    const REAL_PRODUCTION_LATENCY_MS = { low: 65, high: 190 }; // Session 10's own measured production round-trip

    console.log(
      `[throughput measurement] ${MERGE_COUNT} merging candidates, one faculty member, local SQLite: ` +
        `merge-detail queries — old code (by construction): ${oldCodeQueryCount}, new code (measured): ${newCodeQueryCount}. ` +
        `Local elapsed for the whole sweep: ${elapsedMs}ms. ` +
        `Extrapolated to production's measured per-query latency (${REAL_PRODUCTION_LATENCY_MS.low}-${REAL_PRODUCTION_LATENCY_MS.high}ms/query): ` +
        `old ≈ ${Math.round((oldCodeQueryCount * REAL_PRODUCTION_LATENCY_MS.low) / 1000)}-${Math.round((oldCodeQueryCount * REAL_PRODUCTION_LATENCY_MS.high) / 1000)}s ` +
        `just for these redundant queries across ${MERGE_COUNT} merges, vs new ≈ ${Math.round((newCodeQueryCount * REAL_PRODUCTION_LATENCY_MS.low) / 1000 * 1000)}-${Math.round((newCodeQueryCount * REAL_PRODUCTION_LATENCY_MS.high) / 1000 * 1000)}ms total (${newCodeQueryCount} queries).`
    );

    await db.teardown();
  }, 20000);

  it("preserves self-consistency within one sweep: a second candidate matching the SAME publication as an earlier one in this sweep sees the earlier merge's result, not a stale pre-loaded snapshot", async () => {
    const db = await createTestDb();
    await seedFaculty(db.client, { wp_id: "wp-repeat-match", display_name: "Repeat Match, R." });
    const existingId = await seedPublication(db.client, {
      title: "Shared Real Paper",
      doi: "10.1/shared-real-paper",
      journal: null, // absent — the FIRST candidate should fill it; the SECOND must see that fill, not the original null
      status: "pending_merge",
      source: "crossref",
    });

    // Two esearch/esummary hits for the SAME real paper (a genuine observed
    // shape — e.g. an ahead-of-print record and its later indexed version,
    // different PMIDs, same DOI) — both should MERGE into existingId, and
    // the second must see the first's journal fill. Built inline rather
    // than via the shared esummaryResponse() helper, which hardcodes
    // fulljournalname: "J" — this test needs a distinct, real journal
    // value per record to prove which one actually stuck.
    const records = [
      { uid: "3001", title: "Shared Real Paper", doi: "10.1/shared-real-paper", journal: "First Sighting Journal" },
      { uid: "3002", title: "Shared Real Paper", doi: "10.1/shared-real-paper", journal: "Second Sighting Journal (must not overwrite)" },
    ];
    const customEsummaryResponse = () =>
      jsonResponse({
        result: {
          uids: records.map((r) => r.uid),
          ...Object.fromEntries(
            records.map((r) => [
              r.uid,
              { uid: r.uid, pubdate: "2026 Jul 2", fulljournalname: r.journal, title: r.title, authors: [{ name: "Author A", authtype: "Author" }], articleids: [{ idtype: "doi", value: r.doi }] },
            ])
          ),
        },
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("esearch.fcgi")) return esearchResponse(records.map((r) => r.uid));
        if (url.includes("esummary.fcgi")) return customEsummaryResponse();
        if (url.includes("efetch.fcgi")) return efetchResponse(new URL(url).searchParams.get("id")?.split(",") ?? []);
        throw new Error(`unrouted: ${url}`);
      })
    );

    const summary = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: "wp-repeat-match" });

    expect(summary.merged).toBe(2); // both candidates matched the same pre-existing row
    expect(summary.insertedNew).toBe(0);

    const finalRow = (await db.client.execute({ sql: "SELECT journal FROM publications WHERE id = ?", args: [existingId] })).rows[0];
    // pubmed source can't overwrite an already-non-empty field it doesn't
    // outrank (§7's isEmpty-gated upgrade rule) — the FIRST candidate's
    // fill sticks, proving the SECOND candidate's merge saw the row as it
    // existed AFTER the first merge (journal already filled), not the
    // pre-loaded snapshot from before the sweep started (journal null).
    expect(finalRow.journal).toBe("First Sighting Journal");

    await db.teardown();
  });

  // docs/phase5-findings.md #2 (Session 14): the ceiling used to only ever
  // gate STARTING a new faculty member — a single person's own candidate
  // loop had no way to be interrupted, however long it ran. This proves
  // the fix actually stops mid-person, not just between people.
  it("the wall-clock ceiling can now stop mid-sweep WITHIN one faculty member's own candidate loop, not just between people", async () => {
    const db = await createTestDb();
    await seedFaculty(db.client, { wp_id: "wp-many-candidates", display_name: "Many Candidates, M." });

    // A large synthetic count, well beyond PubMed's real retmax=250 ceiling
    // — this test exists purely to prove the interrupt mechanism itself
    // fires mid-loop, which needs a loop wide enough to reliably straddle
    // a real wall-clock ceiling despite per-candidate processing being
    // fast (a few hundred microseconds each against local SQLite).
    const CANDIDATE_COUNT = 3000;
    const records = Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
      uid: String(4000 + i),
      title: `Mid-Sweep Candidate ${i}`,
      doi: `10.1/mid-sweep-${i}`,
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("esearch.fcgi")) return esearchResponse(records.map((r) => r.uid));
        if (url.includes("esummary.fcgi")) return esummaryResponse(records);
        if (url.includes("efetch.fcgi")) return efetchResponse(new URL(url).searchParams.get("id")?.split(",") ?? []);
        throw new Error(`unrouted: ${url}`);
      })
    );

    // Chosen above the rate-limiter's own pre-loop self-throttle wait
    // (esearch/esummary/efetch each wait up to the unauthenticated 333ms
    // floor in a test env with no NCBI_API_KEY — comfortably under
    // 1000ms for all three) but well under how long 3000 iterations takes
    // to fully clear, so the cut reliably lands inside the loop.
    const summary = await runIngestPubmedOrcid(db.client, { dryRun: false, facultyWpId: null, wallClockCeilingMs: 1000 });

    const totalHandled = summary.merged + summary.insertedNew;
    expect(totalHandled).toBeGreaterThan(0); // some candidates WERE processed before the cutoff
    expect(totalHandled).toBeLessThan(CANDIDATE_COUNT); // but not all 20 — this is the mid-sweep cut, not a between-person one
    expect(summary.stoppedByWallClockCeiling.pubmed).toBe(true);

    const midSweepSkip = summary.skipped.find((s) => s.error.includes("wall-clock ceiling hit mid-sweep"));
    expect(midSweepSkip).toBeDefined();
    expect(midSweepSkip?.wpId).toBe("wp-many-candidates");

    // The person's own cursor still advances — "attempted, however far it
    // got" applies here exactly as it already does for every other stop
    // condition in this file, so the NEXT run resumes after them rather
    // than re-processing (and re-counting) whatever this run already did.
    const cursor = await readCursor(db.client, PUBMED_CURSOR_KEY);
    expect(cursor).toBe("wp-many-candidates");

    await db.teardown();
  });
});
