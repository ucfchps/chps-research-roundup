// §8c admin auth: brute-force lockout for the single-shared-secret login.
// Backed by the settings table (16.2), not an in-memory counter — this is
// meant to run on Vercel, where a serverless cold start would reset an
// in-memory counter constantly, making it silently useless. Known
// limitation either way: one shared counter, not per-IP — a handful of
// wrong guesses from anyone locks the login out for everyone during the
// window. Acceptable for a single shared secret with no public signup
// surface; would need to become per-IP if this ever grows real user
// accounts.
import type { Client } from "@libsql/client";
import { getSetting, setSetting } from "./settings";

const LOCKOUT_KEY = "admin_login_attempts";
export const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

interface LoginAttemptState {
  count: number;
  lockedUntil: string | null;
}

async function readState(client: Client): Promise<LoginAttemptState> {
  const raw = await getSetting(client, LOCKOUT_KEY);
  if (!raw) return { count: 0, lockedUntil: null };
  try {
    const parsed = JSON.parse(raw) as Partial<LoginAttemptState>;
    return { count: parsed.count ?? 0, lockedUntil: parsed.lockedUntil ?? null };
  } catch {
    return { count: 0, lockedUntil: null };
  }
}

async function writeState(client: Client, state: LoginAttemptState): Promise<void> {
  await setSetting(client, LOCKOUT_KEY, JSON.stringify(state), "admin-auth");
}

export async function isLoginLocked(client: Client, now: Date = new Date()): Promise<{ locked: boolean; lockedUntil: string | null }> {
  const state = await readState(client);
  if (state.lockedUntil && new Date(state.lockedUntil).getTime() > now.getTime()) {
    return { locked: true, lockedUntil: state.lockedUntil };
  }
  return { locked: false, lockedUntil: null };
}

export async function recordFailedLoginAttempt(client: Client, now: Date = new Date()): Promise<void> {
  const state = await readState(client);
  // A prior lockout window that has already passed is treated as expired —
  // this failed attempt starts a fresh count rather than extending a stale one.
  const lockoutExpired = state.lockedUntil !== null && new Date(state.lockedUntil).getTime() <= now.getTime();
  const count = (lockoutExpired ? 0 : state.count) + 1;
  const lockedUntil = count >= MAX_LOGIN_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_MINUTES * 60000).toISOString() : lockoutExpired ? null : state.lockedUntil;
  await writeState(client, { count, lockedUntil });
}

export async function recordSuccessfulLogin(client: Client): Promise<void> {
  await writeState(client, { count: 0, lockedUntil: null });
}
