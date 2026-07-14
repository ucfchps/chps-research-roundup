// Keeps Crossref-derived citation metadata from going stale or shipping
// permanently incomplete. See master plan §6b, §7, §8c Tab 4, §9, §15.1/§15.11.
// Calls into lib/crossref.ts's resolveByDoi (Session 6) — never touches its
// acceptance gate. Never modifies the author list — that's the merge
// engine's job (Session 5), not this one's.
import type { Client } from "@libsql/client";
import { CrossrefUnavailableError, resolveByDoi } from "./crossref";
import type { CrossrefResolution, Publication } from "./types";

export interface RefreshedItem {
  id: number;
  title: string;
}

export interface ErroredItem extends RefreshedItem {
  error: string;
}

export interface RefreshResult {
  checkedIncomplete: number;
  updatedIncomplete: number;
  stillIncomplete: RefreshedItem[];
  checkedPopulated: number;
  flaggedMismatches: RefreshedItem[];
  errored: ErroredItem[];
}

// Problem A (ahead-of-print): missing volume or pages.
async function selectIncomplete(client: Client): Promise<Publication[]> {
  const result = await client.execute(
    `SELECT * FROM publications
     WHERE doi IS NOT NULL AND roundup_id IS NULL AND (volume IS NULL OR pages IS NULL)`
  );
  return result.rows as unknown as Publication[];
}

// Problem B (stale-but-present volume/issue/pages): already fully populated.
async function selectPopulated(client: Client): Promise<Publication[]> {
  const result = await client.execute(
    `SELECT * FROM publications
     WHERE doi IS NOT NULL AND roundup_id IS NULL AND volume IS NOT NULL AND pages IS NOT NULL`
  );
  return result.rows as unknown as Publication[];
}

// ★ Deliberately NOT `mergeMetadata` (lib/matching.ts, §7). That engine's
// contract is "equal-or-higher source priority may overwrite a non-empty
// field" — correct for merging records discovered via different layers, but
// wrong here: re-resolving a crossref-sourced record via resolveByDoi is
// itself priority "crossref", so mergeMetadata would treat it as an
// equal-priority incoming source and happily overwrite an already-populated
// value with a fresher one. This job's contract is stricter and absolute —
// "already has a value" wins, full stop, regardless of source — which is
// also what makes a human-edited field (§8b) safe: there's no field-level
// provenance column to check (unlike publication_authors.role_set_by), but
// it doesn't matter, because nothing here ever overwrites a non-null value.
function fillMissingPagination(
  pub: Publication,
  resolved: CrossrefResolution
): { volume: string | null; issue: string | null; pages: string | null; changed: boolean; stillIncomplete: boolean } {
  const volume = pub.volume ?? resolved.volume;
  const issue = pub.issue ?? resolved.issue;
  const pages = pub.pages ?? resolved.pages;
  const changed = volume !== pub.volume || issue !== pub.issue || pages !== pub.pages;
  return { volume, issue, pages, changed, stillIncomplete: volume === null || pages === null };
}

async function applyPaginationFill(
  client: Client,
  pub: Publication,
  fill: { volume: string | null; issue: string | null; pages: string | null }
) {
  await client.execute({
    sql: "UPDATE publications SET volume = ?, issue = ?, pages = ? WHERE id = ?",
    args: [fill.volume, fill.issue, fill.pages, pub.id],
  });
}

// Compares stored volume/issue/pages against Crossref's current record. Only
// ever logs a disagreement — the publications row itself is untouched.
// Upserts on publication_id so re-running doesn't pile up duplicate rows (§9).
async function recordMismatchIfAny(client: Client, pub: Publication, resolved: CrossrefResolution): Promise<boolean> {
  const volumeDiffers = resolved.volume !== null && resolved.volume !== pub.volume;
  const issueDiffers = resolved.issue !== null && resolved.issue !== pub.issue;
  const pagesDiffers = resolved.pages !== null && resolved.pages !== pub.pages;
  if (!volumeDiffers && !issueDiffers && !pagesDiffers) return false;

  await client.execute({
    sql: `INSERT INTO metadata_mismatches
            (publication_id, stored_volume, crossref_volume, stored_issue, crossref_issue, stored_pages, crossref_pages, detected_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(publication_id) DO UPDATE SET
            stored_volume = excluded.stored_volume,
            crossref_volume = excluded.crossref_volume,
            stored_issue = excluded.stored_issue,
            crossref_issue = excluded.crossref_issue,
            stored_pages = excluded.stored_pages,
            crossref_pages = excluded.crossref_pages,
            detected_at = excluded.detected_at`,
    args: [pub.id, pub.volume, resolved.volume, pub.issue, resolved.issue, pub.pages, resolved.pages, new Date().toISOString()],
  });
  return true;
}

async function resolveOrRecordError(pub: Publication, errored: ErroredItem[]): Promise<CrossrefResolution | null | undefined> {
  try {
    return await resolveByDoi(pub.doi as string);
  } catch (err) {
    if (!(err instanceof CrossrefUnavailableError)) throw err;
    errored.push({ id: pub.id, title: pub.title, error: err.message });
    return undefined;
  }
}

export async function refreshMetadata(client: Client): Promise<RefreshResult> {
  const result: RefreshResult = {
    checkedIncomplete: 0,
    updatedIncomplete: 0,
    stillIncomplete: [],
    checkedPopulated: 0,
    flaggedMismatches: [],
    errored: [],
  };

  const incomplete = await selectIncomplete(client);
  result.checkedIncomplete = incomplete.length;
  for (const pub of incomplete) {
    const resolved = await resolveOrRecordError(pub, result.errored);
    if (resolved === undefined) continue; // Crossref unavailable — already recorded
    if (resolved === null) {
      result.stillIncomplete.push({ id: pub.id, title: pub.title });
      continue;
    }

    const fill = fillMissingPagination(pub, resolved);
    if (fill.changed) {
      await applyPaginationFill(client, pub, fill);
      result.updatedIncomplete++;
    }
    if (fill.stillIncomplete) result.stillIncomplete.push({ id: pub.id, title: pub.title });
  }

  const populated = await selectPopulated(client);
  result.checkedPopulated = populated.length;
  for (const pub of populated) {
    const resolved = await resolveOrRecordError(pub, result.errored);
    if (!resolved) continue; // unavailable (already recorded) or genuinely not found — nothing to compare

    const flagged = await recordMismatchIfAny(client, pub, resolved);
    if (flagged) result.flaggedMismatches.push({ id: pub.id, title: pub.title });
  }

  return result;
}
