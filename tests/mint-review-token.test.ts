// scripts/mint-review-token.ts is an explicit stopgap/testing utility (§8b),
// not the real campaign tool — but the mint itself must still uphold the
// token security model: only the hash persisted, correct expiry, one row
// per mint. DB-backed, temp-SQLite via runMigrations.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { hashToken } from "../lib/tokens";
import { mintReviewToken, parseArgs } from "../scripts/mint-review-token";

describe("parseArgs", () => {
  it("parses --faculty <wp_id>", () => {
    expect(parseArgs(["--faculty", "123"])).toEqual({ facultyWpId: "123" });
  });

  it("parses --faculty=<wp_id>", () => {
    expect(parseArgs(["--faculty=123"])).toEqual({ facultyWpId: "123" });
  });

  it("returns null when --faculty is absent", () => {
    expect(parseArgs([])).toEqual({ facultyWpId: null });
  });
});

describe("mintReviewToken", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "mint-token-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
    await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, unit, active) VALUES ('42', 'r-zraick', 'Zraick, R.I.', 'Department of Health Sciences', 1)`,
      args: [],
    });
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("throws for an unknown wp_id", async () => {
    await expect(mintReviewToken(client, "does-not-exist", 90)).rejects.toThrow(/no faculty/i);
  });

  it("inserts a review_requests row with only the token HASH, never the raw token", async () => {
    const { token } = await mintReviewToken(client, "42", 90);

    const rows = (await client.execute("SELECT * FROM review_requests")).rows as unknown as Array<{ token_hash: string; faculty_id: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashToken(token));
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].faculty_id).toBe(1);
  });

  it("uses the faculty's slug for the cosmetic URL segment", async () => {
    const { slug } = await mintReviewToken(client, "42", 90);
    expect(slug).toBe("r-zraick");
  });

  it("sets expires_at ttlDays in the future", async () => {
    await mintReviewToken(client, "42", 90);

    const rows = (await client.execute("SELECT expires_at, created_at FROM review_requests")).rows as unknown as Array<{ expires_at: string; created_at: string }>;
    const deltaMs = new Date(rows[0].expires_at).getTime() - new Date(rows[0].created_at).getTime();
    expect(Math.round(deltaMs / 86400000)).toBe(90);
  });

  it("the returned token actually resolves via getReviewRequestByToken", async () => {
    const { getReviewRequestByToken } = await import("../lib/review");
    const { token } = await mintReviewToken(client, "42", 90);

    const reviewRequest = await getReviewRequestByToken(client, token);
    expect(reviewRequest?.faculty_id).toBe(1);
  });
});
