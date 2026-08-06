// Phase 5 hardening, Session 1: seed factories for the real schema. Sensible
// defaults for every NOT NULL column, everything overridable. Each builder
// returns the inserted row's id (or ids, for multi-row builders) so a test
// can chain further seeding without re-querying.
import type { Client } from "@libsql/client";
import type { AuthorRole, PublicationStatus, PublicationSource, Unit } from "../../lib/types";

// Monotonic, not random — collisions are only possible within one test's own
// DB, and a plain counter makes a failing test's seeded data easy to read
// back (wp_id "wp-3" is legible; a UUID is not).
let counter = 0;
function nextId(): number {
  counter += 1;
  return counter;
}

export interface SeedFacultyOptions {
  wp_id?: string;
  slug?: string;
  display_name?: string;
  full_name?: string | null;
  email?: string | null;
  unit?: Unit | null;
  research_profile_url?: string | null;
  scholar_user_id?: string | null;
  orcid?: string | null;
  classification?: string | null;
  active?: number;
}

export async function seedFaculty(client: Client, overrides: SeedFacultyOptions = {}): Promise<number> {
  const n = nextId();
  const o = {
    wp_id: `wp-${n}`,
    slug: `faculty-${n}`,
    display_name: `Test, F${n}.`,
    full_name: `Faculty Testperson ${n}`,
    email: `faculty${n}@example.edu`,
    unit: "Department of Health Sciences" as Unit,
    research_profile_url: null,
    scholar_user_id: null,
    orcid: null,
    classification: "Faculty",
    active: 1,
    ...overrides,
  };
  const result = await client.execute({
    sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, research_profile_url, scholar_user_id, orcid, classification, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [o.wp_id, o.slug, o.display_name, o.full_name, o.email, o.unit, o.research_profile_url, o.scholar_user_id, o.orcid, o.classification, o.active],
  });
  return Number(result.lastInsertRowid);
}

export interface SeedPublicationOptions {
  doi?: string | null;
  title?: string;
  url?: string;
  journal?: string | null;
  year?: number | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  status?: PublicationStatus;
  source?: PublicationSource;
  first_seen_at?: string;
  date_added?: string;
  released_at?: string | null;
  roundup_id?: number | null;
  discovered_by_faculty_id?: number | null;
  scholar_alert_url?: string | null;
}

