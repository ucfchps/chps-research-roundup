// Phase 5 hardening, Session 1: self-tests for the test infrastructure
// itself. This session builds no idempotency/security tests (Sessions 2-6)
// — these tests exist only to prove the harness the rest of the pack will
// stand on actually works: the production guard, migrations-as-schema,
// snapshot/diff, the network guard (including its two known bypasses), and
// fake timers.
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";
import { assertSafeTestUrl, createTestDb, type TestDb } from "./helpers/test-db";
import { snapshotTables, diffSnapshots, expectNoNetChange } from "./helpers/snapshot";
import { seedFaculty } from "./helpers/fixtures";
import { withFakeTimers } from "./helpers/fake-timers";
import { resolveMockSendMessageFn } from "../lib/campaigns";
import { isEmailNotificationsEnabled } from "../lib/settings";

describe("assertSafeTestUrl — the production guard", () => {
  const originalHardening = process.env.HARDENING_TEST_DB_URL;
  const originalTurso = process.env.TURSO_DATABASE_URL;

  afterEach(() => {
    if (originalHardening === undefined) delete process.env.HARDENING_TEST_DB_URL;
    else process.env.HARDENING_TEST_DB_URL = originalHardening;
    if (originalTurso === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = originalTurso;
  });

  it("allows a tmpdir file: URL", () => {
    const p = path.join(tmpdir(), "some-test.db");
    expect(() => assertSafeTestUrl(`file:${p}`)).not.toThrow();
  });

  it("refuses a file: URL outside tmpdir", () => {
    expect(() => assertSafeTestUrl("file:/etc/passwd")).toThrow(/outside os\.tmpdir/);
  });

  it("★ refuses a non-file URL when HARDENING_TEST_DB_URL is unset — must throw, not fall through", () => {
    delete process.env.HARDENING_TEST_DB_URL;
    expect(() => assertSafeTestUrl("libsql://something-ucfchps.aws-us-east-1.turso.io")).toThrow(/HARDENING_TEST_DB_URL is unset/);
  });

  it("★ refuses when HARDENING_TEST_DB_URL is set equal to TURSO_DATABASE_URL — must not allowlist production", () => {
    process.env.TURSO_DATABASE_URL = "libsql://chps-research-roundup-ucfchps.aws-us-east-1.turso.io";
    process.env.HARDENING_TEST_DB_URL = process.env.TURSO_DATABASE_URL;
    expect(() => assertSafeTestUrl(process.env.HARDENING_TEST_DB_URL!)).toThrow(/identical to TURSO_DATABASE_URL/);
  });

  it("refuses a URL that doesn't match a correctly-set HARDENING_TEST_DB_URL", () => {
    process.env.TURSO_DATABASE_URL = "libsql://chps-research-roundup-ucfchps.aws-us-east-1.turso.io";
    process.env.HARDENING_TEST_DB_URL = "libsql://chps-roundup-scratch-ucfchps.aws-us-east-1.turso.io";
    expect(() => assertSafeTestUrl("libsql://some-other-db-ucfchps.aws-us-east-1.turso.io")).toThrow(/unrecognized URL/);
  });

  it("allows an exact match for a correctly-set, non-production HARDENING_TEST_DB_URL", () => {
    process.env.TURSO_DATABASE_URL = "libsql://chps-research-roundup-ucfchps.aws-us-east-1.turso.io";
    process.env.HARDENING_TEST_DB_URL = "libsql://chps-roundup-scratch-ucfchps.aws-us-east-1.turso.io";
    expect(() => assertSafeTestUrl(process.env.HARDENING_TEST_DB_URL!)).not.toThrow();
  });
});

describe("createTestDb", () => {
  let db: TestDb | undefined;
  afterEach(async () => {
    await db?.teardown();
    db = undefined;
  });

  it("applies every migration cleanly to a fresh DB", async () => {
    db = await createTestDb();
    const tables = ((await db.client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).rows as unknown as Array<{ name: string }>).map(
      (r) => r.name
    );
    expect(tables).toContain("faculty");
    expect(tables).toContain("publications");
    // Session 0's finding: real, shipped, and genuinely absent from §6's DDL
    // block — still has to be in the migrations, and it is.
    expect(tables).toContain("settings");
  });

  it("enables foreign_keys, matching lib/db.ts", async () => {
    db = await createTestDb();
    const result = await db.client.execute("PRAGMA foreign_keys");
    expect(Number((result.rows[0] as unknown as { foreign_keys: number }).foreign_keys)).toBe(1);
  });
});

describe("snapshotTables / diffSnapshots / expectNoNetChange", () => {
  let db: TestDb | undefined;
  afterEach(async () => {
    await db?.teardown();
    db = undefined;
  });

  it("is stable across re-reads with no mutation in between", async () => {
    db = await createTestDb();
    await seedFaculty(db.client);
    const snap1 = await snapshotTables(db.client);
    const snap2 = await snapshotTables(db.client);
    expect(snap2).toEqual(snap1);
    expect(snap2.faculty.hash).toBe(snap1.faculty.hash);
  });

  it("detects a single-column change and names exactly the table/row/column/values", async () => {
    db = await createTestDb();
    const facultyId = await seedFaculty(db.client, { display_name: "Original, O." });
    const before = await snapshotTables(db.client);

    await db.client.execute({ sql: "UPDATE faculty SET display_name = ? WHERE id = ?", args: ["Changed, C.", facultyId] });
    const after = await snapshotTables(db.client);

    const diffs = diffSnapshots(before, after);
    expect(diffs).toEqual([{ table: "faculty", primaryKey: { id: facultyId }, column: "display_name", before: "Original, O.", after: "Changed, C." }]);
  });

  it("expectNoNetChange throws a readable, specific message when something changed", async () => {
    db = await createTestDb();
    const facultyId = await seedFaculty(db.client);
    const before = await snapshotTables(db.client);

    await db.client.execute({ sql: "UPDATE faculty SET active = 0 WHERE id = ?", args: [facultyId] });
    const after = await snapshotTables(db.client);

    expect(() => expectNoNetChange(before, after)).toThrow(/faculty.*active.*1.*0/);
  });

  it("expectNoNetChange passes when only an explicitly-ignored table changed", async () => {
    db = await createTestDb();
    const before = await snapshotTables(db.client);

    await db.client.execute(
      `INSERT INTO usage_log (app_name, provider, model, task_type, success, created_at) VALUES ('x','x','x','x',1,datetime('now'))`
    );
    const after = await snapshotTables(db.client);

    expect(() => expectNoNetChange(before, after, { ignore: ["usage_log"] })).not.toThrow();
    expect(() => expectNoNetChange(before, after)).toThrow(); // not ignored: still a real diff
  });
});

describe("network guard (tests/setup.ts installs this globally)", () => {
  it("throws, naming the URL, for a genuinely unmocked fetch", async () => {
    await expect(fetch("https://example.com/definitely-not-mocked")).rejects.toThrow(/network-guard.*example\.com/);
  });

  it("serves a real recorded fixture for a matched route", async () => {
    const res = await fetch("https://pub.orcid.org/v3.0/0000-0003-3033-7184/works");
    const json = await res.json();
    expect(json.group).toBeDefined();
  });

  it("★ closes the lib/ai.ts bypass — it never calls fetchWithRetry, but the guard still catches it", async () => {
    process.env.AI_PROVIDER = "groq";
    process.env.AI_MODEL = "test-model";
    process.env.GROQ_API_KEY = "test-key";
    vi.doMock("../lib/db", () => ({ execute: vi.fn().mockResolvedValue(undefined) }));

    const { callAI } = await import("../lib/ai");

    // lib/ai.ts retries a thrown fetch (its own backoff loop, separate from
    // fetchWithRetry — Session 0's finding) — real delays without this.
    await withFakeTimers(async () => {
      await expect(callAI({ appName: "test", taskType: "test", prompt: "hi" })).rejects.toThrow(/AI provider unavailable/);
    });

    vi.doUnmock("../lib/db");
  });

  it("★ closes the lib/wordpress.ts bypass — no retry wrapper at all, fails on the first attempt", async () => {
    const { fetchRoster } = await import("../lib/wordpress");
    await expect(fetchRoster("https://example.com/wp-json/wp/v2/person")).rejects.toThrow(/network-guard/);
  });
});

describe("withFakeTimers", () => {
  it("resolves a function with a real-shaped setTimeout delay without spending real wall-clock time", async () => {
    const start = Date.now();
    const result = await withFakeTimers(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return "done";
    });
    expect(result).toBe("done");
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("environment smoke — MOCK_GMAIL_SEND + the email kill switch", () => {
  const original = process.env.MOCK_GMAIL_SEND;
  afterEach(() => {
    if (original === undefined) delete process.env.MOCK_GMAIL_SEND;
    else process.env.MOCK_GMAIL_SEND = original;
  });

  it("resolveMockSendMessageFn returns a mock (not the real sender) when MOCK_GMAIL_SEND=1", async () => {
    process.env.MOCK_GMAIL_SEND = "1";
    const fn = resolveMockSendMessageFn();
    expect(fn).toBeInstanceOf(Function);
    await expect(fn!({ to: "a@b.com", from: "c@d.com", replyTo: "c@d.com", subject: "s", body: "b" })).resolves.toBeUndefined();
  });

  it("resolveMockSendMessageFn returns undefined (real sender would engage) when MOCK_GMAIL_SEND is unset", () => {
    delete process.env.MOCK_GMAIL_SEND;
    expect(resolveMockSendMessageFn()).toBeUndefined();
  });

  it("email_notifications_enabled defaults to disabled on a freshly-migrated test DB", async () => {
    const db = await createTestDb();
    try {
      expect(await isEmailNotificationsEnabled(db.client)).toBe(false);
    } finally {
      await db.teardown();
    }
  });
});
