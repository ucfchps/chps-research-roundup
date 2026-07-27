// Session 21 (§13.24 operational backfill) Task A: the reconcile logic,
// exercised against a throwaway temp-file DB standing in for "production
// that already has some of these papers" — never against real production.
// This is what de-risks running scripts/backfill-reconcile-2025.ts for real.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { runReconcile, resolveFacultyLink } from "../scripts/backfill-reconcile-2025";
import type { GroundTruthFixture } from "../lib/backfill-seed";
import type { Faculty } from "../lib/types";

function faculty(overrides: Partial<Faculty>): Faculty {
  return {
    id: 1, wp_id: "1", slug: "x", display_name: "Doe, J.", full_name: "Jane Doe", email: "j@x.com",
    unit: "Department of Health Sciences", research_profile_url: null, scholar_user_id: "ABC123AAAAJ",
    orcid: null, classification: "Faculty", active: 1, last_alert_seen_at: null, last_synced_at: null,
    ...overrides,
  };
}

// roster-verify-2025.ts uses this same function (not a raw exact-string DB
// query) so a fixture name with an extra initial or a diacritic the
// directory doesn't capture still resolves as found, not missing.
describe("resolveFacultyLink — tolerant matching roster-verify-2025.ts relies on", () => {
  it("matches a fixture name with an extra initial the directory doesn't capture", () => {
    const roster = [faculty({ id: 38, display_name: "Awan, S." })];
    expect(resolveFacultyLink("Awan, S.N.", roster)?.id).toBe(38);
  });

  it("matches a fixture name with a diacritic the directory's plain-ASCII spelling drops", () => {
    const roster = [faculty({ id: 83, display_name: "Lopez Castillo, H." })];
    expect(resolveFacultyLink("López Castillo, H.", roster)?.id).toBe(83);
  });
});

