// Pure decision function for the Scholar ingester (§13 item 9). No I/O — every
// value (the already-caught Crossref outcome, the already-fetched roster and
// existing-match row) is a parameter, so this is testable without a database,
// a mailbox, or a network. Composes lib/matching.ts (Session 5, unmodified).
import { findMatch, mergeAuthors, mergeMetadata, normalizeTitle } from "./matching";
import type { AuthorInput, ExistingAuthor, MatchableExisting, MergeableExisting, MergedAuthor, PublicationMetadata } from "./matching";
import type { CrossrefResolution, Faculty } from "./types";

export type CrossrefOutcome =
  | { kind: "resolved"; resolution: CrossrefResolution }
  | { kind: "not_found" } // Crossref answered and had nothing — §5a.8
  | { kind: "unavailable"; reason: string }; // infrastructure failure — never needs_metadata

export interface DiscoveredArticle {
  title: string;
  year: number | null;
  scholarUrl: string | null;
}

export interface ExistingMatch {
  id: number;
  metadata: MergeableExisting;
  authors: ExistingAuthor[];
}

export type IngestOutcome =
  | { kind: "skip_unknown_author"; scholarUserId: string; displayName: string }
  | { kind: "merged"; publicationId: number; metadata: PublicationMetadata & { title_normalized: string }; authors: MergedAuthor[]; discoveringFacultyLinked: boolean }
  | {
      kind: "insert_resolved";
      publication: PublicationMetadata & {
        title_normalized: string;
        status: "pending_merge";
        source: "crossref";
        discovered_by_faculty_id: number;
        scholar_alert_url: string | null;
        first_seen_at: string;
        date_added: string;
      };
      authors: AuthorInput[];
      discoveringFacultyLinked: boolean;
      // ★ Mirrors insert_needs_metadata's own field (plan-review round 2):
      // a resolved insert can itself be the "second alert" for a paper an
      // earlier, still-open needs_metadata stub already represents. Same
      // deterministic check, same threshold, opposite direction.
      possibleDuplicateOf: number[];
    }
  | {
      kind: "insert_needs_metadata";
      publication: {
        title: string;
        title_normalized: string;
        url: string;
        year: number | null;
        status: "needs_metadata";
        source: "scholar";
        discovered_by_faculty_id: number;
        scholar_alert_url: string | null;
        first_seen_at: string;
        date_added: string;
      };
      // ★ Plan-review addendum: publication ids whose title shares most of
      // its significant tokens with this one. Deterministic, no AI, never
      // blocks the insert — see the "possible-duplicate surfacing" note
      // below decideArticleOutcome. Always [] unless a loose match is found.
      possibleDuplicateOf: number[];
    }
  | { kind: "retry_later"; reason: string };

// §5a.3 — the join, case-sensitive, exact. Never a fallback to name matching.
export function resolveDiscoveringFaculty(scholarUserId: string, roster: Faculty[]): Faculty | null {
  return roster.find((f) => f.scholar_user_id === scholarUserId) ?? null;
}

