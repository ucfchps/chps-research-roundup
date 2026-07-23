// Session 16.2: generic key-value settings, meant to grow into a proper
// settings tab once /admin (build-order item 15) exists. Currently has one
// consumer — the outbound-email kill switch.
import type { Client } from "@libsql/client";

export async function getSetting(client: Client, key: string): Promise<string | null> {
  const result = await client.execute({ sql: "SELECT value FROM settings WHERE key = ?", args: [key] });
  const row = result.rows[0] as unknown as { value: string } | undefined;
  return row ? row.value : null;
}

export interface SettingRow {
  value: string;
  updatedAt: string;
  updatedBy: string | null;
}

// For display purposes (e.g. `settings:email --status`) — getSetting alone
// doesn't surface who/when, and that provenance is the whole point of a
// status check.
export async function getSettingRow(client: Client, key: string): Promise<SettingRow | null> {
  const result = await client.execute({
    sql: "SELECT value, updated_at as updatedAt, updated_by as updatedBy FROM settings WHERE key = ?",
    args: [key],
  });
  return (result.rows[0] as unknown as SettingRow | undefined) ?? null;
}

export async function setSetting(client: Client, key: string, value: string, updatedBy: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    args: [key, value, new Date().toISOString(), updatedBy],
  });
}

// Fail-safe by construction: anything other than the literal string 'true'
// (missing row, 'false', a typo'd 'TRUE', whatever) reads as disabled. Same
// posture as 'unknown' vs 'external' elsewhere in this codebase — when
// uncertain, assume the safer state, not the more convenient one.
export async function isEmailNotificationsEnabled(client: Client): Promise<boolean> {
  return (await getSetting(client, "email_notifications_enabled")) === "true";
}
