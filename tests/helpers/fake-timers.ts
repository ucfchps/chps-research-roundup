// Phase 5 hardening, Session 1: one shared fake-timers pattern. Un-mocked
// exponential backoff (lib/http.ts::fetchWithRetry, lib/ai.ts's own retry
// loop) has caused real timeout flakes in this repo — see the fixes across
// tests/gmail.test.ts, tests/crossref.test.ts, tests/ingest-crossref.test.ts.
// Every future hardening test that exercises a retry path should use this
// instead of re-deriving the vi.useFakeTimers()/vi.runAllTimersAsync()
// sequencing by hand.
import { vi } from "vitest";

export async function withFakeTimers<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const resultPromise = fn();
    await vi.runAllTimersAsync();
    return await resultPromise;
  } finally {
    vi.useRealTimers();
  }
}
