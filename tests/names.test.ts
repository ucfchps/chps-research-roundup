// Ground truth: docs/wp-directory-notes.md §6 — "12 of 124 records are affected."
// Every row in DIRTY_NAMES below is transcribed verbatim from that table. If a test
// here disagrees with what a citation should look like, the fixture is wrong, not
// the code — do not bend these to make an implementation pass.
import { describe, expect, it } from "vitest";
import { fromPubmedAuthorName, normalizeGivenName, parseFullNameForPubmedQuery, toCitationName, toPubmedQueryName } from "../lib/names";

// [First Name (as stored), Last Name, expected normalizeGivenName() output]
const DIRTY_NAMES: [string, string, string][] = [
  ["Nicole Dawson", "Loughran", "Nicole"],
  ["Michael J.", "Rovito", "Michael"],
  ["Kristen Couper", "Schellhase", "Kristen"],
  ["Eunkyung Muriel", "Lee", "Eunkyung"],
  ["Todd R.", "Fix", "Todd"],
  ["Xiaochuan (Sharon)", "Wang", "Xiaochuan"],
  ["L. Colby", "Mangum", "Colby"],
  ["Asli Cennet", "Yalim", "Asli"],
  ["Carrie Dawson", "Loughran", "Carrie"],
  ["Latifa S.", "Abdelli", "Latifa"],
  ["A’Naja", "Newsome", "A'Naja"],
  ["Caitlin Ann", "Cheruka", "Caitlin"],
];

describe("normalizeGivenName — the 12 dirty records", () => {
  it.each(DIRTY_NAMES)("%s -> %s", (given, _family, expected) => {
    expect(normalizeGivenName(given)).toBe(expected);
  });
});

describe("normalizeGivenName — clean cases", () => {
  it.each([
    ["Matt", "Matt"],
    ["Ann", "Ann"],
    ["Erin", "Erin"],
  ])("%s -> %s (already clean, unchanged)", (given, expected) => {
    expect(normalizeGivenName(given)).toBe(expected);
  });
});

describe("normalizeGivenName — never throws, never returns empty", () => {
  it("a bare single initial has nothing left to normalize to — returns the trimmed input", () => {
    expect(normalizeGivenName("J.")).toBe("J.");
  });

  it("an all-nickname field has nothing left to normalize to — returns the trimmed input", () => {
    expect(normalizeGivenName("(Nickname)")).toBe("(Nickname)");
  });
});

describe("toCitationName — the 12 dirty records", () => {
  // Whether each record is confidently citable is itself part of ground truth:
  // §6's "Dawson Loughran case" callout explains why the two middle-name-as-
  // surname-fragment records must flag rather than mangle. A record is
  // ambiguous exactly when the given-name field has more than one non-initial
  // word left after nickname-stripping — we can't tell if that word is a
  // middle name to drop or a surname fragment misfiled in the wrong column.
  const EXPECTED_CONFIDENT: Record<string, boolean> = {
    "Nicole Dawson|Loughran": false,
    "Michael J.|Rovito": true,
    "Kristen Couper|Schellhase": false,
    "Eunkyung Muriel|Lee": false,
    "Todd R.|Fix": true,
    "Xiaochuan (Sharon)|Wang": true,
    "L. Colby|Mangum": true,
    "Asli Cennet|Yalim": false,
    "Carrie Dawson|Loughran": false,
    "Latifa S.|Abdelli": true,
    "A’Naja|Newsome": true,
    "Caitlin Ann|Cheruka": false,
  };

  it.each(DIRTY_NAMES)("%s + %s -> confident matches ground truth", (given, family) => {
    const result = toCitationName(given, family);
    expect(result.confident).toBe(EXPECTED_CONFIDENT[`${given}|${family}`]);
  });

  it("Michael J. + Rovito -> Rovito, M.J.", () => {
    expect(toCitationName("Michael J.", "Rovito")).toEqual({
      name: "Rovito, M.J.",
      confident: true,
    });
  });

  it("Xiaochuan (Sharon) + Wang -> Wang, X. (the nickname is not an initial)", () => {
    expect(toCitationName("Xiaochuan (Sharon)", "Wang")).toEqual({
      name: "Wang, X.",
      confident: true,
    });
  });
});