describe("runReconcile — Task A", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "backfill-reconcile-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  async function seedFaculty(displayName: string, unit: string): Promise<number> {
    const result = await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, unit, active) VALUES (?, ?, ?, ?, 1)`,
      args: [displayName, displayName, displayName, unit],
    });
    return Number(result.lastInsertRowid);
  }

  async function seedPublication(overrides: { title: string; doi?: string | null }): Promise<number> {
    const now = new Date().toISOString();
    const result = await client.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, status, source, first_seen_at, date_added, created_at)
            VALUES (?, ?, ?, 'https://example.com', 'published', 'crossref', ?, ?, ?)`,
      args: [overrides.doi ?? null, overrides.title, overrides.title.toLowerCase(), now, now.slice(0, 10), now],
    });
    return Number(result.lastInsertRowid);
  }

  async function seedAuthor(
    pubId: number,
    facultyId: number | null,
    name: string,
    role: string,
    position: number,
    roleSetBy: string | null = null
  ): Promise<number> {
    const result = await client.execute({
      sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, position) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [pubId, facultyId, name, role, roleSetBy, position],
    });
    return Number(result.lastInsertRowid);
  }

  function fixture(publications: GroundTruthFixture["publications"], faculty: GroundTruthFixture["faculty"] = []): GroundTruthFixture {
    return { edition: { label: "Test", title: "Test", intro: "", legend: "" }, faculty, publications };
  }

  it("matched publication: upgrades an ingest-'unknown' author's role to the fixture's human-verified grad_student", async () => {
    const facultyId = await seedFaculty("Stock, M.", "Department of Health Sciences");
    const pubId = await seedPublication({ title: "A Real Paper", doi: "10.1/real" });
    await seedAuthor(pubId, facultyId, "Stock, M.", "chps_faculty", 0, "ingest");
    await seedAuthor(pubId, null, "Torralba, L.", "unknown", 1, null);

    const { findings, summary } = await runReconcile(
      client,
      fixture([
        {
          key: "a-real-paper",
          title: "A Real Paper",
          journal: "J",
          year: 2025,
          volume: null,
          issue: null,
          pages: null,
          doi: "10.1/real",
          url: "https://example.com",
          units_in_post: ["Department of Health Sciences"],
          authors: [
            { name: "Stock, M.", position: 0, role: "chps_faculty", faculty_key: "stock" },
            { name: "Torralba, L.", position: 1, role: "grad_student" },
          ],
        },
      ]),
      { real: true }
    );

    expect(summary.matched).toBe(1);
    expect(summary.toInsert).toBe(0);
    expect(findings[0].authorChanges).toEqual([{ name: "Torralba, L.", before: "unknown", after: "grad_student" }]);

    const row = (await client.execute({ sql: "SELECT role, role_set_by FROM publication_authors WHERE publication_id = ? AND name = ?", args: [pubId, "Torralba, L."] }))
      .rows[0] as unknown as { role: string; role_set_by: string };
    expect(row.role).toBe("grad_student");
    expect(row.role_set_by).toBe("manual:backfill-2025");
  });

  // Regression: a matched (already-ingested) publication keeps whatever
  // date_added the REAL cron pipeline stamped it with (discovery time, not
  // the 2025 edition boundary) — production has 57 of these dated in 2026,
  // long after the fixture's own 2025-06-30 cutoff. §6's own schema comment
  // defines backfill date_added as "publish date of the roundup post it
  // came from" — for EVERY publication in this backfill, not just newly
  // inserted ones — or Task C's eligibility query silently excludes them.
  it("matched publication: corrects date_added to the backfill edition boundary, regardless of when the real pipeline discovered it", async () => {
    const pubId = await seedPublication({ title: "Discovered Much Later", doi: "10.1/late" });
    // seedPublication defaults date_added to today — simulate a real,
    // much-later ingest date explicitly.
    await client.execute({ sql: "UPDATE publications SET date_added = '2026-07-23' WHERE id = ?", args: [pubId] });

    await runReconcile(
      client,
      fixture([
        {
          key: "discovered-much-later",
          title: "Discovered Much Later",
          journal: "J",
          year: 2025,
          volume: null,
          issue: null,
          pages: null,
          doi: "10.1/late",
          url: "https://example.com",
          units_in_post: [],
          authors: [],
        },
      ]),
      { real: true }
    );

    const row = (await client.execute({ sql: "SELECT date_added FROM publications WHERE id = ?", args: [pubId] })).rows[0] as unknown as {
      date_added: string;
    };
    expect(row.date_added).toBe("2025-06-30");
  });

  it("does not overwrite a human-set role that disagrees with the fixture — reports it as a conflict instead", async () => {
    const pubId = await seedPublication({ title: "Disputed Paper", doi: "10.1/disputed" });
    await seedAuthor(pubId, null, "Sukhu, B.", "external", 0, "comms:jsmith"); // a human already reviewed this and said external

    const { findings } = await runReconcile(
      client,
      fixture([
        {
          key: "disputed-paper",
          title: "Disputed Paper",
          journal: "J",
          year: 2025,
          volume: null,
          issue: null,
          pages: null,
          doi: "10.1/disputed",
          url: "https://example.com",
          units_in_post: [],
          authors: [{ name: "Sukhu, B.", position: 0, role: "grad_student" }], // fixture disagrees
        },
      ]),
      { real: true }
    );

    expect(findings[0].humanConflicts).toEqual([{ name: "Sukhu, B.", fixtureRole: "grad_student", productionRole: "external", roleSetBy: "comms:jsmith" }]);
    expect(findings[0].authorChanges).toEqual([]);

    const row = (await client.execute({ sql: "SELECT role FROM publication_authors WHERE publication_id = ?", args: [pubId] })).rows[0] as unknown as {
      role: string;
    };
    expect(row.role).toBe("external"); // untouched
  });

  it("no match: inserts the publication as published/unposted/manual with its full author list", async () => {
    const { findings, summary } = await runReconcile(
      client,
      fixture([
        {
          key: "genuinely-new-paper",
          title: "Genuinely New Paper",
          journal: "New Journal",
          year: 2025,
          volume: "1",
          issue: "2",
          pages: "3-4",
          doi: null,
          url: "https://example.com/new",
          units_in_post: ["Department of Health Sciences"],
          authors: [{ name: "Newcomer, N.", position: 0, role: "external" }],
        },
      ]),
      { real: true }
    );

    expect(summary.toInsert).toBe(1);
    expect(findings[0].matchType).toBe("new");

    const pub = (await client.execute("SELECT * FROM publications WHERE title = 'Genuinely New Paper'")).rows[0] as unknown as {
      status: string;
      roundup_id: number | null;
      source: string;
    };
    expect(pub.status).toBe("published");
    expect(pub.roundup_id).toBeNull();
    expect(pub.source).toBe("manual");

    const authorCount = (await client.execute("SELECT COUNT(*) as c FROM publication_authors")).rows[0] as unknown as { c: number };
    expect(authorCount.c).toBe(1);
  });

  // Regression: a real production run inserted 98 publications whose
  // title_normalized was computed with a plain .toLowerCase() instead of
  // the real normalizeTitle() (strip punctuation/diacritics/whitespace) —
  // any title with a comma or colon then failed to re-match on the very
  // next reconcile pass, which would have inserted a hard duplicate on a
  // second --real run. This title is deliberately punctuation-heavy.
  it("a newly-inserted publication with punctuation in its title is found as a MATCH on the very next reconcile pass (no duplicate insert)", async () => {
    const f = fixture([
      {
        key: "punctuated-title-paper",
        title: "Vocal-Gender Incongruence, Wellbeing, and Safety: The Medical Necessity",
        journal: "J",
        year: 2025,
        volume: null,
        issue: null,
        pages: null,
        doi: null,
        url: "https://example.com/punct",
        units_in_post: [],
        authors: [{ name: "Someone, S.", position: 0, role: "external" }],
      },
    ]);

    const first = await runReconcile(client, f, { real: true });
    expect(first.summary.toInsert).toBe(1);

    const second = await runReconcile(client, f, { real: true });
    expect(second.summary.toInsert).toBe(0);
    expect(second.summary.matched).toBe(1);

    const pubCount = (await client.execute("SELECT COUNT(*) as c FROM publications")).rows[0] as unknown as { c: number };
    expect(pubCount.c).toBe(1); // never duplicated
  });

  it("reports a chps_faculty author that can't be linked to any production faculty row", async () => {
    const pubId = await seedPublication({ title: "Unlinkable Paper", doi: "10.1/unlinkable" });
    await seedAuthor(pubId, null, "Ghost, G.", "unknown", 0);

    const { findings } = await runReconcile(
      client,
      fixture([
        {
          key: "unlinkable-paper",
          title: "Unlinkable Paper",
          journal: "J",
          year: 2025,
          volume: null,
          issue: null,
          pages: null,
          doi: "10.1/unlinkable",
          url: "https://example.com",
          units_in_post: [],
          authors: [{ name: "Ghost, G.", position: 0, role: "chps_faculty", faculty_key: "ghost" }],
        },
      ]),
      { real: true }
    );

    expect(findings[0].unlinkedChpsFaculty).toEqual(["Ghost, G."]);
  });

  it("dry-run still reports an unlinked chps_faculty author for a would-be-inserted (new) publication", async () => {
    const { findings, summary } = await runReconcile(
      client,
      fixture([
        {
          key: "new-with-unlinked-faculty",
          title: "New With Unlinked Faculty",
          journal: "J",
          year: 2025,
          volume: null,
          issue: null,
          pages: null,
          doi: null,
          url: "https://example.com/new2",
          units_in_post: ["Department of Health Sciences"],
          authors: [{ name: "Ghost, G.", position: 0, role: "chps_faculty", faculty_key: "ghost" }],
        },
      ]),
      { real: false }
    );

    expect(summary.toInsert).toBe(1);
    expect(findings[0].unlinkedChpsFaculty).toEqual(["Ghost, G."]);

    const pubCount = (await client.execute("SELECT COUNT(*) as c FROM publications")).rows[0] as unknown as { c: number };
    expect(pubCount.c).toBe(0); // still nothing written
  });

  it("dry-run (real: false) writes nothing at all", async () => {
    const pubId = await seedPublication({ title: "Dry Run Paper", doi: "10.1/dryrun" });
    await seedAuthor(pubId, null, "Torralba, L.", "unknown", 0);

    await runReconcile(
      client,
      fixture([
        {
          key: "dry-run-paper",
          title: "Dry Run Paper",
          journal: "J",
          year: 2025,
          volume: null,
          issue: null,
          pages: null,
          doi: "10.1/dryrun",
          url: "https://example.com",
          units_in_post: [],
          authors: [{ name: "Torralba, L.", position: 0, role: "grad_student" }],
        },
        {
          key: "would-be-new",
          title: "Would Be New",
          journal: "J",
          year: 2025,
          volume: null,
          issue: null,
          pages: null,
          doi: null,
          url: "https://example.com/new",
          units_in_post: [],
          authors: [{ name: "Nobody, N.", position: 0, role: "external" }],
        },
      ]),
      { real: false }
    );

    const row = (await client.execute({ sql: "SELECT role FROM publication_authors WHERE publication_id = ?", args: [pubId] })).rows[0] as unknown as {
      role: string;
    };
    expect(row.role).toBe("unknown"); // untouched — dry run

    const pubCount = (await client.execute("SELECT COUNT(*) as c FROM publications")).rows[0] as unknown as { c: number };
    expect(pubCount.c).toBe(1); // "Would Be New" was NOT inserted
  });

  it("idempotent: running the real reconcile twice makes no changes the second time", async () => {
    const pubId = await seedPublication({ title: "Idempotent Paper", doi: "10.1/idempotent" });
    await seedAuthor(pubId, null, "Torralba, L.", "unknown", 0);

    const f = fixture([
      {
        key: "idempotent-paper",
        title: "Idempotent Paper",
        journal: "J",
        year: 2025,
        volume: null,
        issue: null,
        pages: null,
        doi: "10.1/idempotent",
        url: "https://example.com",
        units_in_post: [],
        authors: [{ name: "Torralba, L.", position: 0, role: "grad_student" }],
      },
    ]);

    const first = await runReconcile(client, f, { real: true });
    expect(first.summary.totalAuthorChanges).toBe(1);

    const second = await runReconcile(client, f, { real: true });
    expect(second.summary.totalAuthorChanges).toBe(0);
    expect(second.summary.totalNewAuthors).toBe(0);
  });
});
