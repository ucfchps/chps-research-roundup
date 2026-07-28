// §8a: the public portal's own submission path — distinct from
// lib/review-actions.ts::addMissingPublication (§8b, a *known* faculty
// identity) and lib/pending-submissions.ts (§8c Tab 1, the admin review
// side). An anonymous submitter has no faculty_id to link in, so this is a
// simplified three-outcome version of addMissingPublication's four-outcome
// handler: no "linked_you" branch, because there's no known "you" to link.
// Reuses lib/matching.ts::findMatch as-is — same DOI-then-title ladder
// every other duplicate check in this codebase uses, not reimplemented here.
import type { Client } from "@libsql/client";
import { findMatch, normalizeTitle, type MatchableExisting } from "./matching";
import type { PublicationSubmission } from "./review-actions";

export type PortalSubmitOutcome =
  | { outcome: "already_posted"; publicationId: number; roundupLabel: string | null }
  | { outcome: "already_pending"; publicationId: number }
  | { outcome: "submitted"; pendingSubmissionId: number };

export async function submitPublication(
  client: Client,
  submittedBy: string,
  submission: PublicationSubmission,
  note: string | null = null
): Promise<PortalSubmitOutcome> {
  const existing = (await client.execute("SELECT id, doi, title_normalized FROM publications")).rows as unknown as MatchableExisting[];
  const match = findMatch({ doi: submission.doi, title: submission.title }, existing);

  if (match.type === "MATCH") {
    const pub = (await client.execute({ sql: "SELECT roundup_id FROM publications WHERE id = ?", args: [match.publicationId] })).rows[0] as unknown as {
      roundup_id: number | null;
    };

    if (pub.roundup_id !== null) {
      const roundup = (await client.execute({ sql: "SELECT label FROM roundups WHERE id = ?", args: [pub.roundup_id] })).rows[0] as unknown as
        | { label: string }
        | undefined;
      return { outcome: "already_posted", publicationId: match.publicationId, roundupLabel: roundup?.label ?? null };
    }

    // Already collected, just not posted yet — nothing to create. Same
    // non-duplication principle as addMissingPublication's already_in_queue
    // outcome, without a known submitter to check "are they already linked."
    return { outcome: "already_pending", publicationId: match.publicationId };
  }

  const now = new Date().toISOString();
  const result = await client.execute({
    sql: `INSERT INTO pending_submissions (faculty_id, submitted_via, submitted_by, payload, note, status, submitted_at)
          VALUES (NULL, 'public_portal', ?, ?, ?, 'pending', ?)`,
    args: [submittedBy, JSON.stringify({ ...submission, titleNormalized: normalizeTitle(submission.title) }), note, now],
  });

  return { outcome: "submitted", pendingSubmissionId: Number(result.lastInsertRowid) };
}
