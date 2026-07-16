// Pure. No I/O. See §5a.3 of the master plan and docs/wp-directory-notes.md §3–4.

// The WordPress ACF field (`google_scholar`) is a GENERIC research-profile field —
// roughly 1 in 7 populated entries is ResearchGate, an NCBI bibliography, or a bare
// DOI entered in error. A non-Scholar URL happens to have no `user` param, so an
// unguarded parser returns null by luck; check the host explicitly instead.
export function scholarUserId(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== "scholar.google.com") return null;
    // Case-sensitive — real IDs mix case and contain "_" and "-". Never lowercase.
    return parsed.searchParams.get("user");
  } catch {
    return null; // never throw — this runs inside a nightly job
  }
}

const REDIRECT_WRAPPER_HOSTS = new Set(["google.com", "www.google.com", "scholar.google.com"]);
const REDIRECT_WRAPPER_PARAMS = ["url", "q"];
const MAX_UNWRAP_DEPTH = 5;

// Defensive: no real fixture in this inbox has ever shown a wrapped footer
// link (docs/scholar-alert-notes.md §1), but the directory could plausibly
// contain one. Never throws — always falls back to the input string.
export function unwrapGoogleRedirect(url: string, depth = 0): string {
  if (depth >= MAX_UNWRAP_DEPTH) return url;

  try {
    const parsed = new URL(url.trim());
    if (!REDIRECT_WRAPPER_HOSTS.has(parsed.hostname)) return url;

    for (const param of REDIRECT_WRAPPER_PARAMS) {
      const inner = parsed.searchParams.get(param);
      if (inner) return unwrapGoogleRedirect(inner, depth + 1);
    }
    return url;
  } catch {
    return url;
  }
}
