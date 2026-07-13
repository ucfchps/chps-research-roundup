// Ground truth: master plan §5 (layer priority) and §7 (dedup & merge). Pure
// functions only — no I/O, no AI. See lib/matching-ai.ts for the fuzzy escape
// hatch this module deliberately does not call.
import { describe, expect, it } from "vitest";
import {
  findMatch,
  mergeAuthors,
  mergeMetadata,
  normalizeDoi,
  normalizeTitle,
  type AuthorInput,
  type MatchableExisting,
  type MergeableExisting,
} from "../lib/matching";

describe("normalizeTitle — real-world variants", () => {
  it("a subtitle joined by ':' vs '—' normalize the same", () => {
    const colon = normalizeTitle("Limb Disuse Trials in Humans: Key Insights on Study Design");
    const dash = normalizeTitle("Limb Disuse Trials in Humans — Key Insights on Study Design");
    expect(colon).toBe(dash);
  });

  it("a trailing period is stripped", () => {
    expect(normalizeTitle("Some Title.")).toBe(normalizeTitle("Some Title"));
  });

  it("smart quotes and straight quotes normalize the same", () => {
    const smart = normalizeTitle("A Study of “Resilience” in Nursing");
    const straight = normalizeTitle('A Study of "Resilience" in Nursing');
    expect(smart).toBe(straight);
  });

  it("'&' and 'and' normalize the same", () => {
    expect(normalizeTitle("Health & Wellness")).toBe(normalizeTitle("Health and Wellness"));
  });

  it("diacritics are stripped", () => {
    expect(normalizeTitle("Café Résumé")).toBe(normalizeTitle("Cafe Resume"));
  });

  it("collapses whitespace and lowercases", () => {
    expect(normalizeTitle("  Some   TITLE  ")).toBe("some title");
  });
});

describe("normalizeDoi", () => {
  it("strips the https://doi.org/ prefix and lowercases", () => {
    expect(normalizeDoi("https://doi.org/10.1177/ABC123")).toBe("10.1177/abc123");
  });

  it("a bare DOI and a URL-prefixed DOI normalize the same", () => {
    expect(normalizeDoi("10.1177/abc123")).toBe(normalizeDoi("https://doi.org/10.1177/ABC123"));
  });

  it("null -> null", () => {
    expect(normalizeDoi(null)).toBeNull();
  });
});

function existingPub(overrides: Partial<MatchableExisting> = {}): MatchableExisting {
  return {
    id: 1,
    doi: null,
    title_normalized: normalizeTitle("Untitled"),
    ...overrides,
  };
}

describe("findMatch — §7 ladder, stops at first confident answer", () => {
  it("DOI match wins even when titles differ", () => {
    const existing = [existingPub({ id: 5, doi: "10.1/abc", title_normalized: normalizeTitle("Original Title") })];
    const result = findMatch(
      { doi: "https://doi.org/10.1/ABC", title: "A Completely Different Title" },
      existing
    );
    expect(result).toEqual({ type: "MATCH", publicationId: 5, reason: "doi" });
  });

  it("title match works when DOI is absent on both sides (the gray-lit case)", () => {
    const existing = [existingPub({ id: 7, doi: null, title_normalized: normalizeTitle("A Society Position Statement") })];
    const result = findMatch({ doi: null, title: "A Society Position Statement." }, existing);
    expect(result).toEqual({ type: "MATCH", publicationId: 7, reason: "title" });
  });

  it("no DOI or title match -> NEEDS_FUZZY, and does not throw or need AI configured", () => {
    const existing = [existingPub({ id: 1, doi: "10.1/x", title_normalized: normalizeTitle("Something Else") })];
    const result = findMatch({ doi: null, title: "Totally Unrelated Title" }, existing);
    expect(result).toEqual({ type: "NEEDS_FUZZY" });
  });

  it("empty existing list -> NEEDS_FUZZY", () => {
    expect(findMatch({ doi: null, title: "Anything" }, [])).toEqual({ type: "NEEDS_FUZZY" });
  });
});

function author(overrides: Partial<AuthorInput> = {}): AuthorInput {
  return {
    name: "Doe, J.",
    faculty_id: null,
    role: "unknown",
    role_set_by: null,
    role_set_at: null,
    position: 0,
    ...overrides,
  };
}

