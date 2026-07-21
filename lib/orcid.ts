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

// getOrcidWorks — §5 Layer 3, §13 item 10. Highest-trust discovery signal:
// an ORCID profile is author-verified. Crossref is still preferred for full
// citation metadata (see scripts/ingest-pubmed-orcid.ts's DOI-first
// resolution) — this module only fetches and parses the works list itself.
import { fetchWithRetry } from "./http";

export class OrcidUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OrcidUnavailableError";
  }
}

export interface OrcidWork {
  title: string;
  year: number;
  doi: string | null;
  journal: string | null;
  // publications.url is NOT NULL — carried through so a needs_metadata
  // stub (no DOI, title-fallback also failed) has somewhere to point.
  url: string;
}

const ORCID_BASE = "https://pub.orcid.org/v3.0";
const DEFAULT_LOOKBACK_YEARS = 3;

// ★ Confirmed real edge case (tests/fixtures/orcid/sample-works.json): ORCID's
// `type` is not a reliable roundup-worthiness classifier — a genuine,
// DOI-bearing, published journal article can be tagged "annotation" by its
// source. Denylist only the types that are unambiguously not articles; let
// Crossref/title resolution be the real gate, not ORCID's type field.
const TYPE_DENYLIST = new Set(["data-set", "software", "other"]);

interface OrcidExternalId {
  "external-id-type"?: string;
  "external-id-value"?: string;
}

interface OrcidWorkSummary {
  type?: string;
  title?: { title?: { value?: string | null } | null } | null;
  "publication-date"?: { year?: { value?: string | null } | null } | null;
  "journal-title"?: { value?: string | null } | null;
  url?: { value?: string | null } | null;
}

interface OrcidGroup {
  "external-ids"?: { "external-id"?: OrcidExternalId[] } | null;
  "work-summary"?: OrcidWorkSummary[] | null;
}

function extractDoi(group: OrcidGroup): string | null {
  const ids = group["external-ids"]?.["external-id"] ?? [];
  return ids.find((id) => id["external-id-type"] === "doi")?.["external-id-value"] ?? null;
}

export interface ParseOrcidGroupsResult {
  works: OrcidWork[];
  skippedOutOfWindow: number;
  skippedMissingYear: number;
  skippedMalformed: number;
}

// Pure. Iterates group[], NOT work-summary[] — a group's multiple
// work-summaries (one per asserting source, e.g. Crossref + the publisher
// itself) all describe the same DOI, so exactly one representative is taken
// per group regardless of how many work-summary entries it holds (real
// fixture case: Crossref + MDPI both assert 10.3390/jfmk11020200 in one
// group — this naturally dedupes since only one OrcidWork is ever produced
// per group).
export function parseOrcidGroups(groups: OrcidGroup[], opts: { lookbackYears: number; now: Date }): ParseOrcidGroupsResult {
  const cutoffYear = opts.now.getFullYear() - opts.lookbackYears + 1;
  const result: ParseOrcidGroupsResult = { works: [], skippedOutOfWindow: 0, skippedMissingYear: 0, skippedMalformed: 0 };

  for (const group of groups) {
    try {
      const summary = group["work-summary"]?.[0];
      const title = summary?.title?.title?.value;
      const url = summary?.url?.value;
      if (!summary || !title || !url) {
        result.skippedMalformed++;
        continue;
      }

      if (TYPE_DENYLIST.has(summary.type ?? "")) continue;

      const yearRaw = summary["publication-date"]?.year?.value;
      const year = yearRaw ? Number(yearRaw) : NaN;
      if (Number.isNaN(year)) {
        result.skippedMissingYear++;
        continue;
      }
      if (year < cutoffYear) {
        result.skippedOutOfWindow++;
        continue;
      }

      result.works.push({ title, year, url, doi: extractDoi(group), journal: summary["journal-title"]?.value ?? null });
    } catch {
      result.skippedMalformed++;
    }
  }

  return result;
}

function readLookbackYears(): number {
  const raw = process.env.ORCID_LOOKBACK_YEARS;
  const n = raw ? Number(raw) : NaN;
  return Number.isNaN(n) ? DEFAULT_LOOKBACK_YEARS : n;
}

export async function getOrcidWorks(id: string): Promise<OrcidWork[]> {
  const url = `${ORCID_BASE}/${encodeURIComponent(id)}/works`;

  let res: Response;
  try {
    res = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new OrcidUnavailableError("ORCID request failed after exhausting retries", { cause: err });
  }
  if (!res.ok) throw new OrcidUnavailableError(`ORCID works lookup returned ${res.status}`);

  const json = (await res.json()) as { group?: OrcidGroup[] };
  return parseOrcidGroups(json.group ?? [], { lookbackYears: readLookbackYears(), now: new Date() }).works;
}
