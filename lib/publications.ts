// §8c Tab 4 (partial), Session 18: read-only query layer for the publications
// browser. Every function here is a SELECT — nothing in this file ever
// writes to publications.roundup_id or the roundups table. That guarantee
// is deliberate: stamping roundup_id is real, careful, one-way future work
// (§6b), not something this session touches.
import type { Client, InValue } from "@libsql/client";
import { unitsForPublication } from "./citation";
import type { Faculty, Publication, PublicationAuthor, PublicationStatus, Unit } from "./types";

export interface PublicationFilters {
  facultyQuery?: string;
  units?: Unit[];
  dateAddedFrom?: string;
  dateAddedTo?: string;
  status?: PublicationStatus[];
  excludeAlreadyPosted?: boolean;
}

export interface PublicationWithUnits {
  publication: Publication;
  authors: PublicationAuthor[];
  units: Unit[];
}

export async function queryPublications(client: Client, filters: PublicationFilters = {}): Promise<PublicationWithUnits[]> {
  const status = filters.status ?? ["published"];
  const excludeAlreadyPosted = filters.excludeAlreadyPosted ?? true;

  const conditions: string[] = [`p.status IN (${status.map(() => "?").join(",")})`];
  const args: InValue[] = [...status];

  if (excludeAlreadyPosted) conditions.push("p.roundup_id IS NULL");

  if (filters.dateAddedFrom) {
    conditions.push("p.date_added >= ?");
    args.push(filters.dateAddedFrom);
  }
  if (filters.dateAddedTo) {
    conditions.push("p.date_added <= ?");
    args.push(filters.dateAddedTo);
  }

  if (filters.facultyQuery) {
    conditions.push(`EXISTS (
      SELECT 1 FROM publication_authors pa2
      LEFT JOIN faculty f2 ON f2.id = pa2.faculty_id
      WHERE pa2.publication_id = p.id AND (pa2.name LIKE ? OR f2.display_name LIKE ?)
    )`);
    const likeQuery = `%${filters.facultyQuery}%`;
    args.push(likeQuery, likeQuery);
  }

  // Same condition lib/citation.ts::unitsForPublication encodes: role must
  // be 'chps_faculty' AND faculty_id must be linked — an unconfirmed name
  // match (role still 'unknown', faculty_id populated) never counts, here
  // or there. See tests/publications.test.ts's anti-drift test.
  if (filters.units && filters.units.length > 0) {
    conditions.push(`EXISTS (
      SELECT 1 FROM publication_authors pa3
      JOIN faculty f3 ON f3.id = pa3.faculty_id
      WHERE pa3.publication_id = p.id
        AND pa3.role = 'chps_faculty'
        AND pa3.faculty_id IS NOT NULL
        AND f3.unit IN (${filters.units.map(() => "?").join(",")})
    )`);
    args.push(...filters.units);
  }

  const sql = `SELECT p.* FROM publications p WHERE ${conditions.join(" AND ")} ORDER BY p.date_added, p.id`;
  const pubRows = (await client.execute({ sql, args })).rows as unknown as Publication[];

  const facultyRows = (await client.execute("SELECT * FROM faculty")).rows as unknown as Faculty[];
  const facultyById: Record<number, Faculty> = {};
  for (const f of facultyRows) facultyById[f.id] = f;

  const results: PublicationWithUnits[] = [];
  for (const pubRow of pubRows) {
    // Spread into genuinely plain objects/arrays — this crosses a Server ->
    // Client Component boundary (app/admin/publications/ExportPanel.tsx),
    // which requires plain objects. The libSQL driver's row/array
    // implementation isn't guaranteed to satisfy that on every transport.
    const pub = { ...pubRow };
    const authorRows = (
      await client.execute({ sql: "SELECT * FROM publication_authors WHERE publication_id = ? ORDER BY position", args: [pub.id] })
    ).rows as unknown as PublicationAuthor[];
    const authors = authorRows.map((a) => ({ ...a }));
    results.push({ publication: pub, authors, units: unitsForPublication(authors, facultyById) });
  }

  return results;
}
