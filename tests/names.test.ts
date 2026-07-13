// Ground truth: docs/wp-directory-notes.md §6 — "12 of 124 records are affected."
// Every row in DIRTY_NAMES below is transcribed verbatim from that table. If a test
// here disagrees with what a citation should look like, the fixture is wrong, not
// the code — do not bend these to make an implementation pass.
import { describe, expect, it } from "vitest";
import { normalizeGivenName, toCitationName } from "../lib/names";

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
