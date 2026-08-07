// PubMed (NCBI E-utilities) resolver — §5 Layer 3, §13 item 10. Unlike
// Scholar/no-DOI ORCID, a PubMed record normally carries complete,
// untruncated metadata (full author list, DOI, full journal name) — it goes
// directly into match/merge, no Crossref round-trip needed. Deterministic.
// No AI, no DB.
import { fetchWithRetry, type FetchAttemptInfo } from "./http";
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

// docs/phase5-findings.md (Session 13): "successful after silent retries"
// vs "successful first try" was indistinguishable from the outside — this
// job needed ongoing visibility into where its own wall-clock actually
// goes, not a one-off diagnostic script. Four buckets, matched to the four
// candidate causes a slowdown here can have:
//   - rateLimitWaitMs: our OWN deliberate self-throttle (rateLimit() below)
//   - backoffMs: time slept between fetchWithRetry attempts (i.e. NCBI
//     rejected or timed out and we're waiting before retrying)
//   - fetchMs: each attempt's own wall-clock duration, timeout or not —
//     high fetchMs with LOW attempt counts means NCBI is genuinely slow;
//     high attempt counts with LOW per-attempt fetchMs means fast
//     rejections (429s) are the driver
//   - statusCounts: the actual status codes (or "error:<message>" for a
//     thrown/timeout attempt) seen — this is what actually distinguishes a
//     429 from a silent timeout-and-retry, which every prior run's summary
//     collapsed into the same "no errors" outcome
export type PubmedCallType = "esearch" | "esummary" | "efetch";

interface CallTypeDiagnostics {
  requests: number; // top-level fetchWithRetry calls
  attempts: number; // total attempts across those calls — attempts > requests means at least one retry happened
  fetchMs: number; // sum of every attempt's own duration (genuine latency, including one that timed out)
  backoffMs: number; // sum of time slept between attempts, waiting to retry
  rateLimitWaitMs: number; // sum of time slept in our own self-throttle before a request was even sent
  statusCounts: Record<string, number>;
}

function emptyCallTypeDiagnostics(): CallTypeDiagnostics {
  return { requests: 0, attempts: 0, fetchMs: 0, backoffMs: 0, rateLimitWaitMs: 0, statusCounts: {} };
}

function emptyDiagnostics(): Record<PubmedCallType, CallTypeDiagnostics> {
  return { esearch: emptyCallTypeDiagnostics(), esummary: emptyCallTypeDiagnostics(), efetch: emptyCallTypeDiagnostics() };
}

let diagnostics: Record<PubmedCallType, CallTypeDiagnostics> = emptyDiagnostics();

// Callers reset this once per unit of work they want a timing breakdown
// for (scripts/ingest-pubmed-orcid.ts resets it once per faculty member, so
// a per-person distribution — not just a run-wide total — is directly
// observable from the log).
export function resetPubmedDiagnostics(): void {
  diagnostics = emptyDiagnostics();
}

export function getPubmedDiagnostics(): Record<PubmedCallType, CallTypeDiagnostics> {
  return diagnostics;
}

// One line, safe to log unconditionally (never PII, never a secret) —
// mirrors this file's existing [pubmed-query-too-broad]/[pubmed-affiliation]
// bracket-tag convention.
export function formatPubmedDiagnostics(d: Record<PubmedCallType, CallTypeDiagnostics> = diagnostics): string {
  const parts = (["esearch", "esummary", "efetch"] as const)
    .filter((t) => d[t].requests > 0)
    .map((t) => {
      const c = d[t];
      const retries = c.attempts - c.requests;
      const statuses = Object.entries(c.statusCounts)
        .map(([k, v]) => `${k}×${v}`)
        .join(",");
      return `${t}: ${c.requests} req/${c.attempts} attempt(s)${retries > 0 ? ` (${retries} retried)` : ""}, fetch=${c.fetchMs}ms, backoff=${c.backoffMs}ms, rateLimitWait=${c.rateLimitWaitMs}ms [${statuses}]`;
    });
  return parts.join(" · ");
}

function recordAttempt(callType: PubmedCallType, info: FetchAttemptInfo): void {
  const d = diagnostics[callType];
  d.attempts++;
  d.fetchMs += info.attemptMs;
  d.backoffMs += info.backoffMs;
  const key = info.status !== null ? String(info.status) : `error:${info.errorMessage ?? "unknown"}`;
  d.statusCounts[key] = (d.statusCounts[key] ?? 0) + 1;
}

// A real, per-process rate limiter (elapsed-time-based, not a flat sleep per
// call) — NCBI allows 3 req/sec without a key, 10/sec with one. Module-level
// state so it throttles across every call this process makes, not just
// within one function.
let lastRequestAt = 0;

