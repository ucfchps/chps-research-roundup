// Matching & merge engine. Pure functions only — no I/O, no AI. See master
// plan §5 (layer priority) and §7 (dedup & merge). The ingestion jobs that
// call these, and the fuzzy-match AI escape hatch (lib/matching-ai.ts), are
// out of scope here.
import type { AuthorRole, PublicationSource, PublicationStatus } from "./types";

// Deterministic, no AI. Populates publications.title_normalized. Lowercases,
// strips punctuation and diacritics, collapses whitespace. "&" is expanded to
// "and" before stripping so both spellings converge on the same string.
export function normalizeTitle(title: string): string {
  return title
    .replace(/&/g, " and ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritic combining marks
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "") // strip remaining punctuation (quotes, colons, em-dashes, periods, hyphens, ...)
    .replace(/\s+/g, " ")
    .trim();
}

// "university"/"univ."/"univ"/"u." (period optional) + "of central florida",
// or a bare "UCF" — real Crossref affiliation strings seen used "Univ. of
// Central Florida" (missed by a spelled-out-only match) alongside the fully
// spelled-out form. Requiring the literal "central florida" after the prefix
// keeps this safe against "University of Florida"/"University of South
// Florida"/etc — those never match, since there's no "central". Lives here
// (not lib/crossref.ts) so buildAuthorInputs below can gate on it without a
// hard dependency on lib/crossref.ts's CROSSREF_MAILTO import-time throw —
// every ingester needs this check, not just Crossref-specific ones.
// lib/crossref.ts re-exports this same function for backward compatibility.
const UCF_AFFILIATION_PATTERN = /\b(?:university|univ\.?|u\.)\s+of\s+central\s+florida\b|\bUCF\b/i;

export function isUcfAffiliation(affiliation: string | null | undefined): boolean {
  return affiliation ? UCF_AFFILIATION_PATTERN.test(affiliation) : false;
}

// docs/phase5-findings.md #2 (Session 12): a plausibility signal, never a
// hard exclusion — PubMed's searchPubmedByAuthor deliberately has no
// affiliation filter of its own (a real UCF paper carrying a visiting-
// scholar/prior-job affiliation string must not be silently dropped), so a
// common-surname query returns a lot of genuinely unrelated, same-named
// authors worldwide (Session 11: 89/229 faculty, up to 257,622 global
// matches for one surname). This never gates whether a candidate reaches
// the merge engine — every candidate is still attempted — it only
// classifies what's known about it for a human reviewer:
//   "confirmed"  — at least one author's affiliation string matches UCF
//   "not_ucf"    — affiliation data exists for at least one author, and
//                  NONE of it matches — a real, specific signal this is
//                  probably someone else's paper, not an absence of data
//   "ambiguous"  — no affiliation data at all was retrievable (PubMed's own
//                  affiliation-capture coverage is incomplete — confirmed
//                  real, e.g. every pre-1990s record) — genuinely unknown,
//                  not evidence either way
export type AffiliationPlausibility = "confirmed" | "not_ucf" | "ambiguous";

export function classifyAffiliationPlausibility(affiliations: string[]): AffiliationPlausibility {
  if (affiliations.some((a) => isUcfAffiliation(a))) return "confirmed";
  if (affiliations.length > 0) return "not_ucf";
  return "ambiguous";
}

// Lowercase, strip the https://doi.org/ prefix — so a bare DOI and a
// URL-prefixed DOI for the same paper compare equal.
export function normalizeDoi(doi: string | null): string | null {
  if (!doi) return null;
  const trimmed = doi.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^https:\/\/doi\.org\//i, "").toLowerCase();
}

export interface PublicationCandidate {
  doi: string | null;
  title: string;
}

export interface MatchableExisting {
  id: number;
  doi: string | null;
  title_normalized: string;
}

export type MatchResult =
  | { type: "MATCH"; publicationId: number; reason: "doi" | "title" }
  | { type: "NEEDS_FUZZY" };

// §7's ladder, in order, stopping at the first confident answer. Step 3 (fuzzy
// match via AI) is deliberately NOT called here — see lib/matching-ai.ts. That
// keeps this module pure and instantly testable (§15.2).
export function findMatch(candidate: PublicationCandidate, existing: MatchableExisting[]): MatchResult {
  const candidateDoi = normalizeDoi(candidate.doi);
  if (candidateDoi) {
    const doiMatch = existing.find((e) => normalizeDoi(e.doi) === candidateDoi);
    if (doiMatch) return { type: "MATCH", publicationId: doiMatch.id, reason: "doi" };
  }

  const candidateTitle = normalizeTitle(candidate.title);
  const titleMatch = existing.find((e) => e.title_normalized === candidateTitle);
  if (titleMatch) return { type: "MATCH", publicationId: titleMatch.id, reason: "title" };

  return { type: "NEEDS_FUZZY" };
}

