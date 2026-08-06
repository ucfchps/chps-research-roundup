// Pure formatting functions — the citation formatter is the product (§15.6).
// No DB reads, no fetch, no AI, no React. See §6 (ROLES), §6a (derived units),
// and §8c Tab 4 (citation format) of the master plan. Ground truth for real-world
// shapes comes from tests/fixtures/live-post-citations.html — read its top
// comment block before touching this file.
import { UNITS, type Faculty, type Publication, type PublicationAuthor, type Unit } from "./types";

// Idempotent on "&": a raw "&" becomes "&amp;", but an already-valid entity
// (e.g. "&amp;" arriving pre-escaped from upstream data) is left alone.
// Already covers double-quoted HTML attribute context (the " -> &quot; line)
// — this is reused as-is for pub.url below, not a separate escaper.
function escapeHtml(text: string): string {
  return text
    .replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Phase 5 hardening: pub.url is the one field a citation carries that isn't
// author-entered text with a fixed shape — it's a raw URL, and until now it
// was interpolated into `<a href="...">` with no escaping and no scheme
// check at all (found via an unauthenticated §8a portal submission, Session
// 7). http/https/mailto is deliberately narrow: every legitimate citation
// link this codebase produces (DOI resolvers, publisher sites, a mailto
// contact) fits one of these three; javascript:/data:/vbscript:/anything
// else is never a citation, only ever an attack shape. Exported so the two
// parse sites that ever accept a submitted URL (app/portal-shared.ts,
// app/admin/pending-submissions/submission-shared.ts) can reject a bad URL
// before it ever reaches the database, using this exact allowlist rather
// than a second, driftable copy of it.
const ALLOWED_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function isAllowedCitationUrl(url: string): boolean {
  try {
    return ALLOWED_URL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false; // unparseable (relative, empty, malformed) — fail closed, same posture as everything else in this codebase (§15.8)
  }
}

export function formatAuthor(author: PublicationAuthor): string {
  const name = escapeHtml(author.name);
  if (author.role === "chps_faculty") return `<strong>${name}</strong>`;
  if (author.role === "grad_student") return `${name}**`;
  if (author.role === "undergrad_student") return `${name}*`;
  // external and unknown render identically — the distinction is a
  // data-quality signal, not a rendering one (§6).
  return name;
}

export function formatAuthorList(authors: PublicationAuthor[]): string {
  // Citation author order is significant (§7) — sort by position, never by name.
  const ordered = [...authors].sort((a, b) => a.position - b.position);
  const formatted = ordered.map(formatAuthor);
  if (formatted.length <= 1) return formatted.join("");
  const allButLast = formatted.slice(0, -1).join(", ");
  const last = formatted[formatted.length - 1];
  return `${allButLast}, & ${last}`;
}

function formatVolumeIssuePages(pub: Publication): string {
  const volumeIssue = pub.volume ? (pub.issue ? `${pub.volume}(${pub.issue})` : pub.volume) : "";
  const parts = [volumeIssue, pub.pages].filter((part): part is string => Boolean(part));
  return parts.join(", ");
}

export function formatCitation(pub: Publication, authors: PublicationAuthor[]): string {
  const authorsStr = formatAuthorList(authors);
  const title = escapeHtml(pub.title);
  const volumeIssuePages = formatVolumeIssuePages(pub);
  const journal = pub.journal
    ? `<em>${escapeHtml(pub.journal)}</em>${volumeIssuePages ? `, ${volumeIssuePages}` : ""}.`
    : `${volumeIssuePages}.`;
  // A URL failing the allowlist renders the bare title instead of a link —
  // not a dead "#" href, not the raw/dangerous URL. This function has no
  // way to signal "this record has a bad URL" to a caller other than the
  // rendered HTML itself (it's pure text in, text out — no side channel),
  // and the two write paths that can ever introduce one now reject it before
  // it reaches the database anyway (app/portal-shared.ts,
  // app/admin/pending-submissions/submission-shared.ts) — so reaching this
  // branch in practice means bad legacy data, not a live attack in progress.
  const titleHtml = isAllowedCitationUrl(pub.url) ? `<a href="${escapeHtml(pub.url)}" rel="noopener noreferrer">${title}</a>` : title;
  return `${authorsStr} (${pub.year ?? ""}). ${titleHtml}. ${journal}`;
}

// units(publication) = DISTINCT(faculty.unit) over chps_faculty authors linked
// to a roster row (§6a). [] is a real, expected state — no linked CHPS author
// means the paper belongs to no unit and cannot appear in the roundup.
export function unitsForPublication(
  authors: PublicationAuthor[],
  facultyById: Record<number, Faculty>
): Unit[] {
  const present = new Set<Unit>();
  for (const author of authors) {
    if (author.role !== "chps_faculty" || author.faculty_id === null) continue;
    const faculty = facultyById[author.faculty_id];
    if (faculty?.unit) present.add(faculty.unit);
  }
  return UNITS.filter((unit) => present.has(unit));
}

export interface PublicationWithAuthors {
  publication: Publication;
  authors: PublicationAuthor[];
}

function surname(name: string): string {
  const commaIndex = name.indexOf(",");
  return commaIndex === -1 ? name : name.slice(0, commaIndex);
}

export function sortCitationsWithinUnit(
  pubs: PublicationWithAuthors[]
): PublicationWithAuthors[] {
  return [...pubs].sort((a, b) => {
    const firstOf = (p: PublicationWithAuthors) =>
      [...p.authors].sort((x, y) => x.position - y.position)[0];
    const aSurname = surname(firstOf(a)?.name ?? "");
    const bSurname = surname(firstOf(b)?.name ?? "");
    return aSurname.localeCompare(bSurname);
  });
}
