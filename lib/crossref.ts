// Crossref resolver — turns a Scholar discovery (title, year, faculty surname)
// into full citation metadata (§5a rule 7). See master plan §5 (Layer 2 and
// layer priority), §5a rules 6-8, §7 (matching), §13 item 7, §15.2/§15.7/§15.8.
//
// Deterministic. No AI, no DB, no roles/faculty_id — those are roster-matching
// concerns for the merge engine (§7), not resolution.
import { fetchWithRetry } from "./http";
import { normalizeDoi, normalizeTitle } from "./matching";
import type { CrossrefResolution, CrossrefResolutionAuthor } from "./types";

const envMailto = process.env.CROSSREF_MAILTO;
if (!envMailto) {
  throw new Error("CROSSREF_MAILTO must be set (see .env.example) — required for Crossref's polite pool");
}
// Re-bound to a definitely-string const: TS narrowing from the throw above
// doesn't carry into the functions below, which close over this module scope.
const CROSSREF_MAILTO: string = envMailto;

const USER_AGENT = `chps-research-roundup/1.0 (mailto:${CROSSREF_MAILTO})`;
const CROSSREF_BASE = "https://api.crossref.org";
const SEARCH_ROWS = 5;
const PREPRINT_TYPE = "posted-content";

export class CrossrefUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CrossrefUnavailableError";
  }
}

interface CrossrefApiAuthor {
  given?: string;
  family?: string;
  name?: string;
  affiliation?: { name: string }[];
}

interface CrossrefApiItem {
  DOI: string;
  title?: string[];
  author?: CrossrefApiAuthor[];
  "container-title"?: string[] | null;
  "short-container-title"?: string[] | null;
  issued?: { "date-parts"?: (number | null)[][] } | null;
  "published-print"?: { "date-parts"?: (number | null)[][] } | null;
  "published-online"?: { "date-parts"?: (number | null)[][] } | null;
  page?: string | null;
  volume?: string | null;
  issue?: string | null;
  type?: string;
}

async function crossrefFetch(url: string): Promise<Response> {
  try {
    return await fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT } });
  } catch (err) {
    throw new CrossrefUnavailableError("Crossref request failed after exhausting retries", { cause: err });
  }
}

// A single letter followed by a period, e.g. "S." or already-compressed
// "C.S." — Crossref sometimes gives these pre-joined with no space.
function isCompressedInitials(token: string): boolean {
  return /^([A-Za-z]\.)+$/.test(token);
}

function tokenInitials(token: string): string {
  if (isCompressedInitials(token)) return token;
  if (token.includes("-")) {
    return token
      .split("-")
      .map((part) => `${part[0] ?? ""}.`)
      .join("-");
  }
  return `${token[0] ?? ""}.`;
}

function initialsFromGiven(given: string): string {
  return given
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(tokenInitials)
    .join("");
}

// Citation form is "Family, G.I." — see master plan §5a rule 7 table / Session
// 6 prompt point 5. Family names (incl. lowercase particles like "van Loon")
// are passed through verbatim — never touched, never capitalized.
export function formatCrossrefAuthorName(author: {
  given?: string | null;
  family?: string | null;
  name?: string | null;
}): string | null {
  if (author.family) {
    const initials = author.given ? initialsFromGiven(author.given) : "";
    return initials ? `${author.family}, ${initials}` : author.family;
  }
  if (author.name) return author.name;
  return null;
}

function buildAuthors(item: CrossrefApiItem): CrossrefResolutionAuthor[] {
  if (!item.author) return [];
  const result: CrossrefResolutionAuthor[] = [];
  for (const a of item.author) {
    const name = formatCrossrefAuthorName(a);
    if (name === null) continue;
    const affiliation = a.affiliation?.[0]?.name;
    result.push({ name, position: result.length, ...(affiliation ? { affiliation } : {}) });
  }
  return result;
}

function yearFromDateParts(dp?: { "date-parts"?: (number | null)[][] } | null): number | null {
  const year = dp?.["date-parts"]?.[0]?.[0];
  return typeof year === "number" ? year : null;
}

function extractYear(item: CrossrefApiItem): number | null {
  return yearFromDateParts(item.issued) ?? yearFromDateParts(item["published-print"]) ?? yearFromDateParts(item["published-online"]);
}

function extractJournal(item: CrossrefApiItem): string | null {
  return item["container-title"]?.[0] ?? item["short-container-title"]?.[0] ?? null;
}

// Maps a raw Crossref work to our shape. Returns null when the record is
// unusable (no title at all) — every field below is a real edge case seen in
// the fixtures (see Session 6 prompt point 4).
function mapItem(item: CrossrefApiItem): CrossrefResolution | null {
  const title = item.title?.[0];
  if (!title) return null;

  const doi = normalizeDoi(item.DOI) ?? item.DOI.toLowerCase();

  return {
    doi,
    title,
    url: `https://doi.org/${doi}`,
    journal: extractJournal(item),
    year: extractYear(item),
    volume: item.volume ?? null,
    issue: item.issue ?? null,
    pages: item.page ?? null,
    type: item.type ?? "other",
    authors: buildAuthors(item),
  };
}

