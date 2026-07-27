// §8c Tab 1: the admin side of a faculty self-submission (lib/review-actions.ts::
// addMissingPublication's "no match" outcome, §8b). The payload never carries
// an author list (confirmed via Session 26 recon — the review page's
// AddPublicationForm collects title/doi/url/journal/volume/issue/pages only)
// — the one author the system actually knows is the submitter, via
// pending_submissions.faculty_id. The review form seeds its author editor
// from that single known row; anything beyond it is the reviewer adding
// co-authors they know about, same trust level Session 25 gave a COMMS
// completion (role_set_by: "comms:{user}").
import type { Client } from "@libsql/client";
import { findMatch, normalizeTitle, type MatchableExisting } from "./matching";
import type { PublicationSubmission } from "./review-actions";
import type { AuthorRole, PendingSubmission, SubmissionStatus, SubmittedVia } from "./types";

export interface PendingSubmissionRecord {
  id: number;
  facultyId: number | null;
  submittedVia: SubmittedVia;
  submittedBy: string;
  payload: PublicationSubmission & { titleNormalized: string };
  note: string | null;
  status: SubmissionStatus;
  submittedAt: string;
}

export async function listPendingSubmissions(client: Client): Promise<PendingSubmissionRecord[]> {
  const rows = (
    await client.execute(
      "SELECT id, faculty_id, submitted_via, submitted_by, payload, note, status, submitted_at, reviewed_at, reviewed_by FROM pending_submissions WHERE status = 'pending' ORDER BY submitted_at"
    )
  ).rows as unknown as PendingSubmission[];

  return rows.map((r) => ({
    id: r.id,
    facultyId: r.faculty_id,
    submittedVia: r.submitted_via,
    submittedBy: r.submitted_by,
    payload: JSON.parse(r.payload),
    note: r.note,
    status: r.status,
    submittedAt: r.submitted_at,
  }));
}

// Read-only — a preview check so the list view can flag "a matching
// publication now exists" without a reviewer having to open the form and
// attempt approve first. The authoritative check re-runs at write time
// (approvePendingSubmission below); this is purely informational.
export async function checkForStaleMatch(client: Client, payload: PublicationSubmission): Promise<{ publicationId: number; finalized: boolean } | null> {
  const existing = (await client.execute("SELECT id, doi, title_normalized FROM publications")).rows as unknown as MatchableExisting[];
  const match = findMatch({ doi: payload.doi, title: payload.title }, existing);
  if (match.type !== "MATCH") return null;
  const pub = (await client.execute({ sql: "SELECT roundup_id FROM publications WHERE id = ?", args: [match.publicationId] })).rows[0] as unknown as {
    roundup_id: number | null;
  };
  return { publicationId: match.publicationId, finalized: pub.roundup_id !== null };
}

export interface ReviewAuthorInput {
  name: string;
  facultyId: number | null;
  role: AuthorRole;
}

export interface ApproveParams {
  reviewedBy: string;
  title: string;
  doi: string | null;
  url: string;
  journal: string | null;
  year: number | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  authors: ReviewAuthorInput[];
}

export type ApproveResult =
  | { outcome: "created"; publicationId: number }
  | { outcome: "linked_existing"; publicationId: number }
  | { outcome: "already_posted"; publicationId: number; roundupLabel: string | null }
  | { outcome: "not_pending"; currentStatus: SubmissionStatus };

export type RejectResult = { outcome: "rejected" } | { outcome: "not_pending"; currentStatus: SubmissionStatus };

