// §8b: scoped data access for the personal review page. Every exported
// function here takes facultyId derived from an already-validated token —
// callers must never pass the {slug} URL segment in its place (the slug is
// cosmetic/display-only, never an auth boundary).
import type { Client } from "@libsql/client";
import { generateReviewToken, hashToken } from "./tokens";
import type { PublicationAuthor, ReviewRequest } from "./types";

export async function getReviewRequestByToken(client: Client, token: string): Promise<ReviewRequest | null> {
  const tokenHash = hashToken(token);
  const result = await client.execute({
    sql: "SELECT * FROM review_requests WHERE token_hash = ?",
    args: [tokenHash],
  });
  const row = result.rows[0] as unknown as ReviewRequest | undefined;
  if (!row) return null;
  if (row.revoked) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export async function markReviewRequestOpened(client: Client, reviewRequestId: number): Promise<void> {
  await client.execute({
    sql: "UPDATE review_requests SET opened_at = ? WHERE id = ? AND opened_at IS NULL",
    args: [new Date().toISOString(), reviewRequestId],
  });
}

// §8b's "I'm done reviewing" — idempotent, and scoped by id match (same shape
// as lib/review-actions.ts's identity-based checks), not by anything looser.
export async function markReviewComplete(client: Client, reviewRequestId: number): Promise<void> {
  await client.execute({
    sql: "UPDATE review_requests SET completed_at = ? WHERE id = ? AND completed_at IS NULL",
    args: [new Date().toISOString(), reviewRequestId],
  });
}

// The one and only place a review_requests row is ever inserted — both
// scripts/mint-review-token.ts's single-person mint and the campaign tool's
// batch mint call this, so there is exactly one code path that ever writes
// this table. cycleLabel is null for an ad hoc mint (not part of a campaign).
export async function createReviewRequest(
  client: Client,
  facultyId: number,
  ttlDays: number,
  cycleLabel: string | null
): Promise<{ token: string; slug: string }> {
  const facultyResult = await client.execute({
    sql: "SELECT slug, wp_id FROM faculty WHERE id = ?",
    args: [facultyId],
  });
  const faculty = facultyResult.rows[0] as unknown as { slug: string | null; wp_id: string | null } | undefined;
  if (!faculty) throw new Error(`No faculty found with id ${facultyId}`);

  const { token, tokenHash } = generateReviewToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 86400000);
  const slug = faculty.slug ?? faculty.wp_id ?? String(facultyId);

  await client.execute({
    sql: `INSERT INTO review_requests (faculty_id, token_hash, slug, cycle_label, created_at, expires_at, revoked)
          VALUES (?, ?, ?, ?, ?, ?, 0)`,
    args: [facultyId, tokenHash, slug, cycleLabel, now.toISOString(), expiresAt.toISOString()],
  });

  return { token, slug };
}

export interface ReviewablePublication {
  id: number;
  doi: string | null;
  title: string;
  url: string;
  journal: string | null;
  year: number | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  authors: PublicationAuthor[];
  unknownRoleAuthors: PublicationAuthor[];
}

export async function getReviewablePublications(client: Client, facultyId: number): Promise<ReviewablePublication[]> {
  const pubResult = await client.execute({
    sql: `SELECT p.* FROM publications p
          WHERE p.roundup_id IS NULL
            AND p.status != 'rejected'
            AND EXISTS (
              SELECT 1 FROM publication_authors pa
              WHERE pa.publication_id = p.id AND pa.faculty_id = ?
            )
          ORDER BY p.id`,
    args: [facultyId],
  });

  const publications: ReviewablePublication[] = [];
  for (const row of pubResult.rows as unknown as Array<{
    id: number;
    doi: string | null;
    title: string;
    url: string;
    journal: string | null;
    year: number | null;
    volume: string | null;
    issue: string | null;
    pages: string | null;
  }>) {
    const authorResult = await client.execute({
      sql: "SELECT * FROM publication_authors WHERE publication_id = ? ORDER BY position",
      args: [row.id],
    });
    const authors = authorResult.rows as unknown as PublicationAuthor[];

    publications.push({
      id: row.id,
      doi: row.doi,
      title: row.title,
      url: row.url,
      journal: row.journal,
      year: row.year,
      volume: row.volume,
      issue: row.issue,
      pages: row.pages,
      authors,
      unknownRoleAuthors: authors.filter((a) => a.role === "unknown"),
    });
  }

  return publications;
}

// The single definition of "who does the plain-language role picker apply
// to" — genuinely unidentified names only (faculty_id null). A co-author row
// already linked to a DIFFERENT real faculty member (their own still-
// unconfirmed row) is that person's own decision, never this reviewer's —
// see lib/review-actions.ts::setCoAuthorRole, which enforces the same rule
// server-side. Shared by the review page and the campaign tool's email-count
// logic so the two can never drift apart on what "co-author we don't know" means.
export function unidentifiedCoAuthors(pub: ReviewablePublication, facultyId: number): PublicationAuthor[] {
  return pub.unknownRoleAuthors.filter((a) => a.faculty_id === null);
}

// The reviewer's own row, when it's still unconfirmed — the Zhu/Dykstra
// shape's "is this your paper?" prompt, distinct from unidentifiedCoAuthors.
export function ownUnconfirmedRow(pub: ReviewablePublication, facultyId: number): PublicationAuthor | undefined {
  return pub.unknownRoleAuthors.find((a) => a.faculty_id === facultyId);
}
