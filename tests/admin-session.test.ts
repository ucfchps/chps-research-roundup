// §8c admin auth (Session 17): pure session-token crypto + constant-time
// password comparison. No DB, no Next.js — fully unit-testable, same split
// as lib/tokens.ts.
import { describe, expect, it } from "vitest";
import { comparePasswordConstantTime, createSessionToken, verifySessionToken } from "../lib/admin-session";

const SECRET = "test-session-secret";

describe("createSessionToken / verifySessionToken", () => {
  it("a freshly created token verifies as valid before its expiry", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const expiresAt = new Date("2026-01-01T08:00:00.000Z");
    const token = createSessionToken(SECRET, expiresAt);

    expect(verifySessionToken(SECRET, token, now)).toBe(true);
  });

  it("rejects a token past its expiry, even with a correct signature", () => {
    const expiresAt = new Date("2026-01-01T08:00:00.000Z");
    const token = createSessionToken(SECRET, expiresAt);
    const afterExpiry = new Date("2026-01-01T08:00:00.001Z");

    expect(verifySessionToken(SECRET, token, afterExpiry)).toBe(false);
  });

  it("accepts a token exactly at the expiry boundary as already expired (strict less-than)", () => {
    const expiresAt = new Date("2026-01-01T08:00:00.000Z");
    const token = createSessionToken(SECRET, expiresAt);

    expect(verifySessionToken(SECRET, token, expiresAt)).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const expiresAt = new Date("2026-01-01T08:00:00.000Z");
    const token = createSessionToken(SECRET, expiresAt);

    expect(verifySessionToken("a-different-secret", token, now)).toBe(false);
  });

  it("rejects a token with a tampered signature (flipped char)", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const expiresAt = new Date("2026-01-01T08:00:00.000Z");
    const token = createSessionToken(SECRET, expiresAt);
    const [payload, sig] = token.split(".");
    const tamperedSig = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
    const tampered = `${payload}.${tamperedSig}`;

    expect(verifySessionToken(SECRET, tampered, now)).toBe(false);
  });

  it("rejects a token with a tampered payload (flipped char) — signature no longer matches", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const expiresAt = new Date("2026-01-01T08:00:00.000Z");
    const token = createSessionToken(SECRET, expiresAt);
    const [payload, sig] = token.split(".");
    const tamperedPayload = (payload[0] === "a" ? "b" : "a") + payload.slice(1);
    const tampered = `${tamperedPayload}.${sig}`;

    expect(verifySessionToken(SECRET, tampered, now)).toBe(false);
  });

  it("rejects malformed tokens without throwing", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    expect(verifySessionToken(SECRET, "", now)).toBe(false);
    expect(verifySessionToken(SECRET, "not-a-valid-token", now)).toBe(false);
    expect(verifySessionToken(SECRET, "too.many.dots.here", now)).toBe(false);
    expect(verifySessionToken(SECRET, "payload.zzz-not-hex", now)).toBe(false);
  });
});

describe("comparePasswordConstantTime", () => {
  it("returns true for a matching password", () => {
    expect(comparePasswordConstantTime("correct-horse-battery-staple", "correct-horse-battery-staple")).toBe(true);
  });

  it("returns false for a wrong password of the same length", () => {
    expect(comparePasswordConstantTime("correct-horse-battery-staplX", "correct-horse-battery-staple")).toBe(false);
  });

  it("returns false for a wrong password of a different length, without throwing", () => {
    expect(() => comparePasswordConstantTime("short", "correct-horse-battery-staple")).not.toThrow();
    expect(comparePasswordConstantTime("short", "correct-horse-battery-staple")).toBe(false);
  });

  it("returns false for an empty input against a real password, without throwing", () => {
    expect(comparePasswordConstantTime("", "correct-horse-battery-staple")).toBe(false);
  });
});