// Session 21 (§13.24 operational backfill): a real production regression —
// mergeAuthors's own dedup key used to be normalizeTitle(name), which only
// COLLAPSES whitespace, never removes it. Two equally valid formats of the
// same compound-initial name ("Lubiak, S.M." vs "Lubiak, S. M.") differ by
// exactly one internal space and normalized to DIFFERENT strings — a real
// reconcile run appended 11 already-existing authors as duplicates on one
// publication alone before this fix. Unlike a title, a name's internal
// whitespace is never semantically meaningful, so this strips it entirely.
export function normalizeAuthorName(name: string): string {
  return normalizeTitle(name).replace(/\s+/g, "");
}

export interface AuthorInput {
  name: string;
  faculty_id: number | null;
  role: AuthorRole;
  role_set_by: string | null;
  role_set_at: string | null;
  position: number;
  // Raw evidence carried alongside the role decision (ops-notes.md §5/§6) —
  // not persisted to publication_authors (no DB column for it); available
  // for the caller/tests to inspect why buildAuthorInputs decided what it did.
  affiliation?: string;
}

export interface ExistingAuthor extends AuthorInput {
  id: number;
}

export interface MergedAuthor extends AuthorInput {
  id: number | null; // null = not yet persisted — caller must insert
}

// Exported so callers outside the merge itself (e.g. a reconcile script
// reporting WHY a fixture-vs-production disagreement was left alone) can
// ask the same question mergeAuthors already answers internally, rather
// than re-deriving the "faculty:"/"comms:" prefix check a second place.
export function isHumanSet(roleSetBy: string | null): boolean {
  return roleSetBy !== null && (roleSetBy.startsWith("faculty:") || roleSetBy.startsWith("comms:"));
}

// §7's author merge rules. Matches by normalized name, preserves original
// citation `position` (never appends a newly-recognized CHPS faculty author
// to the end), and never overwrites or downgrades a role — human-set roles
// (role_set_by starting "faculty:" or "comms:") are never touched, full stop
// (§15.1, §15.4).
export function mergeAuthors(
  existing: ExistingAuthor[],
  incoming: AuthorInput[],
  incomingSource: PublicationSource
): MergedAuthor[] {
  const merged: MergedAuthor[] = existing.map((a) => ({ ...a }));
  const byName = new Map(merged.map((a) => [normalizeAuthorName(a.name), a]));

  for (const inAuthor of incoming) {
    const key = normalizeAuthorName(inAuthor.name);
    const match = byName.get(key);

    if (match) {
      if (isHumanSet(match.role_set_by)) continue; // never touch — full stop

      // 'manual' already means "passed a COMMS review gate" everywhere else
      // in this codebase (§8c Tab 1 approvals) — a human-verified backfill
      // reconcile (§13.24) is that same shape of trust, so it may set ANY
      // role, not just chps_faculty (that's the whole point: student status
      // has no machine-readable source and must come from a human, §8b).
      // Every other source keeps the narrower upgrade below — ingest must
      // never assign a student role on its own (§15.4).
      if (match.role === "unknown" && incomingSource === "manual") {
        match.role = inAuthor.role;
        match.faculty_id = inAuthor.faculty_id;
        match.role_set_by = inAuthor.role_set_by;
        match.role_set_at = inAuthor.role_set_at;
      } else if (match.role === "unknown" && inAuthor.role === "chps_faculty") {
        // Only ever upgrade unknown -> chps_faculty. Ingest never assigns
        // grad_student/undergrad_student/external, so that's the only
        // upgrade machine data can offer, and a known role never downgrades.
        match.role = "chps_faculty";
        match.faculty_id = inAuthor.faculty_id;
        match.role_set_by = inAuthor.role_set_by;
        match.role_set_at = inAuthor.role_set_at;
      } else if (match.faculty_id === null && inAuthor.faculty_id !== null) {
        match.faculty_id = inAuthor.faculty_id;
      }
      continue;
    }

    // A genuinely new author. Scholar alerts never carry real author data
    // (§5a) — never let a Scholar-sourced incoming list add or restructure
    // authors (§5, §15.7 applied to author lists, not just field metadata).
    if (incomingSource === "scholar") continue;

    // §13 item 10: `inAuthor.position` is only meaningful within its OWN
    // source's author list — different sources format the same name
    // differently often enough (fuller/sparser initials) that a real name
    // can fail the match above and arrive here as "new" even though someone
    // already occupies that same list-index in `merged`. Assign the next
    // free slot instead of trusting the incoming index verbatim, or this
    // collides with publication_authors' UNIQUE(publication_id, position)
    // constraint on insert. Newly-appended authors still land in their
    // relative incoming order, since incoming is iterated in order and each
    // one lands at the current end of merged.
    const newAuthor: MergedAuthor = { ...inAuthor, id: null, position: merged.length };
    merged.push(newAuthor);
    byName.set(key, newAuthor);
  }

  return merged;
}

