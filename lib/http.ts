// Shared HTTP retry/backoff helper. Extracted so lib/crossref.ts (Session 6)
// and lib/refresh-metadata.ts (Session 7) don't each duplicate this — see the
// Session 6 prompt, point 6. lib/ai.ts predates this and keeps its own copy.

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

function backoffDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const base = 500 * 2 ** attempt;
  return base + Math.random() * base * 0.5;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultIsRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// docs/phase5-findings.md (Session 13 diagnostic): "successful after N
// silent retries" and "successful on the first try" are indistinguishable
// from a caller's return value alone — the caller just gets a Response
// either way. onAttempt is the deliberate seam that fixes that: one call
// per attempt, whether it ended in a response, a retryable status, or a
// thrown error (timeout/network), always carrying that attempt's own
// wall-clock duration and the backoff delay (if any) that follows it. Purely
// additive and opt-in — omitting it is byte-for-byte the prior behavior, so
// every existing caller/test is unaffected.
export interface FetchAttemptInfo {
  attempt: number; // 0-indexed
  status: number | null; // null when the attempt threw (network error/timeout) rather than returning a Response
  ok: boolean; // true only on the attempt that fetchWithRetry is about to return (or its final failed attempt)
  attemptMs: number; // this attempt's own wall-clock duration (fetch call to settle, timeout or not)
  backoffMs: number; // delay slept AFTER this attempt, before the next one — 0 on the last attempt
  errorMessage: string | null; // set when this attempt threw (e.g. "AbortError: This operation was aborted" on a timeout)
}

export interface FetchWithRetryOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  isRetryableStatus?: (status: number) => boolean;
  onAttempt?: (info: FetchAttemptInfo) => void;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MS = 15_000;

// Fetches `url`, retrying on 429/5xx and network errors/timeouts with
// jittered exponential backoff honoring Retry-After. Returns as soon as a
// non-retryable status is seen (including ordinary 4xx — callers decide what
// those mean; e.g. a 404 on a DOI lookup is "not found," not "unavailable").
// Throws only once the retry budget is exhausted.
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: FetchWithRetryOptions = {}
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const isRetryableStatus = opts.isRetryableStatus ?? defaultIsRetryableStatus;

  let lastError: Error = new Error("request never attempted");

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const attemptStart = Date.now();
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const attemptMs = Date.now() - attemptStart;
      if (!isRetryableStatus(res.status)) {
        opts.onAttempt?.({ attempt, status: res.status, ok: true, attemptMs, backoffMs: 0, errorMessage: null });
        return res;
      }

      lastError = new Error(`HTTP ${res.status}`);
      const isLastAttempt = attempt === maxAttempts - 1;
      const backoffMs = isLastAttempt ? 0 : backoffDelayMs(attempt, parseRetryAfterMs(res.headers.get("retry-after")));
      opts.onAttempt?.({ attempt, status: res.status, ok: false, attemptMs, backoffMs, errorMessage: null });
      if (isLastAttempt) break;
      await sleep(backoffMs);
    } catch (err) {
      const attemptMs = Date.now() - attemptStart;
      lastError = err instanceof Error ? err : new Error(String(err));
      const isLastAttempt = attempt === maxAttempts - 1;
      const backoffMs = isLastAttempt ? 0 : backoffDelayMs(attempt);
      opts.onAttempt?.({ attempt, status: null, ok: false, attemptMs, backoffMs, errorMessage: lastError.message });
      if (isLastAttempt) break;
      await sleep(backoffMs);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}
