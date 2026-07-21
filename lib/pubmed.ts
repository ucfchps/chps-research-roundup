// PubMed (NCBI E-utilities) resolver — §5 Layer 3, §13 item 10. Unlike
// Scholar/no-DOI ORCID, a PubMed record normally carries complete,
// untruncated metadata (full author list, DOI, full journal name) — it goes
// directly into match/merge, no Crossref round-trip needed. Deterministic.
// No AI, no DB.
import { fetchWithRetry } from "./http";
import { fromPubmedAuthorName, parseFullNameForPubmedQuery, toPubmedQueryName } from "./names";

const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
// NCBI's esearch defaults retmax to 20 — confirmed live against a real CHPS
// faculty member's author search (140 total hits, only 20 returned without
// this). Generous and harmless to overshoot: the merge engine is idempotent,
// same reasoning as ingest-crossref's own generous lookback window.
const ESEARCH_RETMAX = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A real, per-process rate limiter (elapsed-time-based, not a flat sleep per
// call) — NCBI allows 3 req/sec without a key, 10/sec with one. Module-level
// state so it throttles across every call this process makes, not just
// within one function.
let lastRequestAt = 0;

async function rateLimit(): Promise<void> {
  const rps = process.env.NCBI_API_KEY ? 10 : 3;
  const minIntervalMs = 1000 / rps;
  const wait = minIntervalMs - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

function eutilsParams(): string {
  const params = new URLSearchParams({ retmode: "json" });
  if (process.env.NCBI_TOOL_NAME) params.set("tool", process.env.NCBI_TOOL_NAME);
  if (process.env.NCBI_EMAIL) params.set("email", process.env.NCBI_EMAIL);
  if (process.env.NCBI_API_KEY) params.set("api_key", process.env.NCBI_API_KEY);
  return params.toString();
}

export class PubmedUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PubmedUnavailableError";
  }
}

// Extracts just the year — real confirmed formats include "2026 Jul 2" and
// "2026 May 17"; the schema only needs the year, so no full date parsing.
// Never throws; returns null on anything unrecognized.
export function parsePubmedYear(pubdate: string): number | null {
  const match = pubdate.match(/(\d{4})/);
  return match ? Number(match[1]) : null;
}

// PubMed's esearch is Boolean field-matching, not relevance-ranked like
// Crossref's query.affiliation (lib/crossref.ts, searchByAuthor) — there is
// no way to AND affiliation into the term without it becoming a hard
// exclusion filter. Per §5/§11's "affiliation is a tiebreaker, never a
// requirement": a UCF faculty member's paper carrying a different
// institution's affiliation string (visiting scholar, prior job, multi-site
// study) must not be silently dropped. So the query searches by author only;
// affiliationHint is accepted for signature parity with searchByAuthor and
// left for a future non-exclusionary use (e.g. a confirmation flag), never
// folded into the boolean term.
//
// facultyName accepts either citation form ("Zraick, R.I.", converted here
// via toPubmedQueryName) or an already-built query name from
// buildPubmedAuthorQuery (e.g. "Stock MS") — toPubmedQueryName is a no-op
// passthrough on any comma-less string, so a pre-built query name survives
// unchanged.
export async function searchPubmedByAuthor(facultyName: string, _affiliationHint: string): Promise<string[]> {
  const term = `${toPubmedQueryName(facultyName)}[Author]`;
  const url = `${EUTILS_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmax=${ESEARCH_RETMAX}&${eutilsParams()}`;

  await rateLimit();
  let res: Response;
  try {
    res = await fetchWithRetry(url);
  } catch (err) {
    throw new PubmedUnavailableError("PubMed esearch request failed after exhausting retries", { cause: err });
  }
  if (!res.ok) throw new PubmedUnavailableError(`PubMed esearch returned ${res.status}`);

  const json = (await res.json()) as { esearchresult?: { idlist?: string[]; count?: string } };
  const idlist = json.esearchresult?.idlist ?? [];

  // §13 item 10: `count` is NCBI's TRUE total match count, already in the
  // response — no new API call. A big gap between it and what we actually
  // got back (capped at ESEARCH_RETMAX) is itself a signal the query is too
  // broad/collision-prone, independent of whether buildPubmedAuthorQuery's
  // full_name fix resolves it for this particular name. Visibility only;
  // never changes what's returned.
  const trueCount = json.esearchresult?.count ? Number(json.esearchresult.count) : null;
  if (trueCount !== null && idlist.length > 0 && trueCount > idlist.length * 2) {
    console.warn(`[pubmed-query-too-broad] "${term}" matched ${trueCount} total, only ${idlist.length} returned (retmax=${ESEARCH_RETMAX}) — query may be over-broad`);
  }

  return idlist;
}

