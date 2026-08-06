// Phase 5 hardening, Session 1: the shared re-run invariant, built once so
// Sessions 2 and 3's idempotency tests (ingest-scholar, ingest-crossref,
// ingest-pubmed-orcid, sync-roster, release-buffer, refresh-metadata) all
// assert the same things the same way. See master plan §9 (idempotency
// requirement), §5a rule 4, §6b (no-double-post), §15.4.
import type { Snapshot } from "./snapshot";

export interface AssertReRunInvariantsOptions {
  // "The second run makes zero AI calls" is not a fact observable from a DB
  // snapshot — the caller supplies it, typically a call-count on a spied
  // lib/ai.ts::callAI for the second run specifically (not by letting one
  // escape and timing out — lib/ai.ts has its own retry loop that treats a
  // thrown fetch as retryable). Optional: sync-roster and release-buffer
  // never call AI at all, so this check doesn't apply to either.
  aiCallCount?: number;
}

// ★ Tables excluded from strict row-count equality, and why each one is —
// an unexplained exclusion is how this invariant quietly stops asserting
// anything. Every other table snapshotTables() discovers live gets a hard
// row-count check below, no silent opt-out.
const ROW_COUNT_EXCLUDED_TABLES = new Set([
  "usage_log", // AI's call log — grows on any real AI call. Zero-AI-calls on a re-run is asserted separately via aiCallCount (a call-count spy), not by this table's row count, since a call that fails before logging would make row-count blind to it anyway.
  "settings", // legitimately mutates per-KEY (job bookkeeping, login lockout state) — checked per key below, never by a blanket row-count/table check.
]);

// settings keys allowed to change value on a re-run, and why. Any other key
// changing is a real finding — no ingestion job has legitimate business
// touching a feature toggle (email_notifications_enabled) or a different
// job's bookkeeping.
const SETTINGS_KEYS_ALLOWED_TO_CHANGE = new Set([
  "admin_login_attempts", // login lockout bookkeeping (lib/admin-auth.ts) — unrelated to any ingestion job, but shares this table.
  // Add a scheduled job's own "last run at" state key here, by exact name,
  // if one is ever built — never a wildcard or a prefix match.
]);

function pairedRowsById(before: Snapshot, after: Snapshot, table: string): Array<[Record<string, unknown>, Record<string, unknown>]> {
  const beforeRows = before[table]?.rows ?? [];
  const afterRows = after[table]?.rows ?? [];
  const afterById = new Map(afterRows.map((r) => [r.id, r]));
  const pairs: Array<[Record<string, unknown>, Record<string, unknown>]> = [];
  for (const b of beforeRows) {
    const a = afterById.get(b.id);
    if (a) pairs.push([b, a]);
  }
  return pairs;
}

