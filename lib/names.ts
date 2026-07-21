// Pure name-normalization functions. No I/O — see §5a.3 and §13 (Phase 2, item 4)
// of the master plan, and docs/wp-directory-notes.md §6 for the dirty-data ground
// truth these are built against.

function normalizeApostrophes(value: string): string {
  return value.replace(/[‘’]/g, "'");
}

// "Xiaochuan (Sharon)" -> "Xiaochuan"; also strips "quoted" nicknames.
function stripNicknames(value: string): string {
  return value
    .replace(/\([^)]*\)/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A bare initial: a single letter with an optional trailing period ("J.", "L").
function isInitial(word: string): boolean {
  return /^[A-Za-z]\.?$/.test(word);
}

const PARTICLES = new Set([
  "van", "de", "von", "der", "la", "le", "du", "dos", "das", "di", "del", "bin",
]);

function hasParticle(value: string): boolean {
  return value.split(/\s+/).some((w) => PARTICLES.has(w));
}

function hasSuffix(value: string): boolean {
  return value.split(/\s+/).some((w) => /^(Jr\.?|Sr\.?|II|III|IV)$/i.test(w));
}

// Reduces the directory's dirty First Name field to a single leading forename,
// for exact-match external API lookups (ORCID, Crossref). See §13, item 4.
export function normalizeGivenName(given: string): string {
  const trimmed = given.trim();
  if (!trimmed) return trimmed;

  const cleaned = stripNicknames(normalizeApostrophes(trimmed));
  const words = cleaned.split(/\s+/).filter(Boolean);
  const fullWords = words.filter((w) => !isInitial(w));

  // Stripping left nothing (e.g. the field was just a bare initial, or entirely
  // a parenthetical) — never return empty. Return the original input instead.
  if (fullWords.length === 0) return trimmed;

  return fullWords[0];
}

export interface CitationNameResult {
  name: string;
  confident: boolean;
}

// Builds the roundup's citation form ("Zraick, R.I.") from the directory's raw
// given/family fields. Flags ambiguous input instead of guessing — a wrong
// citation name is a visible public error; an unconfident one is a five-second
// human fix. See the "Dawson Loughran case" in docs/wp-directory-notes.md §6.
export function toCitationName(given: string, family: string): CitationNameResult {
  const cleanedFamily = normalizeApostrophes(family.trim());
  const cleanedGiven = stripNicknames(normalizeApostrophes(given.trim()));
  const words = cleanedGiven.split(/\s+/).filter(Boolean);
  const fullWordCount = words.filter((w) => !isInitial(w)).length;

  const initials = words.map((w) => `${w[0]?.toUpperCase() ?? ""}.`).join("");
  const name = `${cleanedFamily}, ${initials}`;

  // Ambiguous when: the given name has more than one non-initial word left
  // (can't tell if it's a middle name to drop, or a surname fragment misfiled
  // in the wrong directory column — see the Dawson Loughran case), or either
  // field carries a hyphen, a naming particle, or a generational suffix.
  const ambiguous =
    fullWordCount >= 2 ||
    cleanedFamily.includes("-") ||
    hasParticle(cleanedFamily) ||
    hasSuffix(cleanedFamily) ||
    hasParticle(cleanedGiven) ||
    hasSuffix(cleanedGiven);

  return { name, confident: !ambiguous };
}

// Roster citation form ("Family, G.I.") -> PubMed esearch query form
// ("Family GI") — §13 item 10. Inverse of fromPubmedAuthorName below.
export function toPubmedQueryName(citationName: string): string {
  const idx = citationName.indexOf(",");
  if (idx === -1) return citationName.trim();
  const family = citationName.slice(0, idx).trim();
  const initials = citationName.slice(idx + 1).replace(/\./g, "").replace(/\s+/g, "");
  return initials ? `${family} ${initials}` : family;
}

const SUFFIX_TOKEN = /^(Jr\.?|Sr\.?|II|III|IV)$/i;
// Letters (incl. accented), straight/curly apostrophe, hyphen, one optional
// trailing period — anything else (digits, "&", "#", ";", ...) means this
// token isn't a clean name piece. Catches raw HTML entities in a corrupted
// full_name (confirmed real case: "Eunkyung &#8220;Muriel&#8221; Lee")
// without attempting to decode them — that normalization belongs upstream.
const CLEAN_NAME_TOKEN = /^[\p{L}'’-]+\.?$/u;

export interface ParsedPubmedQueryName {
  queryName: string;
  surname: string;
  initials: string;
}

// full_name is given-name-first (e.g. "Matt S. Stock", from title.rendered —
// see docs/wp-directory-notes.md §2) — a richer source than display_name's
// citation-form initials, which can omit a middle initial the person
// actually publishes under (confirmed real case: Stock's display_name is
// "Stock, M." but he publishes as "Stock MS" — §13 item 10 bug fix).
//
// ★ knownSurname (from display_name's already-correct citation form, e.g.
// "Abarca Sasser, D." -> "Abarca Sasser") anchors where the surname starts,
// rather than guessing from full_name's shape alone. Confirmed live via
// scripts/audit-fullname-coverage.ts: a shape-only guess is wrong for real
// compound surnames with no lowercase particle ("Abarca Sasser", "Schwen
// Blackett", "Lopez Castillo" — the same people docs/wp-directory-notes.md
// §6 already flags as ambiguous for toCitationName) — "Diana Abarca Sasser"
// naively guesses surname "Sasser", dropping "Abarca" entirely. The
// directory's Last Name field already resolves this; reuse it instead of
// re-guessing from a different, genuinely ambiguous shape.
//
// Returns null, never throws, when full_name doesn't look like a clean name,
// or when knownSurname's tokens don't match the tail of full_name at all
// (e.g. a maiden-name/married-name mismatch between the two fields) — a
// fallback signal for the caller, not an error.
export function parseFullNameForPubmedQuery(fullName: string, knownSurname: string): ParsedPubmedQueryName | null {
  const tokens = fullName.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || !tokens.every((t) => CLEAN_NAME_TOKEN.test(t))) return null;

  const surnameTokens = knownSurname.trim().split(/\s+/).filter(Boolean);
  if (surnameTokens.length === 0) return null;

  const withoutSuffix = SUFFIX_TOKEN.test(tokens[tokens.length - 1]) ? tokens.slice(0, -1) : tokens;
  if (withoutSuffix.length <= surnameTokens.length) return null;

  const tail = withoutSuffix.slice(withoutSuffix.length - surnameTokens.length);
  const tailMatches = tail.every((t, i) => t.toLowerCase() === surnameTokens[i].toLowerCase());
  if (!tailMatches) return null;

  const givenTokens = withoutSuffix.slice(0, withoutSuffix.length - surnameTokens.length);
  if (givenTokens.length === 0) return null;

  const surname = tail.join(" ");
  const initials = givenTokens.map((t) => t[0].toUpperCase()).join("");

  return { queryName: `${surname} ${initials}`, surname, initials };
}

// PubMed's author form ("Stock MS", "van Loon LJC") -> roster citation form
// ("Stock, M.S.") — §13 item 10. Everywhere else in the system stores and
// renders citation form; this is the one source that doesn't already supply
// it. The initials are always the final whitespace-separated token.
export function fromPubmedAuthorName(pubmedName: string): string {
  const trimmed = pubmedName.trim();
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace === -1) return trimmed;

  const family = trimmed.slice(0, lastSpace);
  const initialsRaw = trimmed.slice(lastSpace + 1);
  if (!/^[A-Za-z]+$/.test(initialsRaw)) return trimmed; // not the expected shape — fail closed

  const initials = initialsRaw
    .split("")
    .map((c) => `${c.toUpperCase()}.`)
    .join("");
  return `${family}, ${initials}`;
}
