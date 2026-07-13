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
