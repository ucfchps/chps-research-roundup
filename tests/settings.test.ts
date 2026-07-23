// Session 16.2: generic key-value settings table + the outbound-email kill
// switch. isEmailNotificationsEnabled must fail safe (disabled) whenever it
// can't positively confirm "enabled" — missing row, not just literal 'false'.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { getSetting, getSettingRow, isEmailNotificationsEnabled, setSetting } from "../lib/settings";

describe("settings", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "settings-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  describe("getSetting / setSetting", () => {
    it("getSetting returns null for a key that doesn't exist", async () => {
      expect(await getSetting(client, "nonexistent_key")).toBeNull();
    });

    it("setSetting persists a new key, readable via getSetting", async () => {
      await setSetting(client, "some_key", "some_value", "tester");
      expect(await getSetting(client, "some_key")).toBe("some_value");
    });

    it("setSetting updates an existing key's value and updated_by", async () => {
      await setSetting(client, "some_key", "first", "alice");
      await setSetting(client, "some_key", "second", "bob");

      expect(await getSetting(client, "some_key")).toBe("second");
      const row = (await client.execute({ sql: "SELECT updated_by FROM settings WHERE key = ?", args: ["some_key"] })).rows[0] as unknown as {
        updated_by: string;
      };
      expect(row.updated_by).toBe("bob");
    });

    it("the migration seeds email_notifications_enabled = 'false'", async () => {
      expect(await getSetting(client, "email_notifications_enabled")).toBe("false");
    });
  });

  describe("getSettingRow", () => {
    it("returns null for a key that doesn't exist", async () => {
      expect(await getSettingRow(client, "nonexistent_key")).toBeNull();
    });

    it("returns value, updatedAt, and updatedBy together", async () => {
      await setSetting(client, "some_key", "some_value", "tester");

      const row = await getSettingRow(client, "some_key");

      expect(row?.value).toBe("some_value");
      expect(row?.updatedBy).toBe("tester");
      expect(row?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("reflects the seeded migration row for email_notifications_enabled", async () => {
      const row = await getSettingRow(client, "email_notifications_enabled");

      expect(row?.value).toBe("false");
      expect(row?.updatedBy).toBe("migration");
    });
  });

  describe("isEmailNotificationsEnabled", () => {
    it("returns false right after migration (seeded disabled)", async () => {
      expect(await isEmailNotificationsEnabled(client)).toBe(false);
    });

    it("returns true once explicitly enabled", async () => {
      await setSetting(client, "email_notifications_enabled", "true", "tester");
      expect(await isEmailNotificationsEnabled(client)).toBe(true);
    });

    it("returns false again after being disabled a second time", async () => {
      await setSetting(client, "email_notifications_enabled", "true", "tester");
      await setSetting(client, "email_notifications_enabled", "false", "tester");
      expect(await isEmailNotificationsEnabled(client)).toBe(false);
    });

    it("fails safe to false when the row is missing entirely — not just when the value is 'false'", async () => {
      await client.execute({ sql: "DELETE FROM settings WHERE key = 'email_notifications_enabled'", args: [] });
      expect(await isEmailNotificationsEnabled(client)).toBe(false);
    });

    it("fails safe to false for any value other than the literal string 'true'", async () => {
      await setSetting(client, "email_notifications_enabled", "TRUE", "tester");
      expect(await isEmailNotificationsEnabled(client)).toBe(false);
    });
  });
});
