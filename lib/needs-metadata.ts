// §8c Tab 2: the manual completion path for a needs_metadata stub — the
// second, independent way one of these records leaves the queue, alongside
// lib/matching.ts::promoteFromNeedsMetadata's automatic DOI-triggered path
// (untouched by this file). A human reviewing the record by hand IS the
// identity confirmation a DOI exists to provide for the automatic path, so
// this never requires one — see master plan §6/§7, Session 25 recon.
//
// Feeds through the exact same merge machinery a real ingestion merge would
// use (mergeAuthors/mergeMetadata, incomingSource: "manual") rather than a
// parallel write path — same reasoning backfill-reconcile-2025.ts already
// established for "a human-verified completion is that same shape of trust."
import type { Client } from "@libsql/client";
import { mergeAuthors, mergeMetadata, normalizeTitle, type AuthorInput, type ExistingAuthor, type MergeableExisting, type PublicationMetadata } from "./matching";
import { unitsForPublication } from "./citation";
import type { AuthorRole, Faculty, PublicationStatus, Unit } from "./types";

export interface CompleteAuthorInput {
  name: string;
  facultyId: number | null;
  role: AuthorRole;
}

// No independent `position` field — mergeAuthors assigns a genuinely-new
// author's DB position from its ARRIVAL ORDER in the incoming array
// (lib/matching.ts:180, `position: merged.length`), not from a caller-
// supplied value, and never touches position on an already-matched existing
// author either. `authors` must already be submitted in final display
// order — that ordering, not a per-row number, is the single source of
// truth. (No real needs_metadata record has existing authors to reorder
// today — Session 25 recon confirmed all 33 arrive author-less — so the
// "reorder an existing row" case this can't express doesn't currently
// occur; if a future source changes that, mergeAuthors itself would need
// an explicit-reposition capability, not a workaround here.)

export interface CompleteNeedsMetadataParams {
  completedBy: string; // free-text name, recorded into role_set_by — no per-user login, same as FinalizePanel's generatedBy
  authors: CompleteAuthorInput[];
  journal: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null; // optional — gray lit frequently has none (§5)
  acknowledgedMissingJournal: boolean;
  acknowledgedZeroLinkedAuthors: boolean;
}

export type CompleteNeedsMetadataResult =
  | { outcome: "completed"; publicationId: number; units: Unit[]; authorCount: number }
  | { outcome: "already_promoted"; publicationId: number; currentStatus: PublicationStatus };

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

export async function completeNeedsMetadataRecord(
  client: Client,
  publicationId: number,
  params: CompleteNeedsMetadataParams
): Promise<CompleteNeedsMetadataResult> {
  const pubRow = (
    await client.execute({
      sql: "SELECT id, doi, title, url, journal, year, volume, issue, pages, status, source FROM publications WHERE id = ?",
      args: [publicationId],
    })
  ).rows[0] as unknown as
    | { id: number; doi: string | null; title: string; url: string; journal: string | null; year: number | null; volume: string | null; issue: string | null; pages: string | null; status: PublicationStatus; source: MergeableExisting["source"] }
    | undefined;

  if (!pubRow) throw new Error(`No publication found with id ${publicationId}`);

  // Race guard, part 1: a fresh read, not whatever the form loaded with —
  // lib/matching.ts::promoteFromNeedsMetadata could have fired between page
  // load and this save (§9 automatic ingestion runs independently).
  if (pubRow.status !== "needs_metadata") {
    return { outcome: "already_promoted", publicationId, currentStatus: pubRow.status };
  }

  if (isBlank(params.journal) && !params.acknowledgedMissingJournal) {
    throw new Error("A journal name is required, or explicitly acknowledge it's still missing.");
  }

  const facultyRows = (await client.execute("SELECT * FROM faculty")).rows as unknown as Faculty[];
  const facultyById: Record<number, Faculty> = {};
  for (const f of facultyRows) facultyById[f.id] = f;

  const now = new Date().toISOString();
  const incomingAuthors: AuthorInput[] = params.authors.map((a, i) => ({
    name: a.name,
    faculty_id: a.facultyId,
    role: a.role,
    role_set_by: `comms:${params.completedBy}`,
    role_set_at: now,
    position: i,
  }));

  const existingAuthors = (
    await client.execute({ sql: "SELECT * FROM publication_authors WHERE publication_id = ? ORDER BY position", args: [publicationId] })
  ).rows as unknown as ExistingAuthor[];

  const mergedAuthors = mergeAuthors(existingAuthors, incomingAuthors, "manual");
  // unitsForPublication only reads role/faculty_id — publication_id/id are
  // irrelevant to the derivation, just needed to satisfy PublicationAuthor's
  // shape (MergedAuthor predates having a real row id for new authors).
  const units = unitsForPublication(
    mergedAuthors.map((a) => ({ ...a, publication_id: publicationId, id: a.id ?? -1 })),
    facultyById
  );

  if (units.length === 0 && !params.acknowledgedZeroLinkedAuthors) {
    throw new Error("No linked CHPS faculty author (derives no unit), or explicitly acknowledge that's correct.");
  }

  const incomingMetadata: PublicationMetadata = {
    doi: params.doi,
    title: pubRow.title,
    url: pubRow.url,
    journal: params.journal,
    year: pubRow.year,
    volume: params.volume,
    issue: params.issue,
    pages: params.pages,
  };
  const mergedMetadata = mergeMetadata({ ...pubRow, source: pubRow.source }, incomingMetadata, "manual");

  const tx = await client.transaction("write");
  try {
    // Race guard, part 2: the WHERE clause re-asserts status='needs_metadata'
    // at write time, same defense-in-depth finalizeRoundup uses for its own
    // eligibility boundary — closes the gap between the SELECT above and
    // this write, not just the gap between page-load and submit.
    const updateResult = await tx.execute({
      sql: `UPDATE publications
            SET doi = ?, title = ?, title_normalized = ?, url = ?, journal = ?, year = ?, volume = ?, issue = ?, pages = ?,
                status = 'pending_merge', first_seen_at = ?
            WHERE id = ? AND status = 'needs_metadata'`,
      args: [
        mergedMetadata.doi,
        mergedMetadata.title,
        normalizeTitle(mergedMetadata.title),
        mergedMetadata.url,
        mergedMetadata.journal,
        mergedMetadata.year,
        mergedMetadata.volume,
        mergedMetadata.issue,
        mergedMetadata.pages,
        now,
        publicationId,
      ],
    });

    if (updateResult.rowsAffected === 0) {
      await tx.rollback();
      const raced = (await client.execute({ sql: "SELECT status FROM publications WHERE id = ?", args: [publicationId] })).rows[0] as unknown as {
        status: PublicationStatus;
      };
      return { outcome: "already_promoted", publicationId, currentStatus: raced.status };
    }

    for (const a of mergedAuthors) {
      if (a.id === null) {
        await tx.execute({
          sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [publicationId, a.faculty_id, a.name, a.role, a.role_set_by, a.role_set_at, a.position],
        });
      } else {
        await tx.execute({
          sql: `UPDATE publication_authors SET faculty_id = ?, role = ?, role_set_by = ?, role_set_at = ? WHERE id = ?`,
          args: [a.faculty_id, a.role, a.role_set_by, a.role_set_at, a.id],
        });
      }
    }

    await tx.commit();
    return { outcome: "completed", publicationId, units, authorCount: mergedAuthors.length };
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    await tx.close();
  }
}