export interface PublicationMetadata {
  doi: string | null;
  title: string;
  url: string;
  journal: string | null;
  year: number | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
}

export interface MergeableExisting extends PublicationMetadata {
  source: PublicationSource;
}

const SOURCE_PRIORITY: Record<PublicationSource, number> = {
  orcid: 4,
  crossref: 3,
  pubmed: 2,
  manual: 2, // not ranked in §5 (which only ranks the 3 automated layers + Scholar);
  // treated as PubMed-equal since manual entries already pass a COMMS review gate (§8c).
  scholar: 1,
};

const METADATA_FIELDS = ["doi", "title", "url", "journal", "year", "volume", "issue", "pages"] as const;

function isEmpty(value: string | number | null): boolean {
  return value === null || value === "";
}

// Field-by-field upgrade using §5's layer priority. A field is only
// overwritten by an equal-or-higher-priority source, or if it was empty.
// Scholar never overwrites anything — it is discovery, not resolution
// (§5, §15.7). title_normalized is derived, never independently merged
// (§15.9) — it always reflects the winning title.
export function mergeMetadata(
  existing: MergeableExisting,
  incoming: PublicationMetadata,
  incomingSource: PublicationSource
): PublicationMetadata & { title_normalized: string } {
  if (incomingSource === "scholar") {
    return { ...toMetadata(existing), title_normalized: normalizeTitle(existing.title) };
  }

  const incomingWins = SOURCE_PRIORITY[incomingSource] >= SOURCE_PRIORITY[existing.source];
  const merged = toMetadata(existing);

  for (const field of METADATA_FIELDS) {
    const existingValue = existing[field];
    const incomingValue = incoming[field];
    if (isEmpty(existingValue)) {
      if (!isEmpty(incomingValue)) merged[field] = incomingValue as never;
    } else if (incomingWins && !isEmpty(incomingValue)) {
      merged[field] = incomingValue as never;
    }
  }

  return { ...merged, title_normalized: normalizeTitle(merged.title) };
}

function toMetadata(m: PublicationMetadata): PublicationMetadata {
  const { doi, title, url, journal, year, volume, issue, pages } = m;
  return { doi, title, url, journal, year, volume, issue, pages };
}

export interface NeedsMetadataPromotion {
  status: PublicationStatus;
  // True only when this call actually promoted needs_metadata -> pending_merge
  // just now. The caller must reset first_seen_at to "now" when this is true
  // (§7): the original stub's first_seen_at can be arbitrarily stale (it was
  // stamped when the Scholar alert first created the stub, possibly weeks
  // before a resolution ever arrived), and leaving it untouched lets the
  // promoted record skip the merge buffer outright — release-buffer sees it
  // as already far past MERGE_BUFFER_HOURS and releases it on its very next
  // run, right when a second source (another co-author's alert, another
  // day's ingest-crossref sweep) is most likely to still be converging on
  // it. A fresh first_seen_at gives it the same full buffer window a brand
  // new insert gets.
  promoted: boolean;
}

// §15.11: a needs_metadata stub that later gets a real, DOI-backed
// resolution — from ANY source, not just the one that created the stub —
// must not stay stuck outside the merge-buffer -> roundup pipeline with
// nothing ever flagging it. Only promotes FROM needs_metadata, and only when
// the merge actually produced a DOI. Never touches pending_merge or
// published — a published record is permanently settled (§6b). One shared
// rule for every caller of mergeMetadata, not a copy per ingestion source.
export function promoteFromNeedsMetadata(existingStatus: PublicationStatus, mergedDoi: string | null): NeedsMetadataPromotion {
  const promoted = existingStatus === "needs_metadata" && mergedDoi !== null;
  return { status: promoted ? "pending_merge" : existingStatus, promoted };
}