describe("toCitationName — explicit worked examples from the build spec", () => {
  it("Richard I. + Zraick -> Zraick, R.I.", () => {
    expect(toCitationName("Richard I.", "Zraick")).toEqual({
      name: "Zraick, R.I.",
      confident: true,
    });
  });

  it("Nicole + Dawson Loughran -> Dawson Loughran, N. (compound surnames stay intact once the given name itself is clean)", () => {
    expect(toCitationName("Nicole", "Dawson Loughran")).toEqual({
      name: "Dawson Loughran, N.",
      confident: true,
    });
  });

  it("Matt + Stock -> Stock, M. (baseline clean case)", () => {
    expect(toCitationName("Matt", "Stock")).toEqual({
      name: "Stock, M.",
      confident: true,
    });
  });
});

describe("toCitationName — flags ambiguity rather than mangling", () => {
  it("hyphenated surname -> confident: false", () => {
    const result = toCitationName("Maria", "Garcia-Stout");
    expect(result.confident).toBe(false);
  });

  it("particle 'van' in the surname -> confident: false", () => {
    const result = toCitationName("Hans", "van der Berg");
    expect(result.confident).toBe(false);
  });

  it("particle 'de' in the surname -> confident: false", () => {
    const result = toCitationName("Ana", "de la Cruz");
    expect(result.confident).toBe(false);
  });

  it("suffix 'Jr.' -> confident: false", () => {
    const result = toCitationName("John", "Smith Jr.");
    expect(result.confident).toBe(false);
  });

  it("never throws on an empty given name", () => {
    expect(() => toCitationName("", "Smith")).not.toThrow();
  });
});

// §13 item 10 (ingest-pubmed-orcid): PubMed's esearch wants "Family GI", not
// our citation form "Family, G.I." — build spec's worked example.
describe("toPubmedQueryName — roster citation form -> PubMed query form", () => {
  it("Zraick, R.I. -> Zraick RI (build spec's worked example)", () => {
    expect(toPubmedQueryName("Zraick, R.I.")).toBe("Zraick RI");
  });

  it("Stock, M. -> Stock M (single initial)", () => {
    expect(toPubmedQueryName("Stock, M.")).toBe("Stock M");
  });

  it("Dawson Loughran, N. -> Dawson Loughran N (compound surname preserved)", () => {
    expect(toPubmedQueryName("Dawson Loughran, N.")).toBe("Dawson Loughran N");
  });

  it("a name with no comma is returned trimmed, unchanged", () => {
    expect(toPubmedQueryName("NoComma")).toBe("NoComma");
  });
});

// Real esummary author shapes from tests/fixtures/pubmed/sample-summaries.json
// — the inverse conversion, needed before a PubMed author reaches
// publication_authors (everywhere else in the system stores citation form).
describe("fromPubmedAuthorName — PubMed author form -> roster citation form", () => {
  it("Stock MS -> Stock, M.S. (real fixture case)", () => {
    expect(fromPubmedAuthorName("Stock MS")).toBe("Stock, M.S.");
  });

  it("van Loon LJC -> van Loon, L.J.C. (real fixture case, multi-word family)", () => {
    expect(fromPubmedAuthorName("van Loon LJC")).toBe("van Loon, L.J.C.");
  });

  it("Ploutz-Snyder L -> Ploutz-Snyder, L. (real fixture case, single initial, hyphenated family)", () => {
    expect(fromPubmedAuthorName("Ploutz-Snyder L")).toBe("Ploutz-Snyder, L.");
  });

  it("round-trips through toPubmedQueryName back to the same initials shape", () => {
    expect(fromPubmedAuthorName(toPubmedQueryName("Zraick, R.I."))).toBe("Zraick, R.I.");
  });
});

