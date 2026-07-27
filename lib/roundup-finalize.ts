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
import type { Roundup } from "./types";

export interface FinalizeParams {
  label: string;
  generatedBy: string;
  cutoffDate: string;
  title: string;
  intro: string;
  legendLine: string;
  publicationIds: number[];
  // Session 22 (Bug 2): a publication with zero linked CHPS faculty authors
  // derives no unit (§6a) and never appears in the generated HTML — stamping
  // it anyway silently marks it "already posted" forever with nothing to
  // show for it. Any such publication in publicationIds MUST also appear
  // here, or finalize rejects the whole request (§15.11 — never default a
  // gap to something that looks like a decision). This is the boundary that
  // actually writes roundup_id, so it's enforced here regardless of what the
  // UI does or doesn't check by default.
  acknowledgedZeroUnitIds?: number[];
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

  const acknowledged = new Set(params.acknowledgedZeroUnitIds ?? []);
  const unacknowledgedZeroUnit = toInclude.filter((r) => r.units.length === 0 && !acknowledged.has(r.publication.id));
  if (unacknowledgedZeroUnit.length > 0) {
    const list = unacknowledgedZeroUnit.map((r) => `#${r.publication.id} "${r.publication.title}"`).join(", ");
    throw new Error(
      `${unacknowledgedZeroUnit.length} publication(s) have no linked CHPS faculty author and would be marked posted without appearing in any ` +
        `unit section: ${list}. Include their ids in acknowledgedZeroUnitIds to finalize them anyway.`
    );
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
  label: string | null;
  publicationIds: number[];
  dryRun: boolean;
  // True when there was nothing to reverse — a nonexistent id, or an id
  // already reversed by an earlier call (the roundups row is gone either
  // way, so the two cases are indistinguishable and handled identically).
  // Both the CLI and Tab 5's un-stamp UI must be safe to call twice; this is
  // the one shared idempotency boundary, not a per-caller check.
  noop: boolean;
}

// The one implementation behind two entry points: the CLI safety net
// (scripts/unstamp-roundup.ts) and Tab 5's archive/un-stamp screen
// (app/admin/archive). Fully reverses a finalize: clears roundup_id on
// every publication tied to this roundup, then deletes the roundups row
// itself (not just marked reversed) — a clean full reversal mirrors what a
// re-run of finalize would produce, with no orphaned row left for a future
// finalize to collide with.
export async function unstampRoundup(client: Client, roundupId: number, opts: { dryRun: boolean }): Promise<UnstampSummary> {
  const roundupRow = (await client.execute({ sql: "SELECT label FROM roundups WHERE id = ?", args: [roundupId] })).rows[0] as unknown as
    | { label: string }
    | undefined;
  if (!roundupRow) {
    return { roundupId, label: null, publicationIds: [], dryRun: opts.dryRun, noop: true };
  }

  const pubRows = (await client.execute({ sql: "SELECT id FROM publications WHERE roundup_id = ?", args: [roundupId] })).rows as unknown as Array<{
    id: number;
  }>;
  const publicationIds = pubRows.map((r) => r.id);

  if (!opts.dryRun) {
    await client.execute({ sql: "UPDATE publications SET roundup_id = NULL WHERE roundup_id = ?", args: [roundupId] });
    await client.execute({ sql: "DELETE FROM roundups WHERE id = ?", args: [roundupId] });
  }

  return { roundupId, label: roundupRow.label, publicationIds, dryRun: opts.dryRun, noop: false };
}

export interface RoundupListEntry extends Roundup {
  // A fresh COUNT alongside the historical pub_count (§6b) — a publication
  // tied to an edition can still be edited after the fact, so the two can
  // legitimately drift. Tab 5 shows both; drift is informational, not an
  // error (§15.11 — never let a real state go unsurfaced, never treat it as
  // a fault either).
  live_stamped_count: number;
}

// Tab 5 (§8c) — the read side of the archive. One query, newest edition
// first. Nothing here writes; the archive's only write is the explicit,
// confirmed unstampRoundup call above.
export async function listRoundups(client: Client): Promise<RoundupListEntry[]> {
  const rows = (
    await client.execute(
      `SELECT r.id, r.label, r.generated_at, r.generated_by, r.pub_count, r.html, COUNT(p.id) AS live_stamped_count
       FROM roundups r
       LEFT JOIN publications p ON p.roundup_id = r.id
       GROUP BY r.id
       ORDER BY r.generated_at DESC`
    )
  ).rows as unknown as RoundupListEntry[];
  // Spread into genuinely plain objects — this crosses a Server -> Client
  // Component boundary (app/admin/archive/ArchivePanel.tsx), which requires
  // plain objects; the libSQL driver's row implementation isn't guaranteed
  // to satisfy that on every transport. Same fix as lib/publications.ts.
  return rows.map((r) => ({ ...r }));
}
