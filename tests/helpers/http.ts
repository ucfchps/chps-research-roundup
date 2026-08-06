// Phase 5 hardening, Session 1: recorded-fixture mocking + a real network
// guard. Installed globally (see tests/setup.ts) so an accidentally-
// unmocked test fails loudly with the offending URL, instead of quietly
// reaching the real internet.
//
// ★ Sits on global fetch itself, not on lib/http.ts's fetchWithRetry
// wrapper. Session 0's surface inventory found two real bypasses of that
// wrapper: lib/ai.ts carries its own separate retry logic (never calls
// fetchWithRetry), and lib/wordpress.ts has no retry wrapper at all — both
// call fetch directly. A wrapper-level guard would miss both; this doesn't,
// because it's underneath the wrapper too (fetchWithRetry itself calls
// fetch). tests/harness.test.ts asserts both bypasses explicitly.
import { readFileSync } from "node:fs";
import path from "node:path";

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "api");

interface FixtureRoute {
  pattern: RegExp;
  file: string;
}

// Keyed to the exact real captures in tests/fixtures/api/ (see that
// directory's README.md for provenance) — not a general "any DOI resolves"
// mock. Each fixture was captured for one specific real query; a test that
// wants a different case should add its own route here or mock fetch
// locally with vi.stubGlobal, same as every existing *.test.ts already does.
const ROUTES: FixtureRoute[] = [
  { pattern: /api\.crossref\.org\/works\/10\.3390\/medsci14020200/, file: "crossref-works-lopez-castillo-hiv-panama.json" },
  { pattern: /api\.crossref\.org\/works\/10\.1016\/j\.jvoice\.2026\.05\.028/, file: "crossref-works-tarakci-vocal-capacity.json" },
  { pattern: /api\.crossref\.org\/works\/10\.1080\/15502783\.2026\.2629828/, file: "crossref-works-issn-antioxidants-position-stand.json" },
  { pattern: /api\.crossref\.org\/works\?.*Creatine/, file: "crossref-title-search-no-confident-match.json" },
  { pattern: /api\.crossref\.org\/works\?.*Fatalism/, file: "crossref-title-search-preprint-vor-collision-lee-fatalism.json" },
  { pattern: /eutils\.ncbi\.nlm\.nih\.gov.*esearch\.fcgi.*Norte/, file: "pubmed-esearch-norte.json" },
  { pattern: /eutils\.ncbi\.nlm\.nih\.gov.*esummary\.fcgi/, file: "pubmed-esummary-norte.json" },
  { pattern: /pub\.orcid\.org\/v3\.0\/0000-0003-3033-7184\/works/, file: "orcid-works-bennett.json" },
];

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as { url: string }).url;
}

let realFetch: typeof fetch | null = null;

// Exported (not just invoked as a side effect of importing this module) so
// tests/harness.test.ts can assert its behavior directly, and so
// tests/setup.ts's job is just "call this" — one obvious place the global
// installation actually happens.
export function installNetworkGuard(): void {
  if (!realFetch) realFetch = globalThis.fetch;

  const guardedFetch = (async (input: unknown, init?: unknown) => {
    const url = urlOf(input);
    const route = ROUTES.find((r) => r.pattern.test(url));
    if (route) {
      const body = readFileSync(path.join(FIXTURES_DIR, route.file), "utf-8");
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(
      `[network-guard] Unmocked fetch to a real network address: ${url}\n` +
        `Mock this in your test (vi.stubGlobal("fetch", ...), same as every existing *.test.ts does), ` +
        `or add a fixture route in tests/helpers/http.ts if it's meant to be a recorded-fixture case.`
    );
  }) as typeof fetch;

  globalThis.fetch = guardedFetch;
}

// Escape hatch for a test that genuinely needs the real fetch (none currently
// do) — kept narrow and explicit rather than a blanket "disable the guard".
export function getRealFetch(): typeof fetch {
  if (!realFetch) throw new Error("installNetworkGuard() has not run yet — there is no captured real fetch.");
  return realFetch;
}