export interface PubmedAuthorQuery {
  queryName: string;
  source: "full_name" | "display_name_fallback";
}

// §13 item 10 bug fix: full_name (given-name-first, e.g. "Matt S. Stock") is
// a richer source than display_name's citation-form initials, which can
// omit a middle initial the person actually publishes under — confirmed
// live: display_name "Stock, M." queried 970 hits vs. the correct 140 for
// "Stock MS". Prefer full_name; fall back to display_name only when
// full_name is missing or doesn't parse. The fallback is the exact
// sparse-name scenario that caused the bug, so it must be visible, not
// silent — callers should log a warning naming the faculty member whenever
// source is 'display_name_fallback', so a human can verify/backfill
// full_name for that person.
export function buildPubmedAuthorQuery(faculty: { display_name: string; full_name: string | null }): PubmedAuthorQuery {
  // display_name is citation form "Family, G.I." (§6) — the part before the
  // comma is the already-correct surname, same convention
  // scripts/ingest-crossref.ts uses to build its own Crossref surnameHint.
  const knownSurname = faculty.display_name.split(",")[0]?.trim() ?? "";
  const parsed = faculty.full_name && knownSurname ? parseFullNameForPubmedQuery(faculty.full_name, knownSurname) : null;
  if (parsed) return { queryName: parsed.queryName, source: "full_name" };
  return { queryName: toPubmedQueryName(faculty.display_name), source: "display_name_fallback" };
}

export interface PubmedRecordAuthor {
  name: string;
  position: number;
}

export interface PubmedRecord {
  pmid: string;
  doi: string | null;
  title: string;
  url: string;
  year: number | null;
  journal: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  authors: PubmedRecordAuthor[];
}

interface EsummaryArticleId {
  idtype?: string;
  value?: string;
}

interface EsummaryAuthor {
  name?: string;
}

interface EsummaryDocsum {
  uid?: string;
  pubdate?: string;
  fulljournalname?: string;
  title?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  authors?: EsummaryAuthor[];
  articleids?: EsummaryArticleId[];
}

// "" (ahead-of-print records, or article-number-style journals) is absent,
// not a real value — must not block a later, higher-priority source from
// filling it in via mergeMetadata's isEmpty check (lib/matching.ts).
function absentIfBlank(value: string | undefined): string | null {
  return value ? value : null;
}

function mapDocsum(uid: string, doc: EsummaryDocsum): PubmedRecord | null {
  if (!doc.title) return null;

  const authors: PubmedRecordAuthor[] = (doc.authors ?? [])
    .filter((a): a is { name: string } => Boolean(a.name))
    .map((a, position) => ({ name: fromPubmedAuthorName(a.name), position }));

  const doi = doc.articleids?.find((a) => a.idtype === "doi")?.value ?? null;

  return {
    pmid: uid,
    doi,
    title: doc.title,
    // publications.url is NOT NULL — esummary carries no separate "url"
    // field the way ORCID's work-summary does, so build one: the DOI
    // resolver link when a DOI exists (matches every other source's url
    // convention), else PubMed's own article page.
    url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
    year: doc.pubdate ? parsePubmedYear(doc.pubdate) : null,
    journal: doc.fulljournalname ?? null,
    volume: absentIfBlank(doc.volume),
    issue: absentIfBlank(doc.issue),
    pages: absentIfBlank(doc.pages),
    authors,
  };
}

// Batches every pmid into a single esummary call (comma-joined) — NCBI
// supports this; one request per pmid would blow through the rate limit on
// any faculty member with more than a couple of hits.
export async function getPubmedRecords(pmids: string[]): Promise<PubmedRecord[]> {
  if (pmids.length === 0) return [];

  const url = `${EUTILS_BASE}/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmids.join(","))}&${eutilsParams()}`;

  await rateLimit();
  let res: Response;
  try {
    res = await fetchWithRetry(url);
  } catch (err) {
    throw new PubmedUnavailableError("PubMed esummary request failed after exhausting retries", { cause: err });
  }
  if (!res.ok) throw new PubmedUnavailableError(`PubMed esummary returned ${res.status}`);

  const json = (await res.json()) as { result?: { uids?: string[] } & Record<string, EsummaryDocsum> };
  const uids = json.result?.uids ?? [];

  const records: PubmedRecord[] = [];
  for (const uid of uids) {
    const doc = json.result?.[uid];
    if (!doc) continue;
    const record = mapDocsum(uid, doc);
    if (record) records.push(record);
  }
  return records;
}