describe("mergeAuthors — §7 author merge rules", () => {
  it("two Scholar-triggered resolutions for the same co-authored paper produce one author list with BOTH faculty bolded", () => {
    // Alert for Stock resolved Stock as chps_faculty; Brazendale was on the
    // list but not yet cross-matched in that pass.
    const existing = [
      { ...author({ name: "Stock, M.S.", role: "chps_faculty", faculty_id: 10, role_set_by: "ingest", position: 0 }), id: 1 },
      { ...author({ name: "Brazendale, K.", role: "unknown", position: 1 }), id: 2 },
    ];
    // Alert for Brazendale resolved the same paper independently: Brazendale
    // is chps_faculty this time, Stock came back unknown in THIS pass.
    const incoming: AuthorInput[] = [
      author({ name: "Stock, M.S.", role: "unknown", position: 0 }),
      author({ name: "Brazendale, K.", role: "chps_faculty", faculty_id: 20, role_set_by: "ingest", position: 1 }),
    ];

    const merged = mergeAuthors(existing, incoming, "crossref");

    expect(merged).toHaveLength(2); // one list, not a duplicate row
    const stock = merged.find((a) => a.name === "Stock, M.S.")!;
    const brazendale = merged.find((a) => a.name === "Brazendale, K.")!;
    expect(stock.role).toBe("chps_faculty");
    expect(stock.faculty_id).toBe(10);
    expect(brazendale.role).toBe("chps_faculty");
    expect(brazendale.faculty_id).toBe(20);
  });

  // Both directions are constructed so that deleting the isHumanSet guard in
  // lib/matching.ts flips a concrete assertion below from pass to fail — not
  // just "the role looks unchanged," which the OTHER, unrelated guards
  // (role only ever upgrades from 'unknown'; faculty_id only ever fills a
  // null) would already make true by coincidence in a less careful fixture.

  it("a human-set role survives a subsequent ingest merge — direction 1: a human reset to 'unknown' is not re-claimed by automated matching", () => {
    // role_set_by='comms:...' with role='unknown' models a COMMS reviewer
    // explicitly clearing a wrong auto-tag. Nothing here prevents the
    // ordinary 'unknown' -> 'chps_faculty' upgrade branch from firing EXCEPT
    // the isHumanSet check — so this is a direct test of that branch.
    const existing = [
      { ...author({ name: "Sukhu, B.", role: "unknown", role_set_by: "comms:jsmith", position: 3 }), id: 9 },
    ];
    const incoming: AuthorInput[] = [
      author({ name: "Sukhu, B.", role: "chps_faculty", faculty_id: 99, role_set_by: "ingest", position: 3 }),
    ];

    const merged = mergeAuthors(existing, incoming, "pubmed");

    expect(merged[0].role).toBe("unknown");
    expect(merged[0].role_set_by).toBe("comms:jsmith");
    expect(merged[0].faculty_id).toBeNull();
  });

  it("a human-set role survives a subsequent ingest merge — direction 2: an already-classified grad_student is not silently linked to a faculty_id", () => {
    // Here match.role ('grad_student') already blocks the role-upgrade
    // branch on its own precondition, so the role assertion alone wouldn't
    // prove much. The faculty_id assertion is the real test: without
    // isHumanSet, the `else if (match.faculty_id === null && ...)` branch
    // would fire and silently link a human-classified student to a faculty
    // row — the false-positive-surname case §8b's "this isn't my paper"
    // exists to catch, reappearing through the back door on the next sync.
    const existing = [
      { ...author({ name: "Lopez Torralba, L.", role: "grad_student", role_set_by: "faculty:42", position: 0 }), id: 11 },
    ];
    const incoming: AuthorInput[] = [
      author({ name: "Lopez Torralba, L.", role: "chps_faculty", faculty_id: 77, role_set_by: "ingest", position: 0 }),
    ];

    const merged = mergeAuthors(existing, incoming, "orcid");

    expect(merged[0].role).toBe("grad_student");
    expect(merged[0].role_set_by).toBe("faculty:42");
    expect(merged[0].faculty_id).toBeNull();
  });

  it("never downgrades a machine-set chps_faculty back to unknown", () => {
    const existing = [
      { ...author({ name: "Lee, E.", role: "chps_faculty", faculty_id: 5, role_set_by: "ingest", position: 0 }), id: 1 },
    ];
    const incoming: AuthorInput[] = [author({ name: "Lee, E.", role: "unknown", position: 0 })];

    const merged = mergeAuthors(existing, incoming, "pubmed");

    expect(merged[0].role).toBe("chps_faculty");
    expect(merged[0].faculty_id).toBe(5);
  });

  it("adding a newly-recognized CHPS faculty author at position 2 does not move them to the end", () => {
    const existing = [
      { ...author({ name: "Garcia, J.", role: "unknown", position: 0 }), id: 1 },
      { ...author({ name: "Quelly, S.", role: "unknown", position: 1 }), id: 2 },
      { ...author({ name: "Lawrence, S.", role: "unknown", position: 2 }), id: 3 },
      { ...author({ name: "Gurnukar, S.", role: "unknown", position: 3 }), id: 4 },
    ];
    const incoming: AuthorInput[] = [
      author({ name: "Garcia, J.", role: "unknown", position: 0 }),
      author({ name: "Quelly, S.", role: "unknown", position: 1 }),
      author({ name: "Lawrence, S.", role: "chps_faculty", faculty_id: 3, role_set_by: "ingest", position: 2 }),
      author({ name: "Gurnukar, S.", role: "unknown", position: 3 }),
    ];

    const merged = mergeAuthors(existing, incoming, "crossref");

    expect(merged).toHaveLength(4);
    expect(merged[2].name).toBe("Lawrence, S."); // still at index 2, not pushed to the end
    expect(merged[2].role).toBe("chps_faculty");
    expect(merged[merged.length - 1].name).toBe("Gurnukar, S."); // last author unchanged
  });

  it("a genuinely new author present only in incoming is appended, not dropped", () => {
    const existing = [{ ...author({ name: "Zraick, R.I.", role: "chps_faculty", faculty_id: 1, position: 0 }), id: 1 }];
    const incoming: AuthorInput[] = [
      author({ name: "Zraick, R.I.", role: "chps_faculty", faculty_id: 1, position: 0 }),
      author({ name: "Awan, S.N.", role: "unknown", position: 1 }),
    ];

    const merged = mergeAuthors(existing, incoming, "crossref");

    expect(merged.map((a) => a.name)).toEqual(["Zraick, R.I.", "Awan, S.N."]);
    expect(merged[1].id).toBeNull(); // not yet persisted — caller must insert
  });

  it("Scholar incoming data never adds or restructures authors (§15.7 applied to author lists too)", () => {
    const existing = [{ ...author({ name: "Zraick, R.I.", role: "chps_faculty", faculty_id: 1, position: 0 }), id: 1 }];
    const incoming: AuthorInput[] = [
      author({ name: "Zraick, R.I.", role: "unknown", position: 0 }),
      author({ name: "New Person, X.", role: "unknown", position: 1 }),
    ];

    const merged = mergeAuthors(existing, incoming, "scholar");

    expect(merged).toHaveLength(1); // "New Person" never added from a Scholar source
    expect(merged[0].role).toBe("chps_faculty"); // and the existing entry is untouched
  });
});

