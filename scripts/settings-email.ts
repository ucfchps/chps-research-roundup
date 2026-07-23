// Session 16.2: CLI-first control for the outbound-email kill switch, same
// posture as sync-roster/coverage-report/campaign-status before their
// eventual /admin screen (build-order item 15) exists.
//
// Run with:
//   npm run settings:email -- --status
//   npm run settings:email -- --enable --by "<your name>"
//   npm run settings:email -- --disable --by "<your name>"
import { config } from "dotenv";
import path from "node:path";
import { createClient } from "@libsql/client";
import { getSettingRow, isEmailNotificationsEnabled, setSetting } from "../lib/settings";

config({ path: path.join(__dirname, "..", ".env.local") });

export type SettingsEmailMode = "status" | "enable" | "disable";

export function parseArgs(argv: string[]): { mode: SettingsEmailMode | null; by: string } {
  let mode: SettingsEmailMode | null = null;
  if (argv.includes("--status")) mode = "status";
  else if (argv.includes("--enable")) mode = "enable";
  else if (argv.includes("--disable")) mode = "disable";

  const byFlag = argv.find((a) => a === "--by" || a.startsWith("--by="));
  // No logged-in admin session exists yet to pull a real name from — best
  // available identifiable default.
  let by = `cli:${process.env.USER ?? "unknown"}`;
  if (byFlag) {
    by = byFlag.includes("=") ? byFlag.split("=")[1] : (argv[argv.indexOf(byFlag) + 1] ?? by);
  }

  return { mode, by };
}

async function main() {
  const { mode, by } = parseArgs(process.argv.slice(2));
  if (!mode) throw new Error('Usage: npm run settings:email -- --status|--enable|--disable [--by "<name>"]');

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");
  const client = createClient({ url, authToken });

  if (mode === "status") {
    const enabled = await isEmailNotificationsEnabled(client);
    const row = await getSettingRow(client, "email_notifications_enabled");
    console.log(`Email notifications: ${enabled ? "ENABLED" : "DISABLED"}`);
    console.log(row ? `Last changed: ${row.updatedAt} by ${row.updatedBy ?? "unknown"}` : "(no settings row found — treated as disabled)");
    return;
  }

  const newValue = mode === "enable" ? "true" : "false";
  await setSetting(client, "email_notifications_enabled", newValue, by);
  console.log(`Email notifications ${mode === "enable" ? "ENABLED" : "DISABLED"} by ${by}.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
