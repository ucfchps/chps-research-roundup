// Phase 5 hardening (idempotency, §9). Read this file's scope carefully
// before adding to it: tests/sync-roster.test.ts ALREADY comprehensively
// covers sync-roster's specific re-run scenarios — a second identical run
// inserting/deactivating nothing, removal -> active=0 (never deleted),
// reactivation on return, a scholar_user_id collision caught and both
// people named, a Staff-classified CARD record retained, a wp_id=NULL
// manual row surviving untouched, and last_alert_seen_at never written
// (§5a rule 4) — all read and confirmed present before writing this file,
// not assumed. Duplicating those here would be test mass with no new
// coverage.
//
// This file's actual job: prove the Session 1 harness's shared
// assertReRunInvariants (tests/helpers/invariants.ts) holds across real
// syncRoster runs, using createTestDb() instead of the older file's
// hand-rolled mkdtempSync/runMigrations setup. Sessions 2/3 call the same
// helper against the ingestion jobs; sync-roster is the cheapest real job
// to prove the helper itself is correct against, since it never touches
// publications/publication_authors at all — every row-level invariant
// below is expected to hold vacuously, which is itself worth confirming
// (a job that DID start touching those tables by accident would trip it).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/test-db";
import { snapshotTables } from "../helpers/snapshot";
import { assertReRunInvariants } from "../helpers/invariants";
import { syncRoster } from "../../scripts/sync-roster";
import type { WpPerson } from "../../lib/wordpress";

const API_URL = "https://healthprofessions.ucf.edu/wp-json/wp/v2/person";
const CLASS_TAXONOMY_URL = "https://healthprofessions.ucf.edu/wp-json/wp/v2/class?per_page=100&_fields=id,name,slug";
const CLASS_TERMS = [{ id: 10, name: "Faculty" }];

function person(overrides: Partial<WpPerson>): WpPerson {
  return {
    id: 0,
    slug: "",
    title: { rendered: "" },
    departments: [],
    class: [],
    acf: { profile_F_name: "", profile_L_name: "", email_address: "", google_scholar: "", orcid: "" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function stubFetch(people: WpPerson[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(CLASS_TAXONOMY_URL)) return jsonResponse(CLASS_TERMS);
      if (url.startsWith(API_URL)) return jsonResponse(people, { "X-WP-TotalPages": "1" });
      throw new Error(`unexpected fetch in this test: ${url}`);
    })
  );
}

const STOCK = person({
  id: 1163, slug: "matt-stock", title: { rendered: "Matt S. Stock" },
  departments: [232], class: [10],
  acf: { profile_F_name: "Matt S.", profile_L_name: "Stock", email_address: "matt.stock@ucf.edu", google_scholar: "", orcid: "" },
});

const ZRAICK = person({
  id: 88010, slug: "richard-zraick", title: { rendered: "Richard I. Zraick" },
  departments: [166], class: [10],
  acf: { profile_F_name: "Richard I.", profile_L_name: "Zraick", email_address: "richard.zraick@ucf.edu", google_scholar: "", orcid: "" },
});

describe("sync-roster — re-run invariants", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.teardown();
    vi.unstubAllGlobals();
  });

  it("a second run against identical directory data violates none of the shared re-run invariants", async () => {
    stubFetch([STOCK, ZRAICK]);
    await syncRoster(db.client, API_URL);

    const before = await snapshotTables(db.client);
    stubFetch([STOCK, ZRAICK]);
    await syncRoster(db.client, API_URL);
    const after = await snapshotTables(db.client);

    expect(() => assertReRunInvariants(before, after)).not.toThrow();
  });

  it("a real mutation (a faculty member vanishing from the directory) still violates none of the shared invariants", async () => {
    stubFetch([STOCK, ZRAICK]);
    await syncRoster(db.client, API_URL);

    const before = await snapshotTables(db.client);
    stubFetch([STOCK]); // Zraick no longer present
    const summary = await syncRoster(db.client, API_URL);
    const after = await snapshotTables(db.client);

    expect(summary.deactivated).toBe(1); // the real mutation happened
    expect(() => assertReRunInvariants(before, after)).not.toThrow(); // and nothing else moved
  });

  it("★ last_alert_seen_at (§5a rule 4 — only the Scholar ingester writes this) survives a re-run untouched", async () => {
    stubFetch([STOCK]);
    await syncRoster(db.client, API_URL);
    await db.client.execute({
      sql: "UPDATE faculty SET last_alert_seen_at = ? WHERE wp_id = '1163'",
      args: ["2026-06-15T00:00:00.000Z"],
    });

    stubFetch([STOCK]);
    await syncRoster(db.client, API_URL);

    const row = await db.client.execute("SELECT last_alert_seen_at FROM faculty WHERE wp_id = '1163'");
    expect((row.rows[0] as unknown as { last_alert_seen_at: string }).last_alert_seen_at).toBe("2026-06-15T00:00:00.000Z");
  });
});