function pubMetadata(overrides: Partial<MergeableExisting> = {}): MergeableExisting {
  return {
    doi: "10.1/abc",
    title: "A Title",
    url: "https://example.com/a",
    journal: "Journal A",
    year: 2025,
    volume: "1",
    issue: "2",
    pages: "1-10",
    source: "crossref",
    ...overrides,
  };
}

describe("mergeMetadata — §5 layer priority, field by field", () => {
  it("Crossref metadata wins when merging with a lower-priority PubMed record, in either arrival order", () => {
    const crossref = pubMetadata({ source: "crossref", journal: "Crossref Journal Name", volume: "17" });
    const pubmed = { ...pubMetadata({ source: "pubmed", journal: "PubMed Journal Name", volume: "18" }) };

    // Crossref already stored; PubMed arrives later.
    const a = mergeMetadata(crossref, pubmed, "pubmed");
    expect(a.journal).toBe("Crossref Journal Name");
    expect(a.volume).toBe("17");

    // PubMed already stored; Crossref arrives later and should still win.
    const b = mergeMetadata({ ...pubmed, source: "pubmed" }, { ...crossref }, "crossref");
    expect(b.journal).toBe("Crossref Journal Name");
    expect(b.volume).toBe("17");
  });

  it("a null field gets filled from a lower-priority source rather than staying empty", () => {
    const existing = pubMetadata({ source: "crossref", pages: null });
    const incoming = pubMetadata({ source: "pubmed", pages: "100-110" });

    const merged = mergeMetadata(existing, incoming, "pubmed");

    expect(merged.pages).toBe("100-110");
  });

  it("Scholar metadata never overwrites anything, even a null field", () => {
    const existing = pubMetadata({ source: "crossref", pages: null, journal: "Real Journal" });
    const incoming = pubMetadata({ source: "scholar", pages: "999-999", journal: "Scholar-Guessed Journal" });

    const merged = mergeMetadata(existing, incoming, "scholar");

    expect(merged.pages).toBeNull();
    expect(merged.journal).toBe("Real Journal");
  });

  it("recomputes title_normalized from the winning title", () => {
    const existing = pubMetadata({ source: "pubmed", title: "Old Title" });
    const incoming = pubMetadata({ source: "crossref", title: "New Title" });

    const merged = mergeMetadata(existing, incoming, "crossref");

    expect(merged.title).toBe("New Title");
    expect(merged.title_normalized).toBe(normalizeTitle("New Title"));
  });
});