export async function seedPublication(client: Client, overrides: SeedPublicationOptions = {}): Promise<number> {
  const n = nextId();
  const now = new Date().toISOString();
  const title = overrides.title ?? `Test Publication ${n}`;
  const o = {
    doi: null,
    title,
    url: `https://example.com/pub-${n}`,
    journal: "Journal of Testing",
    year: 2026,
    volume: "1",
    issue: "1",
    pages: "1-10",
    status: "published" as PublicationStatus,
    source: "manual" as PublicationSource,
    first_seen_at: now,
    date_added: now.slice(0, 10),
    released_at: null,
    roundup_id: null,
    discovered_by_faculty_id: null,
    scholar_alert_url: null,
    ...overrides,
  };
  const result = await client.execute({
    sql: `INSERT INTO publications
            (doi, title, title_normalized, url, journal, year, volume, issue, pages, status, source, first_seen_at, date_added, released_at, roundup_id, created_at, discovered_by_faculty_id, scholar_alert_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      o.doi, o.title, o.title.toLowerCase(), o.url, o.journal, o.year, o.volume, o.issue, o.pages,
      o.status, o.source, o.first_seen_at, o.date_added, o.released_at, o.roundup_id, now,
      o.discovered_by_faculty_id, o.scholar_alert_url,
    ],
  });
  return Number(result.lastInsertRowid);
}

export interface SeedAuthorOptions {
  faculty_id?: number | null;
  name?: string;
  role?: AuthorRole;
  role_set_by?: string | null;
  role_set_at?: string | null;
  position?: number;
}

// Inserts one row per entry in `authors`, positions defaulting to array
// index (matching the real "position derives from array order, never a
// caller-supplied field" convention every real write path follows).
export async function seedAuthors(client: Client, publicationId: number, authors: SeedAuthorOptions[]): Promise<void> {
  for (let i = 0; i < authors.length; i++) {
    const a = authors[i];
    const n = nextId();
    const o = {
      faculty_id: null,
      name: `Author, T${n}.`,
      role: "unknown" as AuthorRole,
      role_set_by: null,
      role_set_at: null,
      position: i,
      ...a,
    };
    await client.execute({
      sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [publicationId, o.faculty_id, o.name, o.role, o.role_set_by, o.role_set_at, o.position],
    });
  }
}

export interface SeedRoundupOptions {
  label?: string;
  generated_at?: string;
  generated_by?: string | null;
  pub_count?: number;
  html?: string;
}

export async function seedRoundup(client: Client, overrides: SeedRoundupOptions = {}): Promise<number> {
  const n = nextId();
  const o = {
    label: `Test Edition ${n}`,
    generated_at: new Date().toISOString(),
    generated_by: "Test Harness",
    pub_count: 0,
    html: `<html><body>Test edition ${n}</body></html>`,
    ...overrides,
  };
  const result = await client.execute({
    sql: `INSERT INTO roundups (label, generated_at, generated_by, pub_count, html) VALUES (?, ?, ?, ?, ?)`,
    args: [o.label, o.generated_at, o.generated_by, o.pub_count, o.html],
  });
  return Number(result.lastInsertRowid);
}

export interface SeedReviewRequestOptions {
  faculty_id: number;
  token_hash?: string;
  slug?: string;
  cycle_label?: string | null;
  created_at?: string;
  expires_at?: string;
  opened_at?: string | null;
  completed_at?: string | null;
  revoked?: number;
}

export async function seedReviewRequest(client: Client, overrides: SeedReviewRequestOptions): Promise<number> {
  const n = nextId();
  const now = new Date();
  const o = {
    token_hash: `test-token-hash-${n}`,
    slug: `test-faculty-${n}`,
    cycle_label: null,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 90 * 86400000).toISOString(),
    opened_at: null,
    completed_at: null,
    revoked: 0,
    ...overrides,
  };
  const result = await client.execute({
    sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, cycle_label, created_at, expires_at, opened_at, completed_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [o.faculty_id, o.token_hash, o.slug, o.cycle_label, o.created_at, o.expires_at, o.opened_at, o.completed_at, o.revoked],
  });
  return Number(result.lastInsertRowid);
}

// ★ The 4,109-row production state Session 0's diagnostics found: a name
// matched a roster faculty member, but affiliation never confirmed it — role
// stays 'unknown', faculty_id is set as a reviewable hint only, never a
// confirmed link. Real convention: role_set_by tags which no-affiliation-data
// bucket produced it (see docs/ops-notes.md §5).
export async function seedUnconfirmedMatch(
  client: Client,
  overrides: { facultyId?: number; publicationId?: number; authorName?: string } = {}
): Promise<{ facultyId: number; publicationId: number }> {
  const facultyId = overrides.facultyId ?? (await seedFaculty(client));
  const publicationId = overrides.publicationId ?? (await seedPublication(client, { status: "pending_merge", source: "pubmed" }));
  await seedAuthors(client, publicationId, [
    {
      faculty_id: facultyId,
      name: overrides.authorName,
      role: "unknown",
      role_set_by: "ingest:unconfirmed_name_match",
      role_set_at: new Date().toISOString(),
    },
  ]);
  return { facultyId, publicationId };
}

// §6a: a publication co-authored by CHPS faculty from two different units
// must appear in both units' sections. The single most-exercised composite
// shape across this codebase's existing tests, promoted here so future
// hardening tests don't hand-roll it again.
export async function seedTwoUnitPaper(
  client: Client,
  overrides: { unitA?: Unit; unitB?: Unit; publication?: SeedPublicationOptions } = {}
): Promise<{ publicationId: number; facultyIdA: number; facultyIdB: number }> {
  const unitA = overrides.unitA ?? "Department of Health Sciences";
  const unitB = overrides.unitB ?? "School of Social Work";
  const facultyIdA = await seedFaculty(client, { unit: unitA });
  const facultyIdB = await seedFaculty(client, { unit: unitB });
  const publicationId = await seedPublication(client, { status: "published", ...overrides.publication });
  await seedAuthors(client, publicationId, [
    { faculty_id: facultyIdA, role: "chps_faculty", role_set_by: "ingest" },
    { faculty_id: facultyIdB, role: "chps_faculty", role_set_by: "ingest" },
  ]);
  return { publicationId, facultyIdA, facultyIdB };
}

// A finalized edition: a real roundups row plus N publications stamped with
// its id, status='published'. `publicationCount` publications are created if
// no explicit ids are given.
export async function seedFinalizedRoundup(
  client: Client,
  overrides: { roundup?: SeedRoundupOptions; publicationCount?: number; publicationIds?: number[] } = {}
): Promise<{ roundupId: number; publicationIds: number[] }> {
  const publicationIds = overrides.publicationIds ?? [];
  const count = overrides.publicationCount ?? (publicationIds.length > 0 ? 0 : 1);

  const roundupId = await seedRoundup(client, { pub_count: publicationIds.length + count, ...overrides.roundup });

  for (let i = 0; i < count; i++) {
    publicationIds.push(await seedPublication(client, { status: "published", roundup_id: roundupId }));
  }
  if (overrides.publicationIds) {
    const placeholders = overrides.publicationIds.map(() => "?").join(",");
    await client.execute({
      sql: `UPDATE publications SET status = 'published', roundup_id = ? WHERE id IN (${placeholders})`,
      args: [roundupId, ...overrides.publicationIds],
    });
  }

  return { roundupId, publicationIds };
}
