// §8b security model: "cryptographically random token, ≥128 bits, from a
// CSPRNG. Never sequential, never derived from the name or ID." "Store only
// sha256(token). A database leak must not yield working links." Pure, no I/O.
import { describe, expect, it } from "vitest";
import { generateReviewToken, hashToken } from "../lib/tokens";

describe("generateReviewToken", () => {
  it("produces a token with at least 128 bits of entropy", () => {
    const { token } = generateReviewToken();
    // base64url: 4 chars per 3 bytes. >=128 bits = >=16 bytes = ceil(16*4/3) = 22 chars minimum.
    expect(token.length).toBeGreaterThanOrEqual(22);
  });

  it("is URL-safe (no +, /, or = padding characters)", () => {
    const { token } = generateReviewToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never produces the same token twice across many calls (CSPRNG, not sequential/derived)", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateReviewToken().token));
    expect(tokens.size).toBe(200);
  });

  it("returns a tokenHash that matches hashToken(token) independently", () => {
    const { token, tokenHash } = generateReviewToken();
    expect(tokenHash).toBe(hashToken(token));
  });
});

describe("hashToken", () => {
  it("is deterministic — same input always produces the same hash", () => {
    expect(hashToken("abc123")).toBe(hashToken("abc123"));
  });

  it("produces a 64-character hex string (SHA-256)", () => {
    expect(hashToken("abc123")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different tokens produce different hashes", () => {
    expect(hashToken("abc123")).not.toBe(hashToken("abc124"));
  });
});