// §7's "merge, never duplicate" applied to the staleness race Session 26
// recon flagged: a matching publication can land via routine ingestion
// between submission and review. Re-runs the exact findMatch ladder
// addMissingPublication used at submission time — if it now matches
// something, this does NOT create a duplicate. It mirrors
// addMissingPublication's own linked_you/already_posted branches (small,
// deliberate duplication of that ~15-line shape rather than refactoring
// lib/review-actions.ts, which this session doesn't touch).
export async function approvePendingSubmission(client: Client, submissionId: number, params: ApproveParams): Promise<ApproveResult> {
  const submission = (
    await client.execute({ sql: "SELECT faculty_id, status FROM pending_submissions WHERE id = ?", args: [submissionId] })
  ).rows[0] as unknown as { faculty_id: number | null; status: SubmissionStatus } | undefined;
  if (!submission) throw new Error(`No pending submission found with id ${submissionId}`);
  if (submission.status !== "pending") {
    return { outcome: "not_pending", currentStatus: submission.status };
  }

  const now = new Date().toISOString();
  const existing = (await client.execute("SELECT id, doi, title_normalized FROM publications")).rows as unknown as MatchableExisting[];
  const match = findMatch({ doi: params.doi, title: params.title }, existing);

  if (match.type === "MATCH") {
    const pubRow = (await client.execute({ sql: "SELECT roundup_id FROM publications WHERE id = ?", args: [match.publicationId] })).rows[0] as unknown as {
      roundup_id: number | null;
    };

    if (pubRow.roundup_id !== null) {
      const roundup = (await client.execute({ sql: "SELECT label FROM roundups WHERE id = ?", args: [pubRow.roundup_id] })).rows[0] as unknown as
        | { label: string }
        | undefined;
      // Already posted under an existing record — nothing to approve into.
      // Deliberately does not write; the reviewer's real action here is to
      // reject this submission as redundant, not force a duplicate.
      return { outcome: "already_posted", publicationId: match.publicationId, roundupLabel: roundup?.label ?? null };
    }

    if (submission.faculty_id !== null) {
      const alreadyLinked = await client.execute({
        sql: "SELECT 1 FROM publication_authors WHERE publication_id = ? AND faculty_id = ?",
        args: [match.publicationId, submission.faculty_id],
      });
      if (alreadyLinked.rows.length === 0) {
        const maxPosition = (
          await client.execute({ sql: "SELECT COALESCE(MAX(position), -1) as maxPos FROM publication_authors WHERE publication_id = ?", args: [match.publicationId] })
        ).rows[0] as unknown as { maxPos: number };
        const faculty = (await client.execute({ sql: "SELECT display_name FROM faculty WHERE id = ?", args: [submission.faculty_id] })).rows[0] as unknown as {
          display_name: string;
        };
        await client.execute({
          sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, 'chps_faculty', ?, ?, ?)`,
          args: [match.publicationId, submission.faculty_id, faculty.display_name, `faculty:${submission.faculty_id}`, now, maxPosition.maxPos + 1],
        });
      }
    }

    const updateResult = await client.execute({
      sql: "UPDATE pending_submissions SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'",
      args: [now, params.reviewedBy, submissionId],
    });
    if (updateResult.rowsAffected === 0) {
      const raced = (await client.execute({ sql: "SELECT status FROM pending_submissions WHERE id = ?", args: [submissionId] })).rows[0] as unknown as {
        status: SubmissionStatus;
      };
      return { outcome: "not_pending", currentStatus: raced.status };
    }

    return { outcome: "linked_existing", publicationId: match.publicationId };
  }

  // Genuinely novel, still — create the real publication. §6 schema: "A known
  // submitter should be auto-linked as a chps_faculty author on approval" —
  // guaranteed explicitly here via submission.faculty_id, not by trusting
  // the reviewer's edited author rows to still contain them.
  const authors: ReviewAuthorInput[] = [...params.authors];
  if (submission.faculty_id !== null && !authors.some((a) => a.facultyId === submission.faculty_id)) {
    const faculty = (await client.execute({ sql: "SELECT display_name FROM faculty WHERE id = ?", args: [submission.faculty_id] })).rows[0] as unknown as {
      display_name: string;
    };
    authors.push({ name: faculty.display_name, facultyId: submission.faculty_id, role: "chps_faculty" });
  }

  const tx = await client.transaction("write");
  try {
    const insertResult = await tx.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, journal, year, volume, issue, pages, status, source, first_seen_at, date_added, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 'manual', ?, ?, ?)`,
      args: [params.doi, params.title, normalizeTitle(params.title), params.url, params.journal, params.year, params.volume, params.issue, params.pages, now, now.slice(0, 10), now],
    });
    const publicationId = Number(insertResult.lastInsertRowid);

    for (let i = 0; i < authors.length; i++) {
      const a = authors[i];
      // The submitter's own row is self-attested (they submitted it) — same
      // "faculty:{id}" provenance addMissingPublication already uses.
      // Anything the reviewer added beyond that is COMMS-entered, Session
      // 25's "comms:{user}" convention.
      const roleSetBy = a.facultyId === submission.faculty_id ? `faculty:${submission.faculty_id}` : `comms:${params.reviewedBy}`;
      await tx.execute({
        sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [publicationId, a.facultyId, a.name, a.role, roleSetBy, now, i],
      });
    }

    const updateResult = await tx.execute({
      sql: "UPDATE pending_submissions SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'",
      args: [now, params.reviewedBy, submissionId],
    });
    if (updateResult.rowsAffected === 0) {
      // Raced between our initial read and this write (e.g. a second reviewer
      // tab). Roll back the publication insert entirely rather than leave an
      // orphaned publications row with no submission ever marked approved.
      await tx.rollback();
      const raced = (await client.execute({ sql: "SELECT status FROM pending_submissions WHERE id = ?", args: [submissionId] })).rows[0] as unknown as {
        status: SubmissionStatus;
      };
      return { outcome: "not_pending", currentStatus: raced.status };
    }

    await tx.commit();
    return { outcome: "created", publicationId };
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    await tx.close();
  }
}

export async function rejectPendingSubmission(client: Client, submissionId: number, reviewedBy: string): Promise<RejectResult> {
  const submission = (await client.execute({ sql: "SELECT status FROM pending_submissions WHERE id = ?", args: [submissionId] })).rows[0] as unknown as
    | { status: SubmissionStatus }
    | undefined;
  if (!submission) throw new Error(`No pending submission found with id ${submissionId}`);
  if (submission.status !== "pending") {
    return { outcome: "not_pending", currentStatus: submission.status };
  }

  const now = new Date().toISOString();
  const result = await client.execute({
    sql: "UPDATE pending_submissions SET status = 'rejected', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'",
    args: [now, reviewedBy, submissionId],
  });
  if (result.rowsAffected === 0) {
    const raced = (await client.execute({ sql: "SELECT status FROM pending_submissions WHERE id = ?", args: [submissionId] })).rows[0] as unknown as {
      status: SubmissionStatus;
    };
    return { outcome: "not_pending", currentStatus: raced.status };
  }

  return { outcome: "rejected" };
}
