// Ground truth: docs/wp-directory-notes.md §4 (URL variant fixture set) and §10
// (named sample records). Every URL below is transcribed verbatim from that file.
import { describe, expect, it } from "vitest";
import { scholarUserId } from "../lib/scholar";

describe("scholarUserId — real variants from §4", () => {
  it.each([
    ["hl before user", "https://scholar.google.com/citations?hl=en&user=USILmqcAAAAJ", "USILmqcAAAAJ"],
    ["hl after user", "https://scholar.google.com/citations?user=EyvTMEcAAAAJ&hl=en", "EyvTMEcAAAAJ"],
    ["bare user only", "https://scholar.google.com/citations?user=fMcpEBMAAAAJ", "fMcpEBMAAAAJ"],
    ["view_op prefix", "https://scholar.google.com/citations?view_op=list_works&hl=en&user=fHWxOCAAAAAJ", "fHWxOCAAAAAJ"],
    ["oi=sra suffix", "https://scholar.google.com/citations?user=PhpZGb0AAAAJ&hl=en&oi=sra", "PhpZGb0AAAAJ"],
    ["oi=ao suffix", "https://scholar.google.com/citations?user=rI2eHEwAAAAJ&hl=en&oi=ao", "rI2eHEwAAAAJ"],
    ["kitchen sink", "https://scholar.google.com/citations?hl=en&tzom=240&user=P13Ahy4AAAAJ&view_op=list_works&sortby=pubdate", "P13Ahy4AAAAJ"],
  ])("%s", (_label, url, expected) => {
    expect(scholarUserId(url)).toBe(expected);
  });
});

describe("scholarUserId — case-sensitive IDs (never lowercase, _ and - preserved)", () => {
  it.each([
    "hs_VC0kAAAAJ",
    "l_2K_NgAAAAJ",
    "W-E8_LwAAAAJ",
  ])("preserves %s exactly", (id) => {
    expect(scholarUserId(`https://scholar.google.com/citations?user=${id}&hl=en`)).toBe(id);
  });
});

describe("scholarUserId — named sample records from §10", () => {
  it.each([
    ["Michael J. Rovito", "https://scholar.google.com/citations?user=PhpZGb0AAAAJ&hl=en&oi=sra", "PhpZGb0AAAAJ"],
    ["Matt S. Stock", "https://scholar.google.com/citations?user=hs_VC0kAAAAJ&hl=en", "hs_VC0kAAAAJ"],
    ["Nicole Dawson Loughran", "https://scholar.google.com/citations?hl=en&user=NJ_hCq0AAAAJ", "NJ_hCq0AAAAJ"],
    ["L. Colby Mangum", "https://scholar.google.com/citations?hl=en&user=5yIzMuQAAAAJ", "5yIzMuQAAAAJ"],
    ["A’Naja Newsome", "https://scholar.google.com/citations?user=mbxW_CUAAAAJ&hl=en", "mbxW_CUAAAAJ"],
    ["Ann Eddins", "https://scholar.google.com/citations?view_op=list_works&hl=en&user=mG0VWxkAAAAJ", "mG0VWxkAAAAJ"],
  ])("%s -> %s", (_name, url, expected) => {
    expect(scholarUserId(url)).toBe(expected);
  });
});

describe("scholarUserId — the 6 non-Scholar URLs from §10 (hostname guard, §5a.3)", () => {
  it.each([
    ["Kimberley Gryglewicz (ResearchGate profile)", "https://www.researchgate.net/profile/Kim_Gryglewicz"],
    ["Steven Burroughs (bare DOI entered in error)", "https://doi.org/10.1210/me.2012-1101"],
    ["Krista Jung (MyNCBI bibliography)", "https://www.ncbi.nlm.nih.gov/myncbi/1vG3CqHb_6cEik/bibliography/public/"],
    ["Erin Leeming (ResearchGate scientific-contributions)", "https://www.researchgate.net/scientific-contributions/Erin-Leeming-2333782918"],
    ["Deena Schwen Blackett (ResearchGate profile)", "https://www.researchgate.net/profile/Deena-Schwen-Blackett"],
    ["Ethan Hill (ResearchGate profile)", "https://www.researchgate.net/profile/Ethan_Hill"],
  ])("%s -> null", (_label, url) => {
    expect(scholarUserId(url)).toBeNull();
  });
});

describe("scholarUserId — never throws", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["not a URL at all", "not a url"],
    ["Scholar host but no user param", "https://scholar.google.com/citations?hl=en"],
    ["a relative path", "/citations?user=abc123"],
  ])("%s -> null", (_label, input) => {
    expect(() => scholarUserId(input as string | null | undefined)).not.toThrow();
    expect(scholarUserId(input as string | null | undefined)).toBeNull();
  });
});
