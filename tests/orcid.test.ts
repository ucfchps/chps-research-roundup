// Ground truth: docs/wp-directory-notes.md §9 — ORCID is stored as a full URL,
// and the final character of a real ORCID iD can be the checksum digit "X".
import { describe, expect, it } from "vitest";
import { orcidId } from "../lib/orcid";

describe("orcidId — named sample records from §10", () => {
  it.each([
    ["Michael J. Rovito", "https://orcid.org/0000-0001-8086-3460", "0000-0001-8086-3460"],
    ["Matt S. Stock", "https://orcid.org/0000-0003-1156-1084", "0000-0003-1156-1084"],
    ["L. Colby Mangum", "https://orcid.org/0000-0001-6443-2951", "0000-0001-6443-2951"],
    ["Kimberley Gryglewicz", "https://orcid.org/0000-0003-4395-2354", "0000-0003-4395-2354"],
    ["A’Naja Newsome", "https://orcid.org/0000-0002-4916-0705", "0000-0002-4916-0705"],
    ["Ethan Hill", "https://orcid.org/0000-0002-5573-3370", "0000-0002-5573-3370"],
    ["Shellene Mazany", "https://orcid.org/0009-0004-6362-4256", "0009-0004-6362-4256"],
  ])("%s -> %s", (_name, url, expected) => {
    expect(orcidId(url)).toBe(expected);
  });
});

describe("orcidId — the trailing checksum digit can be X", () => {
  it("does not truncate an iD ending in X", () => {
    expect(orcidId("https://orcid.org/0000-0002-1825-009X")).toBe("0000-0002-1825-009X");
  });

  it("accepts the www. host variant", () => {
    expect(orcidId("https://www.orcid.org/0000-0002-1825-009X")).toBe("0000-0002-1825-009X");
  });
});

describe("orcidId — never throws", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["not a URL at all", "not a url"],
    ["wrong host", "https://scholar.google.com/citations?user=abc123"],
    ["orcid.org with no iD in the path", "https://orcid.org/"],
  ])("%s -> null", (_label, input) => {
    expect(() => orcidId(input as string | null | undefined)).not.toThrow();
    expect(orcidId(input as string | null | undefined)).toBeNull();
  });
});
