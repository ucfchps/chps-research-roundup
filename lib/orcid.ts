// Pure. No I/O. A sibling of lib/scholar.ts, same discipline — see
// docs/wp-directory-notes.md §9. The `orcid` ACF field stores a full URL; the
// ORCID API and Crossref both want the bare iD.
export function orcidId(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== "orcid.org" && parsed.hostname !== "www.orcid.org") return null;
    // The final character is a checksum digit that can be "X" — a pattern
    // assuming four trailing digits silently drops those people.
    const match = parsed.pathname.match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/);
    return match ? match[1] : null;
  } catch {
    return null; // never throw — this runs inside a nightly job
  }
}
