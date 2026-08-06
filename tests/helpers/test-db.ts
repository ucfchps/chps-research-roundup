// Phase 5 hardening, Session 1: ephemeral, real-schema test databases. Every
// hardening test builds its own DB via createTestDb() — schema comes from
// the real migration runner (db/migrate.ts::runMigrations), never a
// hand-maintained copy, so a schema drift between this and production would
// have to also be a bug in the migrations themselves, not a fixture rot.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../db/migrate";

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "db", "migrations");

// ★ Allowlist, not denylist (Session 0's explicit correction — a denylist
// that depends on someone naming things carefully is one typo from
// useless). Refuse unless the resolved URL is unambiguously safe: a temp
// file path under os.tmpdir(), or an exact match for HARDENING_TEST_DB_URL
// — and even then, only if HARDENING_TEST_DB_URL doesn't itself happen to
// equal production (a real, checkable misconfiguration, not a hypothetical
// one — see the second self-test in tests/harness.test.ts). Exported
// standalone, not just used internally by createTestDb(), so any future
// Phase 5 helper that needs to touch a DB URL can reuse the same check
// rather than re-deriving it.
export function assertSafeTestUrl(url: string): void {
  if (url.startsWith("file:")) {
    const filePath = url.slice("file:".length);
    const resolvedTmp = path.resolve(tmpdir());
    const resolvedFile = path.resolve(filePath);
    if (resolvedFile === resolvedTmp || resolvedFile.startsWith(resolvedTmp + path.sep)) return;
    throw new Error(
      `Refusing to run hardening tests against a file: URL outside os.tmpdir(): "${url}" resolved to "${resolvedFile}", tmpdir is "${resolvedTmp}".`
    );
  }

  const hardeningUrl = process.env.HARDENING_TEST_DB_URL;
  if (!hardeningUrl) {
    throw new Error(
      `Refusing to run hardening tests: "${url}" is not a tmpdir file: URL, and HARDENING_TEST_DB_URL is unset — there is nothing to allowlist it against. Set HARDENING_TEST_DB_URL to the scratch DB's URL, or use a tmpdir file: URL instead.`
    );
  }
  if (hardeningUrl === process.env.TURSO_DATABASE_URL) {
    throw new Error(
      `Refusing to run hardening tests: HARDENING_TEST_DB_URL is identical to TURSO_DATABASE_URL (production). This allowlist entry would silently point every hardening test at the live database.`
    );
  }
  if (url !== hardeningUrl) {
    throw new Error(`Refusing to run hardening tests against an unrecognized URL: "${url}". This does not match HARDENING_TEST_DB_URL and is not a tmpdir file: URL.`);
  }
}

export interface TestDb {
  client: Client;
  url: string;
  teardown: () => Promise<void>;
}

// One fresh temp-file DB per call — callers typically call this once in
// beforeEach/beforeAll and call teardown() in the matching after*.
export async function createTestDb(): Promise<TestDb> {
  const dir = mkdtempSync(path.join(tmpdir(), "phase5-hardening-"));
  const dbPath = path.join(dir, "test.db");
  const url = `file:${dbPath}`;

  assertSafeTestUrl(url);

  const client = createClient({ url });
  await client.execute("PRAGMA foreign_keys = ON");
  await runMigrations(client, MIGRATIONS_DIR);

  return {
    client,
    url,
    teardown: async () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
