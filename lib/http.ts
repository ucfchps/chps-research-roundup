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

export interface FetchWithRetryOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  isRetryableStatus?: (status: number) => boolean;
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
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!isRetryableStatus(res.status)) return res;

      lastError = new Error(`HTTP ${res.status}`);
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt) break;
      await sleep(backoffDelayMs(attempt, parseRetryAfterMs(res.headers.get("retry-after"))));
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt) break;
      await sleep(backoffDelayMs(attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}
