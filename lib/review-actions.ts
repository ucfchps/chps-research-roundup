// §8b write-side actions for the personal review page. Every function here
// re-validates scope against the DB using the token-derived facultyId — a
// client-supplied publicationAuthorId/publicationId is never trusted on its
// own. Functions return false (never throw) when the target row isn't
// eligible/in-scope, so callers can show a generic "couldn't do that"
// message without leaking why.
import type { Client, InValue } from "@libsql/client";
import { findMatch, normalizeTitle, type MatchableExisting } from "./matching";
import type { AuthorRole } from "./types";

const TAGGABLE_ROLES: readonly AuthorRole[] = ["chps_faculty", "grad_student", "undergrad_student", "external"];

// §8b: "Tag co-author roles." Only ever touches a row that is (a) currently
// unknown and (b) either genuinely unidentified (faculty_id NULL — the actual
// "who is this person" case) or the reviewing faculty's OWN row (the
// Zhu/Dykstra shape: confirming your own unconfirmed row is just tagging it
// 'chps_faculty'). A row already linked to a DIFFERENT real faculty member
// (e.g. Dykstra's own pending row) is never touchable by Zhu — only Dykstra
// can confirm or reject his own attribution.
export async function setCoAuthorRole(client: Client, facultyId: number, publicationAuthorId: number, role: AuthorRole): Promise<boolean> {
  if (!TAGGABLE_ROLES.includes(role)) {
    throw new Error(`"${role}" is not a plain-language role option — never expose "unknown" as a target`);
  }

  const result = await client.execute({
    sql: `UPDATE publication_authors
          SET role = ?, role_set_by = ?, role_set_at = ?
          WHERE id = ?
            AND role = 'unknown'
            AND (faculty_id IS NULL OR faculty_id = ?)
            AND EXISTS (
              SELECT 1 FROM publication_authors pa2
              WHERE pa2.publication_id = publication_authors.publication_id AND pa2.faculty_id = ?
            )`,
    args: [role, `faculty:${facultyId}`, new Date().toISOString(), publicationAuthorId, facultyId, facultyId],
  });

  return result.rowsAffected > 0;
}

// §8b: "This isn't my paper." Unlinks ONLY the reviewing faculty member's own
// row (faculty_id -> NULL, role -> unknown) — never deleted, never touches
// any other author row on the same publication. role_set_by keeps the
// 'faculty:' prefix (so mergeAuthors' isHumanSet guard still protects it from
// being silently overwritten) while being distinguishable from a normal
// confirmation, and gives COMMS a visible trail via report-rejected-attributions.ts.
export async function rejectAuthorAttribution(client: Client, facultyId: number, publicationAuthorId: number): Promise<boolean> {
  const result = await client.execute({
    sql: `UPDATE publication_authors
          SET faculty_id = NULL, role = 'unknown', role_set_by = ?, role_set_at = ?
          WHERE id = ? AND faculty_id = ?`,
    args: [`faculty:${facultyId}:rejected`, new Date().toISOString(), publicationAuthorId, facultyId],
  });

  return result.rowsAffected > 0;
}

export interface CitationEditFields {
  title?: string;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
}