// §13 item 10 bug fix: faculty.display_name can be missing a middle initial
// that the person's real identity carries (confirmed live: Stock's
// display_name is "Stock, M." but full_name is "Matt S. Stock" — querying
// PubMed on the sparse form returned 970 hits vs. the correct 140). full_name
// (given-name-first, e.g. "Matt S. Stock") is a richer source; this parser
// converts it to PubMed's "Surname II" query form.
//
// ★ Takes knownSurname (from display_name's already-correct citation form)
// as an anchor rather than guessing the surname boundary from full_name's
// shape alone. Confirmed live via scripts/audit-fullname-coverage.ts: a
// shape-only guess (last non-particle token = surname) is WRONG for a real,
// non-trivial share of the roster — compound surnames with no lowercase
// particle (confirmed real cases: "Abarca Sasser", "Schwen Blackett", "Lopez
// Castillo" — the exact same people docs/wp-directory-notes.md §6 already
// flags as ambiguous for toCitationName) get silently split wrong ("Diana
// Abarca Sasser" guessed as surname "Sasser", initials "DA" — dropping
// "Abarca" from the surname entirely). The directory's Last Name field
// already resolves this ambiguity correctly for citation form; reuse that
// ground truth instead of re-guessing it from a different, ambiguous shape.
describe("parseFullNameForPubmedQuery — given-name-first full_name -> PubMed query form, anchored on the known surname", () => {
  it("Matt S. Stock (surname 'Stock') -> Stock MS (the confirmed real bug case)", () => {
    expect(parseFullNameForPubmedQuery("Matt S. Stock", "Stock")).toEqual({ queryName: "Stock MS", surname: "Stock", initials: "MS" });
  });

  it("Adam J. Wells (surname 'Wells') -> Wells AJ (confirmed real roster case, same initial-loss pattern)", () => {
    expect(parseFullNameForPubmedQuery("Adam J. Wells", "Wells")).toEqual({ queryName: "Wells AJ", surname: "Wells", initials: "AJ" });
  });

  it("Grant E. Norte (surname 'Norte') -> Norte GE (confirmed real roster case — a DIFFERENT Norte, 'Shari Norte', is already clean and unaffected)", () => {
    expect(parseFullNameForPubmedQuery("Grant E. Norte", "Norte")).toEqual({ queryName: "Norte GE", surname: "Norte", initials: "GE" });
  });

  it("Joy D. Scheidell (surname 'Scheidell') -> Scheidell JD (confirmed real roster case)", () => {
    expect(parseFullNameForPubmedQuery("Joy D. Scheidell", "Scheidell")).toEqual({ queryName: "Scheidell JD", surname: "Scheidell", initials: "JD" });
  });

  it("a multi-word surname with a lowercase particle ('van Loon') is matched whole — modeled on the confirmed real 'van Loon LJC' PubMed fixture pattern", () => {
    expect(parseFullNameForPubmedQuery("Luc J. C. van Loon", "van Loon")).toEqual({ queryName: "van Loon LJC", surname: "van Loon", initials: "LJC" });
  });

  // The regression confirmed live: these three are the exact people
  // docs/wp-directory-notes.md §6 already documents as compound-surname
  // cases. Without the known-surname anchor, "Diana Abarca Sasser" naively
  // parses as surname "Sasser", initials "DA" — wrong on both counts.
  it("Diana Abarca Sasser (surname 'Abarca Sasser', no particle) -> Abarca Sasser D, not Sasser DA", () => {
    expect(parseFullNameForPubmedQuery("Diana Abarca Sasser", "Abarca Sasser")).toEqual({
      queryName: "Abarca Sasser D",
      surname: "Abarca Sasser",
      initials: "D",
    });
  });

  it("Deena Schwen Blackett (surname 'Schwen Blackett', no particle) -> Schwen Blackett D, not Blackett DS", () => {
    expect(parseFullNameForPubmedQuery("Deena Schwen Blackett", "Schwen Blackett")).toEqual({
      queryName: "Schwen Blackett D",
      surname: "Schwen Blackett",
      initials: "D",
    });
  });

  it("Humberto Lopez Castillo (surname 'Lopez Castillo', no particle) -> Lopez Castillo H, not Castillo HL", () => {
    expect(parseFullNameForPubmedQuery("Humberto Lopez Castillo", "Lopez Castillo")).toEqual({
      queryName: "Lopez Castillo H",
      surname: "Lopez Castillo",
      initials: "H",
    });
  });

  it("strips a generational suffix before computing initials", () => {
    expect(parseFullNameForPubmedQuery("John Smith Jr.", "Smith")).toEqual({ queryName: "Smith J", surname: "Smith", initials: "J" });
  });

  // Confirmed real roster case, checked live against the actual DB row
  // (docs/wp-directory-notes.md §6 already flags "Martha Garcia-Stout" as a
  // hyphenated-surname example for toCitationName) — a hyphen WITHIN a
  // single token, not a space-separated compound like "Abarca Sasser".
  it("Martha Garcia-Stout (surname 'Garcia-Stout', internal hyphen, single token) -> Garcia-Stout M", () => {
    expect(parseFullNameForPubmedQuery("Martha Garcia-Stout", "Garcia-Stout")).toEqual({
      queryName: "Garcia-Stout M",
      surname: "Garcia-Stout",
      initials: "M",
    });
  });

  // Confirmed real roster case: "Wang, X." / "Xiaochuan (Sharon) Wang" — a
  // parenthetical nickname in full_name, same class of dirty data §6
  // documents for the given-name field. Correctly rejected by the
  // clean-token check (parentheses aren't a name character) rather than
  // silently stripped — that normalization is normalizeGivenName's job
  // upstream, not this parser's.
  it("a full_name with a parenthetical nickname is not a clean name -> null (confirmed real case: Wang)", () => {
    expect(parseFullNameForPubmedQuery("Xiaochuan (Sharon) Wang", "Wang")).toBeNull();
  });

  // Confirmed real roster case, found by auditing every active faculty row's
  // fail-closed cases: "Renziehausen, J." has full_name "Justine
  // Starling-Smith" — a completely different surname (maiden/married-name
  // mismatch between the two directory fields, most likely). This is a real,
  // not synthetic, trigger of the mismatch guard.
  it("Justine Starling-Smith with known surname 'Renziehausen' -> null (confirmed real mismatch, not synthetic)", () => {
    expect(parseFullNameForPubmedQuery("Justine Starling-Smith", "Renziehausen")).toBeNull();
  });

  it("a single token cannot be split into given + surname -> null", () => {
    expect(parseFullNameForPubmedQuery("Stock", "Stock")).toBeNull();
  });

  it("an empty string -> null", () => {
    expect(parseFullNameForPubmedQuery("", "Stock")).toBeNull();
  });

  it("the known surname doesn't appear in full_name at all -> null, fail closed rather than guess (e.g. a maiden-name/married-name mismatch between the two fields)", () => {
    expect(parseFullNameForPubmedQuery("Matt S. Stock", "Reynolds")).toBeNull();
  });

  it("never throws on empty, single-token, or mismatched input", () => {
    expect(() => parseFullNameForPubmedQuery("", "Stock")).not.toThrow();
    expect(() => parseFullNameForPubmedQuery("Stock", "Stock")).not.toThrow();
    expect(() => parseFullNameForPubmedQuery("Matt S. Stock", "")).not.toThrow();
  });

  // Confirmed real edge case: faculty row "Lee, E.M." has a corrupted
  // full_name with raw, undecoded HTML entities — a sync-roster/WordPress
  // data-hygiene bug (out of scope here, flagged in docs/ops-notes.md
  // instead). The parser must fail closed, not attempt entity decoding or
  // nickname-stripping (that's normalization work belonging upstream). Note:
  // this person's display_name ("Lee, E.M.") already carries full initials,
  // so falling back to it is the CORRECT outcome, not a degradation.
  it("a full_name containing raw HTML entities is not a clean name -> null (fail closed, no entity decoding attempted)", () => {
    expect(parseFullNameForPubmedQuery("Eunkyung &#8220;Muriel&#8221; Lee", "Lee")).toBeNull();
  });
});
