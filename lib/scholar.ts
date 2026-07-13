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
