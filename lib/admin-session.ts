// §8c admin auth. Pure crypto, no I/O — a signed, httpOnly session cookie is
// enough for a single shared admin password (§12); no sessions table, no JWT
// library, matching this codebase's minimal-dependency posture (plain fetch,
// no ORM, no vendor SDKs — see lib/gmail.ts's header comment for the same
// reasoning applied to HTTP clients).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Token shape: base64url(expiresAtMs) + "." + hmac-sha256(secret, that).
// The expiry lives in the signed payload, not just a cookie Max-Age a client
// could ignore — verifySessionToken enforces it server-side on every check.
export function createSessionToken(secret: string, expiresAt: Date): string {
  const payload = Buffer.from(String(expiresAt.getTime())).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifySessionToken(secret: string, token: string, now: Date): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;

  const expectedSig = createHmac("sha256", secret).update(payload).digest("hex");
  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");
  // timingSafeEqual throws on length mismatch — check first rather than
  // catch, a tampered/malformed signature must fail closed either way.
  if (sigBuf.length !== expectedBuf.length) return false;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return false;

  const expiresAtMs = Number(Buffer.from(payload, "base64url").toString("utf-8"));
  if (!Number.isFinite(expiresAtMs)) return false;
  return now.getTime() < expiresAtMs;
}

// Constant-time regardless of input length: hash both sides to a fixed-size
// digest first, then timingSafeEqual the digests. A naive timingSafeEqual on
// the raw strings would throw whenever lengths differ (the common case for
// any wrong guess) and a naive === leaks how many leading characters
// matched via response timing — this avoids both.
export function comparePasswordConstantTime(input: string, expected: string): boolean {
  const inputHash = createHash("sha256").update(input).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(inputHash, expectedHash);
}
