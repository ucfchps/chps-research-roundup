// Session 20 (§13.24): Task A — clean-room seed for the whole-system
// acceptance test. Loads tests/fixtures/backfill/ground-truth-2025.json into
// a scratch DB via the real insert paths (same shape ingest/manual-approval
// code would write), so Task B exercises the real generator against real
// rows, not a shortcut. This file only loads data — it never formats a
// citation or derives a unit; that's lib/citation.ts's job, exercised later.
import type { Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeTitle } from "./matching";
import type { AuthorRole } from "./types";

export interface GroundTruthFaculty {
  key: string;
  display_name: string;
  full_name: string | null;
  unit: string | null;
}

export interface GroundTruthAuthor {
  name: string;
  position: number;
  role: AuthorRole;
  faculty_key?: string;
}

export interface ExpectedDiff {
  field: string;
  post_said: string;
  corrected: string;
  reason: string;
}

export interface GroundTruthPublication {
  key: string;
  title: string;
  journal: string;
  year: number | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  url: string;
  units_in_post: string[];
  authors: GroundTruthAuthor[];
  expected_diffs?: ExpectedDiff[];
}

export interface GroundTruthEdition {
  label: string;
  title: string;
  intro: string;
  legend: string;
}

export interface GroundTruthFixture {
  edition: GroundTruthEdition;
  faculty: GroundTruthFaculty[];
  publications: GroundTruthPublication[];
}

const DEFAULT_FIXTURE_PATH = path.join(__dirname, "..", "tests", "fixtures", "backfill", "ground-truth-2025.json");

// Keys are `_`-prefixed on the raw JSON's annotation fields (_review, _meta,
// _post_tail_raw, _variants, _TODO, _inferred_unit, _ambiguous_units,
// expected_diffs is NOT `_`-prefixed but is also human annotation, not
// seed data) — JSON.parse already gives us exactly the fields we declared
// above via structural typing; we simply never read the `_`-prefixed ones.
export function loadGroundTruth(fixturePath: string = DEFAULT_FIXTURE_PATH): GroundTruthFixture {
  const raw = readFileSync(fixturePath, "utf-8");
  return JSON.parse(raw) as GroundTruthFixture;
}

export interface SeedSummary {
  facultyCount: number;
  publicationCount: number;
  authorCount: number;
  facultyIdByKey: Record<string, number>;
}

// The backfill's date_added: "publish date of the roundup post it came
// from" (§6, publications.date_added) — one date for the whole batch, not
// per-paper, matching how a real backfill would stamp it.
const BACKFILL_DATE_ADDED = "2025-06-30";

// Idempotent: clears the four tables this function owns and reinserts from
// the fixture, so running it twice yields the same rows, never duplicates.
// Safe only because this is a scratch DB dedicated to this one purpose.
export async function seedGroundTruth(client: Client, fixture: GroundTruthFixture): Promise<SeedSummary> {
  await client.execute("DELETE FROM publication_authors");
  await client.execute("DELETE FROM publications");
  await client.execute("DELETE FROM roundups");
  await client.execute("DELETE FROM faculty");

  const facultyIdByKey: Record<string, number> = {};
  for (const f of fixture.faculty) {
    const result = await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, unit, active) VALUES (?, ?, ?, ?, ?, 1)`,
      args: [f.key, f.key, f.display_name, f.full_name ?? null, f.unit ?? null],
    });
    facultyIdByKey[f.key] = Number(result.lastInsertRowid);
  }

  let authorCount = 0;
  const now = new Date().toISOString();
  for (const p of fixture.publications) {
    const pubResult = await client.execute({
      sql: `INSERT INTO publications
              (doi, title, title_normalized, url, journal, year, volume, issue, pages, status, source, first_seen_at, date_added, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 'manual', ?, ?, ?)`,
      args: [
        p.doi ?? null,
        p.title,
        normalizeTitle(p.title),
        p.url,
        p.journal || null,
        p.year ?? null,
        p.volume ?? null,
        p.issue ?? null,
        p.pages ?? null,
        now,
        BACKFILL_DATE_ADDED,
        now,
      ],
    });
    const pubId = Number(pubResult.lastInsertRowid);

    for (const a of p.authors) {
      const facultyId = a.faculty_key ? (facultyIdByKey[a.faculty_key] ?? null) : null;
      if (a.faculty_key && facultyId === null) {
        throw new Error(`Fixture references unknown faculty_key "${a.faculty_key}" (publication "${p.key}")`);
      }
      await client.execute({
        sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, position) VALUES (?, ?, ?, ?, ?)`,
        args: [pubId, facultyId, a.name, a.role, a.position],
      });
      authorCount++;
    }
  }

  return {
    facultyCount: fixture.faculty.length,
    publicationCount: fixture.publications.length,
    authorCount,
    facultyIdByKey,
  };
}