// §8b: "Fix citation details" — applied immediately (no COMMS gate, they're
// the author), but every changed field is logged to citation_edits for
// provenance. Only the publication's own faculty may edit it.
export async function editCitation(client: Client, facultyId: number, publicationId: number, fields: CitationEditFields): Promise<boolean> {
  const linked = await client.execute({
    sql: `SELECT 1 FROM publication_authors WHERE publication_id = ? AND faculty_id = ?`,
    args: [publicationId, facultyId],
  });
  if (linked.rows.length === 0) return false;

  const current = (
    await client.execute({
      sql: "SELECT title, journal, volume, issue, pages FROM publications WHERE id = ?",
      args: [publicationId],
    })
  ).rows[0] as unknown as { title: string; journal: string | null; volume: string | null; issue: string | null; pages: string | null } | undefined;
  if (!current) return false;

  const now = new Date().toISOString();
  const setClauses: string[] = [];
  const setArgs: InValue[] = [];

  for (const field of ["title", "journal", "volume", "issue", "pages"] as const) {
    const newValue = fields[field];
    if (newValue === undefined) continue;
    const oldValue = current[field];
    if (newValue === oldValue) continue;

    setClauses.push(`${field} = ?`);
    setArgs.push(newValue);
    await client.execute({
      sql: `INSERT INTO citation_edits (publication_id, faculty_id, field, old_value, new_value, edited_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [publicationId, facultyId, field, oldValue, newValue, now],
    });
  }

  if (setClauses.length > 0) {
    await client.execute({
      sql: `UPDATE publications SET ${setClauses.join(", ")} WHERE id = ?`,
      args: [...setArgs, publicationId],
    });
  }

  return true;
}

export interface PublicationSubmission {
  title: string;
  doi: string | null;
  url: string;
  journal?: string | null;
  year?: number | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
}

export type AddPublicationOutcome =
  | { outcome: "already_posted"; publicationId: number; roundupLabel: string | null }
  | { outcome: "already_in_queue"; publicationId: number }
  | { outcome: "linked_you"; publicationId: number }
  | { outcome: "pending_submission"; pendingSubmissionId: number };

// §8b "Duplicate handling on 'add a missing publication'": match against ALL
// publications via §7's ladder (DOI -> normalized title; fuzzy is out of
// scope, see lib/matching-ai.ts), then branch on the four outcomes. The third
// outcome (found, but this faculty isn't listed on it) is a name-matching-miss
// fix, not a duplicate — it links them in, it does not create a second record.
export async function addMissingPublication(client: Client, facultyId: number, submission: PublicationSubmission): Promise<AddPublicationOutcome> {
  const existing = (
    await client.execute("SELECT id, doi, title_normalized FROM publications")
  ).rows as unknown as MatchableExisting[];

  const match = findMatch({ doi: submission.doi, title: submission.title }, existing);

  if (match.type === "MATCH") {
    const pub = (
      await client.execute({
        sql: "SELECT roundup_id FROM publications WHERE id = ?",
        args: [match.publicationId],
      })
    ).rows[0] as unknown as { roundup_id: number | null };

    if (pub.roundup_id !== null) {
      const roundup = (
        await client.execute({ sql: "SELECT label FROM roundups WHERE id = ?", args: [pub.roundup_id] })
      ).rows[0] as unknown as { label: string } | undefined;
      return { outcome: "already_posted", publicationId: match.publicationId, roundupLabel: roundup?.label ?? null };
    }

    const alreadyLinked = await client.execute({
      sql: "SELECT 1 FROM publication_authors WHERE publication_id = ? AND faculty_id = ?",
      args: [match.publicationId, facultyId],
    });
    if (alreadyLinked.rows.length > 0) {
      return { outcome: "already_in_queue", publicationId: match.publicationId };
    }

    // ★ Name-matching miss: the paper exists, this faculty just isn't linked
    // to it. Add them, don't duplicate the publication record.
    const maxPosition = (
      await client.execute({
        sql: "SELECT COALESCE(MAX(position), -1) as maxPos FROM publication_authors WHERE publication_id = ?",
        args: [match.publicationId],
      })
    ).rows[0] as unknown as { maxPos: number };

    const faculty = (
      await client.execute({ sql: "SELECT display_name FROM faculty WHERE id = ?", args: [facultyId] })
    ).rows[0] as unknown as { display_name: string };

    await client.execute({
      sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position)
            VALUES (?, ?, ?, 'chps_faculty', ?, ?, ?)`,
      args: [match.publicationId, facultyId, faculty.display_name, `faculty:${facultyId}`, new Date().toISOString(), maxPosition.maxPos + 1],
    });

    return { outcome: "linked_you", publicationId: match.publicationId };
  }

  // No match -> genuine new submission, held for COMMS review (same gate as §8a).
  const faculty = (
    await client.execute({ sql: "SELECT display_name FROM faculty WHERE id = ?", args: [facultyId] })
  ).rows[0] as unknown as { display_name: string };

  const now = new Date().toISOString();
  const result = await client.execute({
    sql: `INSERT INTO pending_submissions (faculty_id, submitted_via, submitted_by, payload, status, submitted_at)
          VALUES (?, 'review_page', ?, ?, 'pending', ?)`,
    args: [facultyId, faculty.display_name, JSON.stringify({ ...submission, titleNormalized: normalizeTitle(submission.title) }), now],
  });

  return { outcome: "pending_submission", pendingSubmissionId: Number(result.lastInsertRowid) };
}
