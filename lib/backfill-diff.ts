// Session 20 (§13.24) Task B: parse both the real generator's output and the
// real live post into the same normalized shape, then diff them. This file
// never formats a citation or derives a unit itself — lib/roundup-export.ts
// (which calls lib/citation.ts) already produced the "generated" HTML by the
// time anything here runs; this module only reads HTML back out again.
import * as cheerio from "cheerio";
import { UNITS, type Unit } from "./types";

// Unit boundaries are matched by the heading's own VISIBLE TEXT, never by
// anchor slug — the real live post's anchor ids ("card", "skrs",
// "socialwork", ...) are arbitrary historical WordPress slugs, while
// lib/roundup-export.ts's own slugify() produces a completely different,
// fuller scheme ("center-for-autism-and-related-disabilities", ...) for the
// exact same units. Matching on the unit NAME text works for both without
// either side needing to know the other's slug convention.
function unitFromHeadingText(text: string): Unit | undefined {
  const norm = text.trim().toLowerCase();
  return UNITS.find((u) => u.toLowerCase() === norm);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

const ENTITIES: Array<[string, string]> = [
  ["&amp;", "&"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&lt;", "<"],
  ["&gt;", ">"],
];

function unescapeHtml(s: string): string {
  let out = s;
  for (const [ent, rep] of ENTITIES) out = out.split(ent).join(rep);
  return out;
}

// Walks a raw HTML fragment character-by-character, tracking <b> nesting
// depth, and returns the plain (unescaped) text alongside a parallel
// bold-state array — proven against the real live post during fixture
// verification (Word-export HTML nests <span> inside <b> inconsistently,
// so a DOM-shape-agnostic character walk is more robust here than a
// selector-based approach).
function extractPlainWithBoldMask(fragmentHtml: string): { text: string; boldMask: boolean[] } {
  const rawChars: string[] = [];
  const rawBoldMask: boolean[] = [];
  let depth = 0;
  let i = 0;
  while (i < fragmentHtml.length) {
    if (fragmentHtml.startsWith("<b>", i)) {
      depth++;
      i += 3;
      continue;
    }
    if (fragmentHtml.startsWith("</b>", i)) {
      depth--;
      i += 4;
      continue;
    }
    const tagMatch = /^<[^>]+>/.exec(fragmentHtml.slice(i));
    if (tagMatch) {
      i += tagMatch[0].length;
      continue;
    }
    rawChars.push(fragmentHtml[i]);
    rawBoldMask.push(depth > 0);
    i++;
  }

  const outChars: string[] = [];
  const boldMask: boolean[] = [];
  const joined = rawChars.join("");
  let j = 0;
  while (j < joined.length) {
    let matched = false;
    for (const [ent, rep] of ENTITIES) {
      if (joined.startsWith(ent, j)) {
        outChars.push(rep);
        boldMask.push(rawBoldMask[j]);
        j += ent.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      outChars.push(joined[j]);
      boldMask.push(rawBoldMask[j]);
      j++;
    }
  }

  return { text: outChars.join(""), boldMask };
}

// Normalizes author-name punctuation for comparison purposes only (the
// documented axis: the post mixes "Surname, X.Y." and "Surname X.Y." —
// comma optional, internal spacing optional). Never used to decide what to
// seed or render — only to compare two already-rendered strings.
export function normalizeAuthorPunctuation(name: string): string {
  return name
    .replace(/§/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, "")
    .replace(/\.+/g, ".")
    .toLowerCase();
}

export type Marker = "" | "*" | "**";

export interface AuthorRenderState {
  name: string;
  found: boolean;
  bold: boolean;
  marker: Marker;
}

// Given the KNOWN list of author names for a publication (from the ground
// truth fixture — already hand-verified), locate each one inside a raw
// author-segment HTML fragment and read off its actual bold/marker state.
// This sidesteps needing a general-purpose name tokenizer for messy,
// inconsistently-punctuated real HTML: the fixture already tells us WHO
// should be there; here we only ask HOW they were rendered.
export function findAuthorRenderState(authorSegmentHtml: string, knownNames: string[]): AuthorRenderState[] {
  const { text, boldMask } = extractPlainWithBoldMask(authorSegmentHtml);
  return knownNames.map((name) => locateName(text, boldMask, name) ?? { name, found: false, bold: false, marker: "" });
}

// A candidate match must consume a WHOLE name token, not a prefix of a
// longer one — "Hunt, E." must never match inside "Hunt, E.T." (that's
// exactly the invented-middle-initial error this harness needs to catch,
// not paper over). The character immediately after the match may only be a
// separator (comma, &, whitespace-then-capital, or end of string) or
// another period belonging to the SAME initial (only when the candidate
// itself already ends mid-initials — handled by trying multiple lengths,
// not by accepting a trailing continuation here).
function isTokenBoundaryAfter(text: string, endIdx: number): boolean {
  if (endIdx >= text.length) return true;
  const rest = text.slice(endIdx);
  return /^\s*(,|&|and\s|\*|$)/.test(rest) || /^\s+[A-ZÀ-Ý]/.test(rest);
}

function locateName(text: string, boldMask: boolean[], name: string): AuthorRenderState | null {
  const normTarget = normalizeAuthorPunctuation(name);
  for (let start = 0; start < text.length; start++) {
    for (let len = Math.max(3, name.length - 4); len <= name.length + 6 && start + len <= text.length; len++) {
      const candidate = text.slice(start, start + len);
      if (normalizeAuthorPunctuation(candidate) === normTarget && isTokenBoundaryAfter(text, start + len)) {
        const window = text.slice(Math.max(0, start - 2), Math.min(text.length, start + len + 2));
        const marker: Marker = window.includes("**") ? "**" : /(?<!\*)\*(?!\*)/.test(window) ? "*" : "";
        const sliceMask = boldMask.slice(start, start + len);
        const bold = sliceMask.length > 0 && sliceMask.filter(Boolean).length >= sliceMask.length / 2;
        return { name, found: true, bold, marker };
      }
    }
  }
  return null;
}

export interface RawCitation {
  unitName: Unit;
  authorSegmentHtml: string;
  year: string;
  title: string;
  href: string;
  journal: string;
  tail: string;
}

// Parses an edition's HTML into per-unit raw citations. Works for BOTH the
// real live post (unit boundaries are <section id="..."> wrappers) and our
// own generator's output (lib/roundup-export.ts — unit boundaries are flat
// <h2 id="..."> headings, no <section>). Detecting whichever shape is
// present means one parser serves both sides of the diff — never two
// separate implementations that could quietly drift apart.
export function parseEditionHtml(html: string): RawCitation[] {
  const $ = cheerio.load(html);
  const results: RawCitation[] = [];

  // The live post is inconsistent about which tag wraps a unit's content —
  // every unit but CARD uses <section id="...">; CARD alone uses a plain
  // <div id="card">, apparently from a differently-edited pass. Our own
  // generator (lib/roundup-export.ts) uses neither — it emits flat
  // <h2 id="...">Unit</h2> headings with no wrapper at all. Rather than
  // hardcode every possible container/slug combination, detect unit
  // boundaries by the heading's own visible text (matched against the
  // canonical UNITS list) — this works identically for all three shapes.
  const sectionEls = $("section[id], div[id]")
    .toArray()
    .filter((el) => unitFromHeadingText($(el).find("h2").first().text()));
  const unitBlocks: Array<{ unitName: Unit; $scope: cheerio.Cheerio<import("domhandler").Element> }> = [];

  if (sectionEls.length > 0) {
    for (const el of sectionEls) {
      const unitName = unitFromHeadingText($(el).find("h2").first().text());
      if (unitName) unitBlocks.push({ unitName, $scope: $(el) });
    }
  } else {
    // Flat <h2>Unit</h2> followed by <p> citations until the next <h2>.
    const headings = $("h2").toArray().filter((h) => unitFromHeadingText($(h).text()));
    for (const h of headings) {
      const unitName = unitFromHeadingText($(h).text());
      if (!unitName) continue;
      const ps = $(h).nextUntil("h2", "p");
      unitBlocks.push({ unitName, $scope: ps as unknown as cheerio.Cheerio<import("domhandler").Element> });
    }
  }

  for (const { unitName, $scope } of unitBlocks) {
    const paragraphs = sectionEls.length > 0 ? $scope.find("p").toArray() : $scope.toArray();
    for (const p of paragraphs) {
      const $p = $(p);
      const innerHtml = $p.html() ?? "";
      const plain = unescapeHtml(stripTags(innerHtml));
      const yearMatch = /\(20\d\d/.exec(plain);
      const link = $p.find("a").first();
      if (!yearMatch || link.length === 0) continue;

      const yearHtmlIdx = findYearIndexInHtml(innerHtml);
      if (yearHtmlIdx === -1) continue;
      const authorSegmentHtml = innerHtml.slice(0, yearHtmlIdx);
      const yearStr = plain.slice(yearMatch.index + 1, yearMatch.index + 5);

      const title = link.text().trim();
      const href = link.attr("href") ?? "";
      // The live post's Word-export markup italicizes with <i>; our own
      // generator (lib/citation.ts::formatCitation) uses semantic <em>.
      const journal = $p.find("i, em").first().text().trim();
      const journalIdx = journal ? innerHtml.indexOf(journal) : -1;
      const afterJournalHtml = journalIdx !== -1 ? innerHtml.slice(journalIdx + journal.length) : "";
      const tail = unescapeHtml(stripTags(afterJournalHtml))
        .trim()
        .replace(/^[,.\s]+/, "")
        .replace(/\.\s*$/, "");

      results.push({ unitName, authorSegmentHtml, year: yearStr, title, href, journal, tail });
    }
  }

  return results;
}

// Locates the byte offset in a raw HTML string where a "(20XX" year pattern
// begins, ignoring text inside tag attributes (a plain regexp on the raw
// HTML risks matching inside a data-ccp-props JSON blob attribute in the
// live post's markup).
function findYearIndexInHtml(html: string): number {
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    if (html[i] === "<") inTag = true;
    if (html[i] === ">") {
      inTag = false;
      continue;
    }
    if (!inTag && /\(20\d\d/.test(html.slice(i, i + 5))) return i;
  }
  return -1;
}

// Loose title match: strips punctuation/whitespace/case so Word-export
// artifacts (narrow no-break spaces, curly quotes) never cause a false
// non-match. Used only to PAIR a generated citation with its live-post
// counterpart(s) — never as a substitute for the real equality checks that
// follow once paired.
export function normalizeTitleForMatch(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Comparison engine (Task B). Everything above this line is parsing; this
// section is the actual diff against the fixture's ground truth + the real
// live post.
// ---------------------------------------------------------------------------
import type { GroundTruthFixture, GroundTruthPublication } from "./backfill-seed";

export interface DiffFinding {
  pubKey: string;
  unit: Unit | null;
  field: string;
  generated: string;
  postSaid: string;
  reason?: string;
}

export interface BackfillDiffReport {
  unitsInLivePost: Unit[];
  unitsInGenerated: Unit[];
  missingUnitsKnown: Array<{ unit: Unit; reason: string }>; // documented, not a hard failure
  missingUnitsUnexplained: Unit[]; // any OTHER missing unit — a real hard failure
  multiUnitPapers: Array<{ pubKey: string; consistent: boolean; renders: string[] }>;
  awanDuplicateCount: number; // must be exactly 1 in generated output
  expectedDiffsConfirmed: DiffFinding[];
  expectedDiffsNotConfirmed: DiffFinding[]; // fixture claims a diff, but reality doesn't match it — a finding
  unexpectedDiffs: DiffFinding[];
  noFacultyPapers: Array<{ pubKey: string; title: string }>;
}

// The two author-level corrections made directly in the merged ground-truth
// record (Session 20 fixture work) that can never byte-match BOTH of the
// live post's flawed, mutually-inconsistent copies at once — see the
// backfill session report for the full reasoning. Keyed by
// `${pubKey}::${unit}::${authorName}`.
const EXPECTED_AUTHOR_MISMATCHES: Record<string, string> = {
  "initial-evidence-comparing-beverage-and-snack-di::Department of Health Sciences::Lawrence, S.":
    "post's Health Sciences copy leaves Lawrence unbolded (bolding omission); the Social Work copy correctly bolds him",
  "initial-evidence-comparing-beverage-and-snack-di::Department of Health Sciences::Gurnurkar, S.":
    "post's Health Sciences copy leaves Gurnurkar unbolded; the Social Work copy bolds (but misspells, as \"Gurnukar\") her",
  "initial-evidence-comparing-beverage-and-snack-di::School of Social Work::Gurnurkar, S.":
    "post's Social Work copy misspells this author as \"Gurnukar\" — the correct Crossref spelling is \"Gurnurkar\"",
  "initial-evidence-comparing-beverage-and-snack-di::Department of Health Sciences::Hunt, E.":
    "post's Health Sciences copy invents a middle initial (\"Hunt, E.T.\"); Crossref confirms just \"Ethan Hunt\"",
  "acoustic-and-psychoacoustic-analyses-of-predomin::School of Communication Sciences and Disorders::Awan, S. N.":
    "the surviving (Journal of Voice) copy under-bolds Awan; the discarded (Journal of Science) copy correctly bolds him — reconciled using the discarded copy's bolding",
  // Tayek is UCF CARD staff (confirmed post-session, not faculty), so the
  // post correctly left her unbolded under the legend's literal "CHPS
  // faculty" convention. Linking her as chps_faculty is a deliberate policy
  // call (option A in the Session 20 report) so the paper derives a unit at
  // all (§6a) — see the master plan note under §6 ROLES for the "staff,
  // derives unit, never bold" role (§6a-staff-role) this sidesteps for now.
  "arts-in-medicine-nurturing-creativity-through-co::Center for Autism and Related Disabilities::Tayek, K. A.":
    "Tayek is CARD staff, not faculty; the post correctly leaves her unbolded — linking her as chps_faculty (so the paper derives a unit) is a deliberate policy choice, not a post error",
  // The two multi-unit Pasarica/Yalim/Neely papers' Social Work copies use
  // visibly different spellings for several external co-authors than their
  // Kinesiology copies (no Crossref fixture exists for either paper to
  // arbitrate which is correct) — none of these affect role/bolding, only
  // spelling of non-CHPS names, so they're tracked here rather than chased
  // to a single ground truth this session can't verify.
  "long-term-impact-of-an-interprofessional-health::School of Social Work::Diaz, D.":
    "Social Work copy spells this external co-author \"Díaz, D.\" — no Crossref fixture to arbitrate",
  "long-term-impact-of-an-interprofessional-health::School of Social Work::Baily, M.":
    "Social Work copy spells this external co-author \"Bailey, M.\" — no Crossref fixture to arbitrate",
  "yoga-for-wellness-an-innovative-educational-inte::School of Social Work::Asencio, D.":
    "Social Work copy spells this external co-author \"Asencia, D.C.\" — no Crossref fixture to arbitrate",
  "yoga-for-wellness-an-innovative-educational-inte::School of Social Work::Diaz, D.":
    "Social Work copy spells this external co-author \"Díaz, D.\" — no Crossref fixture to arbitrate",
  "yoga-for-wellness-an-innovative-educational-inte::School of Social Work::Daly, K.":
    "Social Work copy's exact rendering of this external co-author's name could not be located verbatim",
  "yoga-for-wellness-an-innovative-educational-inte::School of Social Work::Baily, M.":
    "Social Work copy spells this external co-author \"Bailey, M.\" — no Crossref fixture to arbitrate",
  // DeLeon carries an undergrad asterisk in the Social Work copy of both
  // papers but not the Kinesiology copy — a bolding/marker omission in the
  // Kinesiology copy, same pattern as Lawrence/Gurnukar above. Yalim's
  // initials are shorter in the Kinesiology copy ("Yalim, A.") than the
  // Social Work copy ("Yalim, A.C.", matching the roster) — the fixture
  // stores the fuller form, so it can't be located verbatim in the
  // Kinesiology copy's shorter spelling.
  "long-term-impact-of-an-interprofessional-health::School of Kinesiology and Rehabilitation Sciences::DeLeon, A.":
    "Kinesiology copy omits DeLeon's undergrad asterisk; the Social Work copy correctly marks it",
  "long-term-impact-of-an-interprofessional-health::School of Kinesiology and Rehabilitation Sciences::Yalim, A.C.":
    "Kinesiology copy spells this author \"Yalim, A.\" (shorter initials than the roster's \"Yalim, A.C.\")",
  "yoga-for-wellness-an-innovative-educational-inte::School of Kinesiology and Rehabilitation Sciences::DeLeon, A.":
    "Kinesiology copy omits DeLeon's undergrad asterisk; the Social Work copy correctly marks it",
  "yoga-for-wellness-an-innovative-educational-inte::School of Kinesiology and Rehabilitation Sciences::Yalim, A.C.":
    "Kinesiology copy spells this author \"Yalim, A.\" (shorter initials than the roster's \"Yalim, A.C.\")",
};

// Same idea, for a tail that's simply ABSENT in one copy (the Social Work
// copy of "Yoga for Wellness" prints no volume/issue/pages at all, unlike
// its Kinesiology copy) — keyed by `${pubKey}::${unit}`.
const EXPECTED_MISSING_TAIL: Record<string, string> = {
  "yoga-for-wellness-an-innovative-educational-inte::School of Social Work":
    "Social Work copy prints no volume/issue/pages at all; the Kinesiology copy has the real values",
};

// Same idea as EXPECTED_AUTHOR_MISMATCHES, for URLs: the two Pasarica
// multi-unit papers print a different (non-safelink) URL for the same DOI
// in each copy — one bare-DOI, one publisher-direct. Keyed by
// `${pubKey}::${unit}`.
const EXPECTED_URL_MISMATCHES: Record<string, string> = {
  "long-term-impact-of-an-interprofessional-health::School of Social Work":
    "Social Work copy links the publisher page directly instead of the bare DOI used elsewhere in the post",
  "yoga-for-wellness-an-innovative-educational-inte::School of Social Work":
    "Social Work copy links the publisher page directly instead of the bare DOI used elsewhere in the post",
};

function isSafelinkExpected(diff: { field: string; post_said: string }): boolean {
  return diff.field === "url" && diff.post_said.includes("safelink");
}

// Session 21 (§13.24 operational backfill) Task B: comparing PRODUCTION
// (real Crossref/PubMed ingest) against a fixture built by transcribing the
// original WordPress post is a different comparison in kind from
// compareEditions above (generated-vs-live-post). Crossref returns the
// publisher's own record; the fixture reflects whatever the post happened
// to print — abbreviated journal names, raw/scholar-redirect URLs instead
// of a canonical DOI link, omitted volume/issue/pages, headline-cased
// titles. None of that is a content disagreement about which paper, which
// authors, or which unit — only about how completely a bibliographic
// field is rendered. This axis is allowlisted at the FIELD level (not
// case-by-case): once title identity, author list, year, and unit all
// still agree, a journal/url/tail/title difference is expected, not a
// finding to individually confirm against expected_diffs.
export const PRODUCTION_METADATA_UPGRADE_FIELDS = ["journal", "url", "tail", "title"] as const;
export type ProductionMetadataUpgradeField = (typeof PRODUCTION_METADATA_UPGRADE_FIELDS)[number];

export function isProductionMetadataUpgradeField(field: string): field is ProductionMetadataUpgradeField {
  return (PRODUCTION_METADATA_UPGRADE_FIELDS as readonly string[]).includes(field);
}

// Session 21 remediation: 20 authors across 12 publications where the
// fixture's post-transcribed name and production's pre-existing name for
// the SAME real person differ by more than normalizeAuthorName (lib/matching.ts)
// can bridge — compound-surname splitting, a genuine spelling variant,
// Unicode diacritics, or — for two of these — a Session 20 fixture-parsing
// bug that concatenated two authors' names into one garbled string. The
// fixture keeps the post's literal text (tests/backfill.test.ts's
// generated-vs-live-post comparison needs to locate that exact string in
// the real WordPress post), so this map is the single shared source of
// truth for "these two spellings are the same person" — used by
// scripts/backfill-reconcile-2025.ts (so mergeAuthors' dedup key recognizes
// the fixture's incoming author as the row production already has, instead
// of appending a duplicate on every run) AND by
// scripts/backfill-verify-production-2025.ts (so Task B's citation
// comparison doesn't flag these as unexpected author differences). Keyed by
// `${pubKey}::${fixture author name}` (never global) — several of these
// post-spellings are common enough ("Baily, M.", "Garcia, M.") that a
// global rename would misfire on an unrelated publication where that exact
// spelling already matches its own production row correctly.
export const AUTHOR_DEDUP_OVERRIDES: Record<string, string> = {
  "testing-circuit-level-theories-of-consciousness::Pujol, C.F.": "Fernandez Pujol, C.",
  "effects-of-negative-emotions-and-personality-tra::Cinar, B.": "Çınar, B.",
  "kinesiophobia-associates-with-physical-performan::Bandokar S.": "Bandodkar, S.",
  "kinesiophobia-associates-with-physical-performan::Schwartz A.L.": "Schwartz, A.",
  "kinesiophobia-associates-with-physical-performan::Norte, G. E.": "Norte, G.",
  "injury-frequencies-in-college-recreational-sport::Mangum, L.C.": "Colby Mangum, L.",
  "optimizing-arm-cycling-exercise-prescription-com::Panissa, V. L. G.": "Leme Gonçalves Panissa, V.",
  "an-examination-of-how-people-who-use-drugs-conce::Elliott, L.C.": "Elliott, L.",
  "reliability-and-validity-of-low-cost-tension-dev::Jacques, D.": "Jacques, D.J.",
  "reliability-and-validity-of-low-cost-tension-dev::Garcia, M.": "Garcia, M.C.",
  "reliability-and-validity-of-low-cost-tension-dev::Batista, N.": "Batista, N.P.",
  "yoga-for-wellness-an-innovative-educational-inte::Oprea, E.": "Oprea, E.M.",
  "yoga-for-wellness-an-innovative-educational-inte::Asencio, D.": "Asencio, D.C.",
  "yoga-for-wellness-an-innovative-educational-inte::Baily, M.": "Bailey, M.",
  "knee-extensor-and-flexor-force-control-after-acl::Sherman, D.": "Sherman, D.A.",
  // Session 20 fixture-parsing bug: the live post's Word-export markup
  // concatenated two authors' names into one garbled string.
  "characterizing-discourse-group-roles-in-inquiry::Cao": "Cao, Y.",
  "characterizing-discourse-group-roles-in-inquiry::Y. & Ouimet, P.": "Ouimet, P.-P.A.",
  "black-deaf-feminist-methodology-the-methodologic::R. L. & **Brevil, A.": "Brevil, A.N.",
  "development-and-validation-of-equations-to-estim::Guerra, R.": "Guerra, R.S.",
  "development-and-validation-of-equations-to-estim::P.Vasques, A.C.J.": "Vasques, A.C.J.",
};

export function resolveAuthorDedupName(pubKey: string, authorName: string): string {
  return AUTHOR_DEDUP_OVERRIDES[`${pubKey}::${authorName}`] ?? authorName;
}

// Applies every AUTHOR_DEDUP_OVERRIDES entry for this publication as a plain
// substring replacement — used to rewrite the CLEAN ROOM's rendered author
// text (which necessarily uses the fixture's post-literal spelling) into
// production's canonical spelling before comparing the two, for Task B only.
export function applyAuthorDedupOverridesToText(pubKey: string, text: string): string {
  let out = text;
  for (const [key, replacement] of Object.entries(AUTHOR_DEDUP_OVERRIDES)) {
    const [ownerKey, originalName] = key.split("::");
    if (ownerKey !== pubKey) continue;
    // The two garbled-name overrides contain a literal "&" — the caller's
    // text here is tag-stripped but NOT html-entity-decoded, so the real
    // string in production's HTML output is "&amp;", not "&". Only try the
    // entity-encoded form when it's actually different, or a name with no
    // "&" at all would get replaced twice — once as itself, then again
    // because the freshly-inserted replacement text still contains the
    // original name as a substring (e.g. "Jacques, D." inside "Jacques, D.J.").
    const escapedName = originalName.replace(/&/g, "&amp;");
    if (out.includes(originalName)) out = out.split(originalName).join(replacement);
    else if (escapedName !== originalName && out.includes(escapedName)) out = out.split(escapedName).join(replacement);
  }
  return out;
}

// Journal names sometimes carry a trailing period or comma purely because
// of where the post's italic tag boundary happened to land (the
// punctuation is real either way — it's just inconsistently inside or
// outside the <i> — never a content difference). Stripped before compared.
function normalizeJournalForCompare(journal: string): string {
  return journal.trim().replace(/[.,]+$/, "");
}

export function compareEditions(
  generatedCitations: RawCitation[],
  livePostCitations: RawCitation[],
  fixture: GroundTruthFixture
): BackfillDiffReport {
  const unitsInLivePost = UNITS.filter((u) => livePostCitations.some((c) => c.unitName === u));
  const unitsInGenerated = UNITS.filter((u) => generatedCitations.some((c) => c.unitName === u));

  const missingUnitsKnown: Array<{ unit: Unit; reason: string }> = [];
  const missingUnitsUnexplained: Unit[] = [];
  for (const u of unitsInLivePost) {
    if (unitsInGenerated.includes(u)) continue;
    if (u === "Center for Autism and Related Disabilities") {
      missingUnitsKnown.push({
        unit: u,
        reason:
          "CARD's only paper (Arts in Medicine) has no author bold anywhere in the post, no Crossref affiliation data, and no roster cross-reference is possible in clean-room mode — see fixture's arts-in-medicine _review note. Needs a human with real roster access.",
      });
    } else {
      missingUnitsUnexplained.push(u);
    }
  }

  const byKey = new Map<string, GroundTruthPublication>();
  for (const p of fixture.publications) byKey.set(normalizeTitleForMatch(p.title), p);

  const expectedDiffsConfirmed: DiffFinding[] = [];
  const expectedDiffsNotConfirmed: DiffFinding[] = [];
  const unexpectedDiffs: DiffFinding[] = [];
  const noFacultyPapers: Array<{ pubKey: string; title: string }> = [];
  const multiUnitPapers: Array<{ pubKey: string; consistent: boolean; renders: string[] }> = [];
  let awanDuplicateCount = 0;

  for (const pub of fixture.publications) {
    const normTitle = normalizeTitleForMatch(pub.title);
    const generatedCopies = generatedCitations.filter((c) => normalizeTitleForMatch(c.title) === normTitle);
    const livePostCopies = livePostCitations.filter((c) => normalizeTitleForMatch(c.title) === normTitle);

    if (pub.units_in_post.length === 0 || !pub.authors.some((a) => a.role === "chps_faculty")) {
      noFacultyPapers.push({ pubKey: pub.key, title: pub.title });
      continue;
    }

    if (pub.key === "acoustic-and-psychoacoustic-analyses-of-predomin") {
      awanDuplicateCount = generatedCopies.length;
    }

    if (pub.units_in_post.length > 1) {
      const renders = generatedCopies.map((c) => stripBoldMarkers(c.authorSegmentHtml));
      const consistent = renders.every((r) => r === renders[0]);
      multiUnitPapers.push({ pubKey: pub.key, consistent, renders });
    }

    for (const unit of pub.units_in_post as Unit[]) {
      const generated = generatedCopies.find((c) => c.unitName === unit);
      const livePost = livePostCopies.find((c) => c.unitName === unit);
      if (!generated || !livePost) continue; // reported separately via missing-unit / unmatched checks

      compareScalarField(
        pub,
        unit,
        "journal",
        normalizeJournalForCompare(generated.journal),
        normalizeJournalForCompare(livePost.journal),
        expectedDiffsConfirmed,
        expectedDiffsNotConfirmed,
        unexpectedDiffs
      );
      const missingTailReason = EXPECTED_MISSING_TAIL[`${pub.key}::${unit}`];
      if (missingTailReason && livePost.tail.trim() === "" && generated.tail.trim() !== "") {
        expectedDiffsConfirmed.push({ pubKey: pub.key, unit, field: "tail", generated: generated.tail, postSaid: livePost.tail, reason: missingTailReason });
      } else {
        compareTailField(pub, unit, generated.tail, livePost.tail, expectedDiffsConfirmed, expectedDiffsNotConfirmed, unexpectedDiffs);
      }

      const urlAllowlistReason = EXPECTED_URL_MISMATCHES[`${pub.key}::${unit}`];
      if (urlAllowlistReason && generated.href !== livePost.href) {
        expectedDiffsConfirmed.push({ pubKey: pub.key, unit, field: "url", generated: generated.href, postSaid: livePost.href, reason: urlAllowlistReason });
      } else {
        compareUrlField(pub, unit, generated.href, livePost.href, expectedDiffsConfirmed, expectedDiffsNotConfirmed, unexpectedDiffs);
      }

      const knownNames = pub.authors.map((a) => a.name);
      const states = findAuthorRenderState(livePost.authorSegmentHtml, knownNames);
      for (const author of pub.authors) {
        const state = states.find((s) => s.name === author.name)!;
        const expectedBold = author.role === "chps_faculty";
        const expectedMarker: Marker = author.role === "grad_student" ? "**" : author.role === "undergrad_student" ? "*" : "";
        const allowlistKey = `${pub.key}::${unit}::${author.name}`;
        const allowlistReason = EXPECTED_AUTHOR_MISMATCHES[allowlistKey];

        if (!state.found) {
          const finding: DiffFinding = {
            pubKey: pub.key,
            unit,
            field: `author:${author.name}`,
            generated: expectedBold ? "bold" : expectedMarker || "plain",
            postSaid: "(name not found in post's author segment)",
            reason: allowlistReason,
          };
          (allowlistReason ? expectedDiffsConfirmed : unexpectedDiffs).push(finding);
          continue;
        }

        const mismatch = state.bold !== expectedBold || state.marker !== expectedMarker;
        if (mismatch) {
          const finding: DiffFinding = {
            pubKey: pub.key,
            unit,
            field: `author:${author.name}`,
            generated: expectedBold ? "bold" : expectedMarker || "plain",
            postSaid: state.bold ? "bold" : state.marker || "plain",
            reason: allowlistReason,
          };
          (allowlistReason ? expectedDiffsConfirmed : unexpectedDiffs).push(finding);
        }
      }
    }
  }

  return {
    unitsInLivePost,
    unitsInGenerated,
    missingUnitsKnown,
    missingUnitsUnexplained,
    multiUnitPapers,
    awanDuplicateCount,
    expectedDiffsConfirmed,
    expectedDiffsNotConfirmed,
    unexpectedDiffs,
    noFacultyPapers,
  };
}

function stripBoldMarkers(authorSegmentHtml: string): string {
  return extractPlainWithBoldMask(authorSegmentHtml).text.trim();
}

function compareScalarField(
  pub: GroundTruthPublication,
  unit: Unit,
  field: string,
  generatedValue: string,
  postValue: string,
  confirmed: DiffFinding[],
  notConfirmed: DiffFinding[],
  unexpected: DiffFinding[]
) {
  const gen = (generatedValue ?? "").trim();
  const post = (postValue ?? "").trim();
  const expected = pub.expected_diffs?.find((d) => d.field === field);

  if (gen === post) return; // identical — nothing to report either way

  if (expected) {
    const genMatches = gen === String(expected.corrected).trim();
    const postMatches = post === String(expected.post_said).trim();
    const finding: DiffFinding = { pubKey: pub.key, unit, field, generated: gen, postSaid: post, reason: expected.reason };
    (genMatches && postMatches ? confirmed : notConfirmed).push(finding);
    return;
  }

  unexpected.push({ pubKey: pub.key, unit, field, generated: gen, postSaid: post });
}

// The post prints volume/issue/pages as ONE combined trailing string (e.g.
// "68(4), 1743-1757"), but the fixture's expected_diffs are recorded per
// underlying field (volume/issue/pages independently, since that's what's
// actually corrected against Crossref). Reconstructing the combined string
// from whichever of those three fields have an expected_diffs entry lets
// this reuse the SAME fixture data as the per-field diffs, rather than a
// separate parallel "expected tail string" the fixture would have to keep
// in sync by hand.
interface VolIssuePages {
  volume: string | null;
  issue: string | null;
  pages: string | null;
}

// Parses a printed "volume/issue/pages" tail into structured parts,
// tolerating the punctuation conventions actually seen across the live
// post ("39(3), 573", "44:524-531", "24(1): 41-45", "Volume 39, issue 8",
// "0(0)", bare pages like "1-10") — the SAME axis as author-name
// punctuation: the underlying bibliographic data is what matters, not
// which separator character the post happened to use for it.
function parseTailToVolIssuePages(tail: string): VolIssuePages {
  let t = (tail ?? "").trim().replace(/^[,.\s]+/, "").replace(/[.\s]+$/, "");
  if (!t) return { volume: null, issue: null, pages: null };

  let m = /^Volume\s+(\d+),\s*issue\s+(\d+)$/i.exec(t);
  if (m) return { volume: m[1], issue: m[2], pages: null };

  if (/^\(.*\)$/.test(t)) return { volume: null, issue: null, pages: null };

  m = /^(\d+)\((\S+?)\)[,:]?\s*p?\s*(.*)$/.exec(t);
  if (m) return { volume: m[1], issue: m[2], pages: m[3].trim() || null };

  m = /^(\d+)[,:]\s*(.+)$/.exec(t);
  if (m) return { volume: m[1], issue: null, pages: m[2].trim() };

  return { volume: null, issue: null, pages: t };
}

function vipEqual(a: VolIssuePages, b: VolIssuePages): boolean {
  return a.volume === b.volume && a.issue === b.issue && a.pages === b.pages;
}

function compareTailField(
  pub: GroundTruthPublication,
  unit: Unit,
  generatedTail: string,
  postTail: string,
  confirmed: DiffFinding[],
  notConfirmed: DiffFinding[],
  unexpected: DiffFinding[]
) {
  const gen = (generatedTail ?? "").trim();
  const post = (postTail ?? "").trim();
  if (gen === post) return;

  const genVip = parseTailToVolIssuePages(gen);
  const postVip = parseTailToVolIssuePages(post);
  // Equal once parsed into (volume, issue, pages) — the raw strings only
  // differed by punctuation convention (comma vs colon, "Volume X, issue Y"
  // phrasing, etc.), never by content. Nothing to report.
  if (vipEqual(genVip, postVip)) return;

  const relevant = (pub.expected_diffs ?? []).filter((d) => ["volume", "issue", "pages"].includes(d.field));
  const finding: DiffFinding = { pubKey: pub.key, unit, field: "tail", generated: gen, postSaid: post };

  if (relevant.length === 0) {
    unexpected.push(finding);
    return;
  }

  // The post's actual printed tail must contain every relevant field's
  // post_said value, and the generated tail must contain every relevant
  // field's corrected value — proving both halves of the fix, not just
  // that SOMETHING differs.
  const postMatches = relevant.every((d) => post.includes(String(d.post_said)));
  const genMatches = relevant.every((d) => gen.includes(String(d.corrected)));
  finding.reason = relevant.map((d) => d.reason).join("; ");
  (postMatches && genMatches ? confirmed : notConfirmed).push(finding);
}

function compareUrlField(
  pub: GroundTruthPublication,
  unit: Unit,
  generatedHref: string,
  postHref: string,
  confirmed: DiffFinding[],
  notConfirmed: DiffFinding[],
  unexpected: DiffFinding[]
) {
  if (generatedHref === postHref) return;

  const expected = pub.expected_diffs?.find((d) => d.field === "url");
  const finding: DiffFinding = { pubKey: pub.key, unit, field: "url", generated: generatedHref, postSaid: postHref, reason: expected?.reason };

  if (expected && isSafelinkExpected(expected) && postHref.includes("safelinks.protection.outlook.com")) {
    const genMatches = generatedHref === expected.corrected;
    (genMatches ? confirmed : notConfirmed).push(finding);
    return;
  }
  if (expected) {
    const genMatches = generatedHref === expected.corrected;
    const postMatches = postHref === expected.post_said;
    (genMatches && postMatches ? confirmed : notConfirmed).push(finding);
    return;
  }
  unexpected.push(finding);
}