function normalizeForCompare(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritic combining marks
    .toLowerCase();
}

// §5a rule 7 / Session 6 prompt point 2: a candidate with no author list at
// all fails this check — that's a rejection, not a pass. An empty array is
// treated the same way (there is simply no surname to find).
function authorListHasSurname(item: CrossrefApiItem, surnameHint: string): boolean {
  if (!item.author || item.author.length === 0) return false;
  const target = normalizeForCompare(surnameHint);
  return item.author.some((a) => normalizeForCompare(a.family ?? a.name ?? "").includes(target));
}

function passesAcceptanceGate(
  item: CrossrefApiItem,
  resolution: CrossrefResolution,
  normalizedQueryTitle: string,
  year: number | undefined,
  surnameHint: string | undefined
): boolean {
  if (normalizeTitle(resolution.title) !== normalizedQueryTitle) return false;
  if (year !== undefined && (resolution.year === null || Math.abs(resolution.year - year) > 1)) return false;
  if (surnameHint && !authorListHasSurname(item, surnameHint)) return false;
  return true;
}

function hasUcfAffiliation(item: CrossrefApiItem): boolean {
  return item.author?.some((a) => a.affiliation?.some((aff) => /university of central florida/i.test(aff.name))) ?? false;
}

function authorSurnames(item: CrossrefApiItem): string[] {
  if (!item.author) return [];
  return item.author.map((a) => normalizeForCompare(a.family ?? a.name ?? ""));
}

function sameAuthorOrder(a: CrossrefApiItem, b: CrossrefApiItem): boolean {
  const sa = authorSurnames(a);
  const sb = authorSurnames(b);
  if (sa.length === 0 || sb.length === 0 || sa.length !== sb.length) return false;
  return sa.every((surname, i) => surname === sb[i]);
}

// ★ §5 (amended) / Session 6 prompt point 2b: a preprint's title is often the
// exact original wording, while a journal edits the title during peer review —
// so a posted-content candidate can clear the exact-title gate while its own,
// later, fully-populated journal-article record fails it. Runs only AFTER
// gate evaluation: it re-ranks among candidates sharing the accepted
// preprint's author order, never loosening the gate itself.
function preferPublishedOverPreprint(chosenItem: CrossrefApiItem, allItems: CrossrefApiItem[]): CrossrefResolution | null {
  const superseding = allItems.find(
    (other) => other.DOI !== chosenItem.DOI && (other.type ?? "other") !== PREPRINT_TYPE && sameAuthorOrder(chosenItem, other)
  );
  return superseding ? mapItem(superseding) : null;
}

export async function resolveByTitle(
  title: string,
  year?: number,
  surnameHint?: string
): Promise<CrossrefResolution | null> {
  const url = `${CROSSREF_BASE}/works?query.bibliographic=${encodeURIComponent(title)}&rows=${SEARCH_ROWS}&mailto=${encodeURIComponent(CROSSREF_MAILTO)}`;
  const res = await crossrefFetch(url);
  if (!res.ok) throw new CrossrefUnavailableError(`Crossref search returned ${res.status}`);

  const json = (await res.json()) as { message?: { items?: CrossrefApiItem[] } };
  const items = json.message?.items ?? [];
  const normalizedQueryTitle = normalizeTitle(title);

  const candidates: { item: CrossrefApiItem; resolution: CrossrefResolution }[] = [];
  for (const item of items) {
    const resolution = mapItem(item);
    if (!resolution) continue;
    if (!passesAcceptanceGate(item, resolution, normalizedQueryTitle, year, surnameHint)) continue;
    candidates.push({ item, resolution });
  }

  if (candidates.length === 0) return null;

  // Affiliation is a tiebreaker only — never required, never a rejection
  // reason on its own (§5, as amended).
  const chosen = candidates.find((c) => hasUcfAffiliation(c.item)) ?? candidates[0];

  if (chosen.resolution.type === PREPRINT_TYPE) {
    const superseding = preferPublishedOverPreprint(chosen.item, items);
    if (superseding) return superseding;
  }

  return chosen.resolution;
}

// A DOI is an exact identifier, not a search — no acceptance gate needed.
export async function resolveByDoi(doi: string): Promise<CrossrefResolution | null> {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;

  const url = `${CROSSREF_BASE}/works/${encodeURIComponent(normalized)}?mailto=${encodeURIComponent(CROSSREF_MAILTO)}`;
  const res = await crossrefFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new CrossrefUnavailableError(`Crossref DOI lookup returned ${res.status}`);

  const json = (await res.json()) as { message?: CrossrefApiItem };
  if (!json.message) return null;
  return mapItem(json.message);
}