// Asserts every re-run invariant this hardening pack has named against two
// full-database snapshots (tests/helpers/snapshot.ts::snapshotTables,
// called with no `tables` arg so every real table is covered — including
// one the master plan's own §6 doesn't document, per Session 0). Throws
// with every violation named, not just the first — a re-run that broke two
// things should say so.
export function assertReRunInvariants(before: Snapshot, after: Snapshot, opts: AssertReRunInvariantsOptions = {}): void {
  const failures: string[] = [];

  // 1. Row counts unchanged, table by table, except the two documented
  //    exclusions above.
  const allTables = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const table of allTables) {
    if (ROW_COUNT_EXCLUDED_TABLES.has(table)) continue;
    const beforeCount = before[table]?.rowCount ?? 0;
    const afterCount = after[table]?.rowCount ?? 0;
    if (beforeCount !== afterCount) {
      failures.push(`${table}: row count changed from ${beforeCount} to ${afterCount}`);
    }
  }

  // settings: per-key, not per-table (see SETTINGS_KEYS_ALLOWED_TO_CHANGE).
  if (before.settings || after.settings) {
    const beforeByKey = new Map((before.settings?.rows ?? []).map((r) => [String(r.key), r]));
    const afterByKey = new Map((after.settings?.rows ?? []).map((r) => [String(r.key), r]));
    const allKeys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
    for (const key of allKeys) {
      if (SETTINGS_KEYS_ALLOWED_TO_CHANGE.has(key)) continue;
      const b = beforeByKey.get(key);
      const a = afterByKey.get(key);
      if (!b || !a || b.value !== a.value) {
        failures.push(`settings["${key}"]: ${b ? JSON.stringify(b.value) : "(absent)"} -> ${a ? JSON.stringify(a.value) : "(absent)"} (not in the allowed-to-change list)`);
      }
    }
  }

  for (const [b, a] of pairedRowsById(before, after, "publications")) {
    // 2. first_seen_at unchanged on every existing publication. No
    //    exception logic here on purpose: the one sanctioned reset (manual
    //    promotion out of needs_metadata, §6 addendum) is a human-driven
    //    admin action, not any ingestion job's re-run — a job this helper
    //    is asserting against should never legitimately trip this.
    if (b.first_seen_at !== a.first_seen_at) {
      failures.push(`publications[${b.id}].first_seen_at: ${JSON.stringify(b.first_seen_at)} -> ${JSON.stringify(a.first_seen_at)}`);
    }

    // 3. roundup_id unchanged — one check catches both directions: nothing
    //    un-stamped (non-null -> null) and no ingestion job stamping one
    //    (null -> non-null; only lib/roundup-finalize.ts::finalizeRoundup
    //    may ever do that, §6b).
    if (b.roundup_id !== a.roundup_id) {
      failures.push(`publications[${b.id}].roundup_id: ${JSON.stringify(b.roundup_id)} -> ${JSON.stringify(a.roundup_id)}`);
    }

    // 4. status never regresses out of 'published'.
    if (b.status === "published" && a.status !== "published") {
      failures.push(`publications[${b.id}].status regressed: ${JSON.stringify(b.status)} -> ${JSON.stringify(a.status)}`);
    }

    // 5. released_at unchanged once set.
    if (b.released_at !== null && b.released_at !== a.released_at) {
      failures.push(`publications[${b.id}].released_at: ${JSON.stringify(b.released_at)} -> ${JSON.stringify(a.released_at)} (already set, must not change)`);
    }
  }

  // 6. role / role_set_by unchanged for every human-set author row (§15.4)
  //    — asserted from both directions: the values themselves are
  //    identical, AND role_set_at is identical too, so a rewrite that
  //    happens to land on a coincidentally-equal role/role_set_by string
  //    still gets caught as the real regression it is.
  for (const [b, a] of pairedRowsById(before, after, "publication_authors")) {
    const roleSetBy = typeof b.role_set_by === "string" ? b.role_set_by : "";
    const isHumanSet = roleSetBy.startsWith("faculty:") || roleSetBy.startsWith("comms:");
    if (!isHumanSet) continue;
    if (b.role !== a.role || b.role_set_by !== a.role_set_by || b.role_set_at !== a.role_set_at) {
      failures.push(
        `publication_authors[${b.id}] (human-set, role_set_by=${JSON.stringify(b.role_set_by)}): ` +
          `role ${JSON.stringify(b.role)}->${JSON.stringify(a.role)}, ` +
          `role_set_by ${JSON.stringify(b.role_set_by)}->${JSON.stringify(a.role_set_by)}, ` +
          `role_set_at ${JSON.stringify(b.role_set_at)}->${JSON.stringify(a.role_set_at)}`
      );
    }
  }

  // 7. Zero AI calls on a converged re-run — opt-in, see
  //    AssertReRunInvariantsOptions.
  if (opts.aiCallCount !== undefined && opts.aiCallCount !== 0) {
    failures.push(
      `AI calls on this run: expected 0, got ${opts.aiCallCount} — a converged re-run should match on DOI or normalized title every time; reaching the fuzzy matcher on a second run means matching isn't converging`
    );
  }

  if (failures.length > 0) {
    throw new Error(`Re-run invariant violation(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  }
}
