// Phase 5 hardening, Session 1: whole-database snapshot + diff. Built for
// idempotency tests (Sessions 2+) that need to prove "running this job twice
// changes nothing the second time" — "snapshots differ" is not an answer
// anyone can act on, so diffSnapshots reports exactly which row/column
// moved.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";

// Discovers tables live rather than hardcoding a list — Session 0 found
// `settings` in production with no mention in the master plan's §6 DDL;
// hardcoding here would silently reproduce that exact class of drift.
// `_migrations` is migration-runner bookkeeping, not app data, and is
// excluded.
async function discoverTables(client: Client): Promise<string[]> {
  const result = await client.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' ORDER BY name`
  );
  return (result.rows as unknown as Array<{ name: string }>).map((r) => r.name);
}

async function primaryKeyColumns(client: Client, table: string): Promise<string[]> {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return (result.rows as unknown as Array<{ name: string; pk: number }>)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

function sortedKeys<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) out[key] = row[key];
  return out as T;
}

function comparePkValues(a: Record<string, unknown>, b: Record<string, unknown>, pk: string[]): number {
  for (const col of pk) {
    const av = a[col];
    const bv = b[col];
    if (av === bv) continue;
    if (av === null || av === undefined) return -1;
    if (bv === null || bv === undefined) return 1;
    return av < bv ? -1 : av > bv ? 1 : 0;
  }
  return 0;
}

export interface TableSnapshot {
  rowCount: number;
  hash: string;
  rows: Record<string, unknown>[];
  primaryKey: string[];
}

export type Snapshot = Record<string, TableSnapshot>;

// Per table: row count + a stable content hash. Rows sorted by primary key,
// columns sorted alphabetically within each row, so two snapshots of
// identical data always hash identically regardless of SQLite's own return
// order (which is not contractually guaranteed without ORDER BY).
export async function snapshotTables(client: Client, tables?: string[]): Promise<Snapshot> {
  const tableNames = tables ?? (await discoverTables(client));
  const snapshot: Snapshot = {};

  for (const table of tableNames) {
    const pk = await primaryKeyColumns(client, table);
    const rawRows = (await client.execute(`SELECT * FROM ${table}`)).rows as unknown as Record<string, unknown>[];
    const rows = rawRows.map((r) => sortedKeys({ ...r })).sort((a, b) => comparePkValues(a, b, pk));
    const hash = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    snapshot[table] = { rowCount: rows.length, hash, rows, primaryKey: pk };
  }

  return snapshot;
}

export interface FieldDiff {
  table: string;
  primaryKey: Record<string, unknown>;
  column: string;
  before: unknown;
  after: unknown;
}

function pkString(row: Record<string, unknown>, pk: string[]): string {
  return pk.length > 0 ? JSON.stringify(pk.map((c) => row[c])) : JSON.stringify(row);
}

function extractPk(row: Record<string, unknown>, pk: string[]): Record<string, unknown> {
  if (pk.length === 0) return {};
  const out: Record<string, unknown> = {};
  for (const col of pk) out[col] = row[col];
  return out;
}

// Row-and-column-level diff between two snapshots. Names the table, the
// primary key of the affected row, the column, and both values — the
// "publication 47 first_seen_at moved" shape, not "snapshots differ".
export function diffSnapshots(before: Snapshot, after: Snapshot): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const allTables = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const table of allTables) {
    const beforeTable = before[table];
    const afterTable = after[table];
    const pk = afterTable?.primaryKey ?? beforeTable?.primaryKey ?? [];

    const beforeByKey = new Map((beforeTable?.rows ?? []).map((r) => [pkString(r, pk), r]));
    const afterByKey = new Map((afterTable?.rows ?? []).map((r) => [pkString(r, pk), r]));
    const allKeys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);

    for (const key of allKeys) {
      const beforeRow = beforeByKey.get(key);
      const afterRow = afterByKey.get(key);

      if (!beforeRow) {
        diffs.push({ table, primaryKey: extractPk(afterRow!, pk), column: "(row)", before: undefined, after: "inserted" });
        continue;
      }
      if (!afterRow) {
        diffs.push({ table, primaryKey: extractPk(beforeRow, pk), column: "(row)", before: "existed", after: "deleted" });
        continue;
      }

      const allColumns = new Set([...Object.keys(beforeRow), ...Object.keys(afterRow)]);
      for (const column of allColumns) {
        if (JSON.stringify(beforeRow[column]) !== JSON.stringify(afterRow[column])) {
          diffs.push({ table, primaryKey: extractPk(beforeRow, pk), column, before: beforeRow[column], after: afterRow[column] });
        }
      }
    }
  }

  return diffs;
}

// Throws with a full, readable diff (not vitest's generic object-diff) if
// anything outside `ignore`d tables changed between the two snapshots.
export function expectNoNetChange(before: Snapshot, after: Snapshot, opts: { ignore?: string[] } = {}): void {
  const ignore = new Set(opts.ignore ?? []);
  const diffs = diffSnapshots(before, after).filter((d) => !ignore.has(d.table));

  if (diffs.length > 0) {
    const lines = diffs.map((d) => {
      const pkLabel = Object.keys(d.primaryKey).length > 0 ? ` (${JSON.stringify(d.primaryKey)})` : "";
      return `  ${d.table}${pkLabel}.${d.column}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`;
    });
    throw new Error(`Expected no net change, but found ${diffs.length} difference(s):\n${lines.join("\n")}`);
  }
}
