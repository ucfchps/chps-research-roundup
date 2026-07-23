// §8b security model: the review-page token is a capability URL, the same
// pattern as an unsubscribe link. Pure, no I/O — no DB, no email.
import { createHash, randomBytes } from "node:crypto";

// 256 bits — comfortably over the ≥128-bit minimum. base64url avoids the
// need for URL-encoding in an email link (no +, /, or = padding).
const TOKEN_BYTES = 32;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// The raw token exists only transiently, at mint time — the caller puts it
// into an email/URL and discards it. Only tokenHash is ever stored.
export function generateReviewToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}