async function rateLimit(callType: PubmedCallType): Promise<void> {
  const rps = process.env.NCBI_API_KEY ? 10 : 3;
  const minIntervalMs = 1000 / rps;
  const wait = minIntervalMs - (Date.now() - lastRequestAt);
  if (wait > 0) {
    diagnostics[callType].rateLimitWaitMs += wait;
    await sleep(wait);
  }
  lastRequestAt = Date.now();
}

// retmode defaults to "json" (esearch/esummary, the pre-existing callers) —
// efetch needs "xml" instead (that's the only mode carrying per-author
// affiliation) and must override it here, not append a second retmode= to
// the URL: NCBI 500s on a duplicated query param (confirmed live).
function eutilsParams(retmode: "json" | "xml" = "json"): string {
  const params = new URLSearchParams({ retmode });
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

  await rateLimit("esearch");
  diagnostics.esearch.requests++;
  let res: Response;
  try {
    res = await fetchWithRetry(url, {}, { onAttempt: (info) => recordAttempt("esearch", info) });
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

// docs/phase5-findings.md #2 (Session 12): efetch's fuller XML is the only
// PubMed endpoint that carries per-author affiliation at all — esummary
// structurally doesn't (confirmed 0/4,027 real yield, Session 2). A narrow,
// purpose-built extraction, not a general XML parser: PubMed's own DTD for
// this shape is stable, and the real captured cases this must handle (see
// tests/fixtures/api/pubmed-efetch-*.xml, captured live 2026-08-07) are:
// affiliation present and UCF-matching; present but on a LATER author, not
// the first (a real Norte, CHPS-faculty paper — author 4 of 6); present and
// clearly non-UCF (real global name-collision papers); a single author with
// MULTIPLE <AffiliationInfo> blocks (dual-institution authors, real, not
// hypothetical); and absent on every author (a genuine PubMed coverage gap
// on pre-1990s records — confirmed on 3 real records, not a parsing
// failure to guard against). Never throws on unexpected input — anything
// this can't confidently extract just yields an empty affiliation list for
// that pmid, which classifyAffiliationPlausibility (lib/matching.ts)
// already treats as "ambiguous," never as "excluded."
function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export function extractAffiliationsFromXml(xml: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const articleRe = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let articleMatch: RegExpExecArray | null;
  while ((articleMatch = articleRe.exec(xml)) !== null) {
    const articleXml = articleMatch[1];
    const pmidMatch = /<PMID[^>]*>(\d+)<\/PMID>/.exec(articleXml);
    if (!pmidMatch) continue;

    const affiliations: string[] = [];
    const affiliationRe = /<Affiliation>([\s\S]*?)<\/Affiliation>/g;
    let affMatch: RegExpExecArray | null;
    while ((affMatch = affiliationRe.exec(articleXml)) !== null) {
      const decoded = decodeXmlEntities(affMatch[1]).trim();
      if (decoded) affiliations.push(decoded);
    }
    result.set(pmidMatch[1], affiliations);
  }
  return result;
}

// Batched exactly like getPubmedRecords (comma-joined pmids, one request) —
// callers should further narrow `pmids` to only candidates that survive a
// cheaper pre-filter first (Session 12 measured efetch's own per-request
// latency as comparable to esummary's, but its payload is 6-11x larger;
// fetching it for every PubMed record, not just genuinely new ones,
// measured as adding enough wall-clock to threaten the 25-minute ceiling —
// see docs/phase5-findings.md #2).
export async function getPubmedAffiliations(pmids: string[]): Promise<Map<string, string[]>> {
  if (pmids.length === 0) return new Map();

  const url = `${EUTILS_BASE}/efetch.fcgi?db=pubmed&id=${encodeURIComponent(pmids.join(","))}&rettype=abstract&${eutilsParams("xml")}`;

  await rateLimit("efetch");
  diagnostics.efetch.requests++;
  let res: Response;
  try {
    res = await fetchWithRetry(url, {}, { onAttempt: (info) => recordAttempt("efetch", info) });
  } catch (err) {
    throw new PubmedUnavailableError("PubMed efetch request failed after exhausting retries", { cause: err });
  }
  if (!res.ok) throw new PubmedUnavailableError(`PubMed efetch returned ${res.status}`);

  const xml = await res.text();
  return extractAffiliationsFromXml(xml);
}

// Batches every pmid into a single esummary call (comma-joined) — NCBI
// supports this; one request per pmid would blow through the rate limit on
// any faculty member with more than a couple of hits.
export async function getPubmedRecords(pmids: string[]): Promise<PubmedRecord[]> {
  if (pmids.length === 0) return [];

  const url = `${EUTILS_BASE}/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmids.join(","))}&${eutilsParams()}`;

  await rateLimit("esummary");
  diagnostics.esummary.requests++;
  let res: Response;
  try {
    res = await fetchWithRetry(url, {}, { onAttempt: (info) => recordAttempt("esummary", info) });
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
