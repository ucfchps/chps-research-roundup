// §8c admin auth: Next.js-specific session glue. The actual crypto
// (signing/verifying) lives in lib/admin-session.ts, fully unit-testable
// with no framework dependency — this file is the thin, Next-only wiring
// around it (cookies(), redirect()), same split as lib/review.ts vs
// app/review/[slug]/[token]/page.tsx.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSessionToken, verifySessionToken } from "@/lib/admin-session";

const COOKIE_NAME = "admin_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours, server-enforced via the signed expiry — not just cookie Max-Age

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET must be set (see .env.example)");
  return secret;
}

export async function setAdminSessionCookie(): Promise<void> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const token = createSessionToken(getSessionSecret(), expiresAt);
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearAdminSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export async function hasValidAdminSession(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return false;
  return verifySessionToken(getSessionSecret(), token, new Date());
}

// Call at the top of every admin page AND every admin Server Action — not
// relied on solely via a shared layout, which a later page could add
// outside of without inheriting the check. Cheap enough to call everywhere.
export async function requireAdminSession(): Promise<void> {
  if (!(await hasValidAdminSession())) {
    redirect("/admin/login");
  }
}
