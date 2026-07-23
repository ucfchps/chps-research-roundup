// §8c admin auth: brute-force lockout, backed by the settings table (16.2)
// rather than an in-memory counter — Vercel serverless cold starts would
// make an in-memory counter reset constantly, which is worse than useless
// for this purpose. Known limitation either way: this is a single shared
// counter, not per-IP — a handful of wrong guesses from anyone locks
// everyone out for the window. Acceptable for a single-shared-secret admin
// login with no public signup surface.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { isLoginLocked, MAX_LOGIN_ATTEMPTS, recordFailedLoginAttempt, recordSuccessfulLogin } from "../lib/admin-auth";

describe("admin-auth lockout", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "admin-auth-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("is unlocked with no prior attempts", async () => {
    expect((await isLoginLocked(client)).locked).toBe(false);
  });

  it("stays unlocked for fewer than the threshold of failed attempts", async () => {
    for (let i = 0; i < MAX_LOGIN_ATTEMPTS - 1; i++) {
      await recordFailedLoginAttempt(client);
    }
    expect((await isLoginLocked(client)).locked).toBe(false);
  });

  it("locks once the threshold of failed attempts is reached, with a future lockedUntil", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < MAX_LOGIN_ATTEMPTS; i++) {
      await recordFailedLoginAttempt(client, now);
    }

    const status = await isLoginLocked(client, now);
    expect(status.locked).toBe(true);
    expect(status.lockedUntil).not.toBeNull();
    expect(new Date(status.lockedUntil!).getTime()).toBeGreaterThan(now.getTime());
  });

  it("unlocks again once the lockout window has passed", async () => {
    const lockedAt = new Date("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < MAX_LOGIN_ATTEMPTS; i++) {
      await recordFailedLoginAttempt(client, lockedAt);
    }
    const wayLater = new Date(lockedAt.getTime() + 24 * 3600000);

    expect((await isLoginLocked(client, wayLater)).locked).toBe(false);
  });

  it("recordSuccessfulLogin resets the counter — a subsequent failed attempt doesn't immediately re-lock", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < MAX_LOGIN_ATTEMPTS - 1; i++) {
      await recordFailedLoginAttempt(client, now);
    }
    await recordSuccessfulLogin(client);

    await recordFailedLoginAttempt(client, now);
    expect((await isLoginLocked(client, now)).locked).toBe(false);
  });

  it("a failed attempt after a prior lockout window has already passed starts counting fresh, not immediately re-locking", async () => {
    const lockedAt = new Date("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < MAX_LOGIN_ATTEMPTS; i++) {
      await recordFailedLoginAttempt(client, lockedAt);
    }
    const wayLater = new Date(lockedAt.getTime() + 24 * 3600000);

    await recordFailedLoginAttempt(client, wayLater);

    expect((await isLoginLocked(client, wayLater)).locked).toBe(false);
  });
});
