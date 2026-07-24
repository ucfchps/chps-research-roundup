// Session 19 (§6b, §8c Tab 4): the one write in this system that's supposed
// to be permanent. Eligibility is re-derived here via queryPublications —
// the exact same query the browsing page uses (status='published' AND
// roundup_id IS NULL AND date_added <= cutoff, no start date) — never a
// second, parallel implementation. A client-supplied publicationIds list is
// only ever a proposed subset: it's intersected against a fresh eligibility
// query, so a stale page or tampered id list can never stamp something that
// isn't genuinely eligible right now.
import type { Client } from "@libsql/client";
import { queryPublications } from "./publications";
import { buildExportHtml } from "./roundup-export";

export interface FinalizeParams {
  label: string;
  generatedBy: string;
  cutoffDate: string;
  title: string;
  intro: string;
  legendLine: string;
  publicationIds: number[];
}

export interface FinalizeResult {
  roundupId: number;
  pubCount: number;
}

export async function finalizeRoundup(client: Client, params: FinalizeParams): Promise<FinalizeResult> {
  const eligible = await queryPublications(client, {
    status: ["published"],
    excludeAlreadyPosted: true,
    dateAddedTo: params.cutoffDate,
  });

  const requestedIds = new Set(params.publicationIds);
  const toInclude = eligible.filter((r) => requestedIds.has(r.publication.id));

  if (toInclude.length === 0) {
    throw new Error("No eligible publications in the selected set — nothing to finalize.");
  }

  const html = buildExportHtml({ title: params.title, intro: params.intro, legend: params.legendLine, publications: toInclude });
  const now = new Date().toISOString();
  const ids = toInclude.map((r) => r.publication.id);

  const tx = await client.transaction("write");
  try {
    const insertResult = await tx.execute({
      sql: `INSERT INTO roundups (label, generated_at, generated_by, pub_count, html) VALUES (?, ?, ?, ?, ?)`,
      args: [params.label, now, params.generatedBy, ids.length, html],
    });
    const roundupId = Number(insertResult.lastInsertRowid);

    // Re-assert the exact eligibility boundary at write time — defense in
    // depth against any run that overlapped this one.
    await tx.execute({
      sql: `UPDATE publications SET roundup_id = ? WHERE id IN (${ids.map(() => "?").join(",")}) AND roundup_id IS NULL AND status = 'published'`,
      args: [roundupId, ...ids],
    });

    await tx.commit();
    return { roundupId, pubCount: ids.length };
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    await tx.close();
  }
}

export interface UnstampSummary {
  roundupId: number;
  label: string;
  publicationIds: number[];
  dryRun: boolean;
}

// The CLI-only safety net (scripts/unstamp-roundup.ts) until Tab 5's proper
// archive/un-stamp screen exists. Fully reverses a finalize: clears
// roundup_id on every publication tied to this roundup, then deletes the
// roundups row itself (not just marked reversed) — a clean full reversal
// mirrors what a re-run of finalize would produce, with no orphaned row left
// for a future finalize to collide with.
export async function unstampRoundup(client: Client, roundupId: number, opts: { dryRun: boolean }): Promise<UnstampSummary> {
  const roundupRow = (await client.execute({ sql: "SELECT label FROM roundups WHERE id = ?", args: [roundupId] })).rows[0] as unknown as
    | { label: string }
    | undefined;
  if (!roundupRow) throw new Error(`No roundup found with id ${roundupId}`);

  const pubRows = (await client.execute({ sql: "SELECT id FROM publications WHERE roundup_id = ?", args: [roundupId] })).rows as unknown as Array<{
    id: number;
  }>;
  const publicationIds = pubRows.map((r) => r.id);

  if (!opts.dryRun) {
    await client.execute({ sql: "UPDATE publications SET roundup_id = NULL WHERE roundup_id = ?", args: [roundupId] });
    await client.execute({ sql: "DELETE FROM roundups WHERE id = ?", args: [roundupId] });
  }

  return { roundupId, label: roundupRow.label, publicationIds, dryRun: opts.dryRun };
}