function normalizeForCompare(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function parseCitationName(name: string): { family: string; firstInitial: string | null } | null {
  const idx = name.indexOf(",");
  if (idx === -1) return null;
  const family = name.slice(0, idx).trim();
  const initials = name.slice(idx + 1).replace(/\./g, "").trim();
  return { family, firstInitial: initials[0]?.toLowerCase() ?? null };
}

// Both Crossref author names (formatCrossrefAuthorName, lib/crossref.ts) and
// faculty.display_name (toCitationName, lib/names.ts) are already in
// "Family, G.I." citation form — matching reduces to comparing that shape.
export function matchAuthorNameToFaculty(authorName: string, roster: Faculty[]): Faculty | null {
  const parsedAuthor = parseCitationName(authorName);
  if (!parsedAuthor) return null;
  const authorFamily = normalizeForCompare(parsedAuthor.family);

  return (
    roster.find((f) => {
      const parsedFaculty = parseCitationName(f.display_name);
      if (!parsedFaculty) return false;
      if (normalizeForCompare(parsedFaculty.family) !== authorFamily) return false;
      if (parsedAuthor.firstInitial && parsedFaculty.firstInitial) {
        return parsedAuthor.firstInitial === parsedFaculty.firstInitial;
      }
      return true;
    }) ?? null
  );
}

function buildAuthorInputs(authors: CrossrefResolution["authors"], roster: Faculty[], nowIso: string): AuthorInput[] {
  return authors.map((a) => {
    const match = matchAuthorNameToFaculty(a.name, roster);
    return match
      ? { name: a.name, faculty_id: match.id, role: "chps_faculty" as const, role_set_by: "ingest", role_set_at: nowIso, position: a.position }
      : { name: a.name, faculty_id: null, role: "unknown" as const, role_set_by: null, role_set_at: null, position: a.position };
  });
}

function metadataFromResolution(resolution: CrossrefResolution): PublicationMetadata {
  return {
    doi: resolution.doi, title: resolution.title, url: resolution.url, journal: resolution.journal,
    year: resolution.year, volume: resolution.volume, issue: resolution.issue, pages: resolution.pages,
  };
}

function toPlainMetadata(m: MergeableExisting): PublicationMetadata {
  const { doi, title, url, journal, year, volume, issue, pages } = m;
  return { doi, title, url, journal, year, volume, issue, pages };
}

const DUPLICATE_TOKEN_OVERLAP_THRESHOLD = 0.7;
const MIN_SIGNIFICANT_TOKEN_LENGTH = 4;

function significantTokens(normalizedTitle: string): Set<string> {
  return new Set(normalizedTitle.split(" ").filter((t) => t.length >= MIN_SIGNIFICANT_TOKEN_LENGTH));
}

// ★ Plan-review addendum. §15.2/§15.11: cheap, deterministic, non-blocking.
// findMatch (exact title/DOI) correctly returns NEEDS_FUZZY when two
// co-authors' alerts for the same paper drift in wording (one resolves via
// Crossref, one doesn't — the exact §15.8 "acute compared to chronic" vs.
// "acute and chronic" shape). Left unmitigated, that produces a second,
// duplicate needs_metadata row for an already-pending_merge paper, and
// nobody notices (§15.11 — the class of failure this whole plan is written
// to avoid). This is NOT a matching-engine change and NOT AI — it only
// flags the risk in the run summary, the same way discoveringFacultyLinked
// already flags its own class of miss. A real fuzzy-match decision
// (lib/matching-ai.ts) is a bigger call than this session makes
// unilaterally — see the plan header.
function findPossibleDuplicates(candidateTitle: string, existing: MatchableExisting[]): number[] {
  const candidateTokens = significantTokens(normalizeTitle(candidateTitle));
  if (candidateTokens.size === 0) return [];

  return existing
    .filter((e) => {
      const existingTokens = significantTokens(e.title_normalized);
      if (existingTokens.size === 0) return false;
      let shared = 0;
      for (const t of candidateTokens) if (existingTokens.has(t)) shared++;
      return shared / (candidateTokens.size + existingTokens.size - shared) >= DUPLICATE_TOKEN_OVERLAP_THRESHOLD;
    })
    .map((e) => e.id);
}

// Given: this article, the faculty member whose alert discovered it (already
// resolved via resolveDiscoveringFaculty — see scripts/ingest-scholar.ts for
// the skip_unknown_author short-circuit that happens before this is ever
// called), the already-computed Crossref outcome, an already-fetched
// existing-match row (or null if findMatch found nothing), the full
// lightweight existing-publications list (for the possible-duplicate
// surfacing check below — the same list the caller already fetched to run
// findMatch), the full active roster, and "now" — decide what happens next.
// Pure.
export function decideArticleOutcome(
  article: DiscoveredArticle,
  matchedFaculty: Faculty,
  crossrefOutcome: CrossrefOutcome,
  existingMatch: ExistingMatch | null,
  existing: MatchableExisting[],
  roster: Faculty[],
  nowIso: string
): Exclude<IngestOutcome, { kind: "skip_unknown_author" }> {
  if (crossrefOutcome.kind === "unavailable") {
    return { kind: "retry_later", reason: crossrefOutcome.reason };
  }

  if (crossrefOutcome.kind === "not_found") {
    if (existingMatch) {
      // §9 idempotency: a second alert (or a re-run of the same email) for a
      // paper Crossref still can't resolve. Nothing new to contribute —
      // acknowledge the existing record, create nothing.
      return {
        kind: "merged",
        publicationId: existingMatch.id,
        metadata: { ...toPlainMetadata(existingMatch.metadata), title_normalized: normalizeTitle(existingMatch.metadata.title) },
        authors: existingMatch.authors.map((a) => ({ ...a })),
        discoveringFacultyLinked: existingMatch.authors.some((a) => a.faculty_id === matchedFaculty.id),
      };
    }

    return {
      kind: "insert_needs_metadata",
      publication: {
        title: article.title,
        title_normalized: normalizeTitle(article.title),
        url: article.scholarUrl ?? "",
        year: article.year,
        status: "needs_metadata",
        source: "scholar",
        discovered_by_faculty_id: matchedFaculty.id,
        scholar_alert_url: article.scholarUrl,
        first_seen_at: nowIso,
        date_added: nowIso.slice(0, 10),
      },
      possibleDuplicateOf: findPossibleDuplicates(article.title, existing),
    };
  }

  // crossrefOutcome.kind === "resolved"
  const resolution = crossrefOutcome.resolution;
  const incomingMetadata = metadataFromResolution(resolution);
  const incomingAuthors = buildAuthorInputs(resolution.authors, roster, nowIso);

  if (existingMatch) {
    const mergedMetadata = mergeMetadata(existingMatch.metadata, incomingMetadata, "crossref");
    const mergedAuthors = mergeAuthors(existingMatch.authors, incomingAuthors, "crossref");
    return {
      kind: "merged",
      publicationId: existingMatch.id,
      metadata: mergedMetadata,
      authors: mergedAuthors,
      discoveringFacultyLinked: mergedAuthors.some((a) => a.faculty_id === matchedFaculty.id),
    };
  }

  return {
    kind: "insert_resolved",
    publication: {
      ...incomingMetadata,
      title_normalized: normalizeTitle(incomingMetadata.title),
      status: "pending_merge",
      source: "crossref",
      discovered_by_faculty_id: matchedFaculty.id,
      scholar_alert_url: article.scholarUrl,
      first_seen_at: nowIso,
      date_added: nowIso.slice(0, 10),
    },
    authors: incomingAuthors,
    discoveringFacultyLinked: incomingAuthors.some((a) => a.faculty_id === matchedFaculty.id),
    possibleDuplicateOf: findPossibleDuplicates(incomingMetadata.title, existing),
  };
}

// Re-exported for the orchestrator: given a candidate (already resolved or
// not), find a match against a freshly-queried existing list. Thin wrapper
// around lib/matching.ts's findMatch — not new dedup logic, just the
// glue the script needs to build an ExistingMatch (or null) before calling
// decideArticleOutcome. NEEDS_FUZZY is treated as "no match" this session —
// lib/matching-ai.ts is out of scope here (see plan header).
export function findCandidateMatch(candidateTitle: string, candidateDoi: string | null, existing: MatchableExisting[]) {
  return findMatch({ doi: candidateDoi, title: candidateTitle }, existing);
}
