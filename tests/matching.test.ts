// Ground truth: master plan §5 (layer priority) and §7 (dedup & merge). Pure
// functions only — no I/O, no AI. See lib/matching-ai.ts for the fuzzy escape
// hatch this module deliberately does not call.
import { describe, expect, it } from "vitest";
import {
  classifyAffiliationPlausibility,
  findMatch,
  isUcfAffiliation,
  mergeAuthors,
  mergeMetadata,
  normalizeAuthorName,
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

// Session 21 (§13.24 operational backfill): a real production regression —
// mergeAuthors used normalizeTitle (which only COLLAPSES whitespace, never
// removes it) as its author-dedup key. Two real, equally valid formats for
// the same compound-initial name ("Lubiak, S.M." vs "Lubiak, S. M.") differ
// by exactly one internal space, so they normalized to DIFFERENT strings
// and a real reconcile run appended 11 already-existing authors as
// duplicates on one publication alone. Author names, unlike titles, have no
// initial-spacing convention worth preserving — internal whitespace within
// a name is never semantically meaningful the way it is in a title.
describe("normalizeAuthorName — internal whitespace collapses to nothing (unlike normalizeTitle)", () => {
  it("'Lubiak, S.M.' and 'Lubiak, S. M.' normalize the same", () => {
    expect(normalizeAuthorName("Lubiak, S.M.")).toBe(normalizeAuthorName("Lubiak, S. M."));
  });

  it("still normalizes case and diacritics like normalizeTitle does", () => {
    expect(normalizeAuthorName("ÇINAR, B.")).toBe(normalizeAuthorName("Cinar, B."));
  });

  it("different people (different initials) still normalize differently", () => {
    expect(normalizeAuthorName("Yilmaz, Y.")).not.toBe(normalizeAuthorName("Yilmaz, G."));
  });

  // Real same-surname-different-person cases this exact session hit
  // (Session 20's Anderson name-collision split; Session 20's two distinct
  // Lees; Session 21's still-unresolved Chen ambiguity) — the fix must
  // never treat any of these as the same person just because collapsing
  // internal whitespace made them shorter strings to compare.
  it("Anderson, A.W. (Kinesiology) and Anderson, K.M. (Social Work) — a real name collision — stay distinct", () => {
    expect(normalizeAuthorName("Anderson, A.W.")).not.toBe(normalizeAuthorName("Anderson, K.M."));
  });

  it("Lee, Y.H. and Lee, E. — two distinct real Health Sciences faculty — stay distinct", () => {
    expect(normalizeAuthorName("Lee, Y.H.")).not.toBe(normalizeAuthorName("Lee, E."));
  });

  it("Chen, X.S. (fixture) and Chen, S. (production roster) — the still-unresolved ambiguous case — stay distinct", () => {
    expect(normalizeAuthorName("Chen, X.S.")).not.toBe(normalizeAuthorName("Chen, S."));
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

// §13 item 10 follow-up (ops-notes.md §5/§6): moved here from lib/crossref.ts
// so buildAuthorInputs (below, and lib/scholar-ingest.ts) can gate on it
// without a hard dependency on lib/crossref.ts's CROSSREF_MAILTO
// import-time throw — every ingester (Crossref-direct, Scholar, ORCID,
// PubMed) needs this check, not just the Crossref-specific ones.
// lib/crossref.ts re-exports this same function for backward compatibility;
// tests/crossref.test.ts still covers it via that re-export.
describe("isUcfAffiliation", () => {
  it("matches the fully spelled-out form", () => {
    expect(isUcfAffiliation("University of Central Florida, Orlando, FL, USA")).toBe(true);
  });

  it("matches 'Univ. of Central Florida' — the real Zraick-run case that motivated this pattern", () => {
    expect(isUcfAffiliation("Univ. of Central Florida")).toBe(true);
  });

  it("matches a bare 'UCF'", () => {
    expect(isUcfAffiliation("UCF, Orlando, FL")).toBe(true);
  });

  it("does not match University of Florida or University of South Florida", () => {
    expect(isUcfAffiliation("University of Florida")).toBe(false);
    expect(isUcfAffiliation("University of South Florida")).toBe(false);
  });

  it("never throws on null/undefined/empty", () => {
    expect(isUcfAffiliation(null)).toBe(false);
    expect(isUcfAffiliation(undefined)).toBe(false);
    expect(isUcfAffiliation("")).toBe(false);
  });
});

// docs/phase5-findings.md #2 (Session 12): a plausibility signal, not a
// gate — every candidate still reaches the merge engine regardless of
// bucket. See tests/pubmed.test.ts for the real-fixture XML extraction this
// consumes.
describe("classifyAffiliationPlausibility", () => {
  it("confirmed — at least one author's affiliation matches UCF", () => {
    expect(classifyAffiliationPlausibility(["University of Central Florida, Orlando, FL"])).toBe("confirmed");
  });

  it("confirmed — a match anywhere in a multi-author list, not just the first", () => {
    expect(classifyAffiliationPlausibility(["University of Toledo, OH", "Univ. of Central Florida", "High Point University, NC"])).toBe(
      "confirmed"
    );
  });

  it("not_ucf — affiliation data present on every author, none of it UCF", () => {
    expect(classifyAffiliationPlausibility(["Chinese Academy of Sciences, Beijing", "University of Edinburgh, UK"])).toBe("not_ucf");
  });

  it("ambiguous — no affiliation data at all (empty list), never treated as evidence either way", () => {
    expect(classifyAffiliationPlausibility([])).toBe("ambiguous");
  });

  it("never a hard exclusion signal by itself — 'not_ucf' and 'ambiguous' are both distinct from 'confirmed', not from each other's callers' behavior", () => {
    // The distinction exists for reporting; nothing in this function decides
    // whether a candidate is inserted — see scripts/ingest-pubmed-orcid.ts's
    // sweepPubmed, which calls applyCandidate for every candidate regardless
    // of bucket.
    expect(["not_ucf", "ambiguous"]).toContain(classifyAffiliationPlausibility([]));
    expect(["not_ucf", "ambiguous"]).toContain(classifyAffiliationPlausibility(["Some Other University"]));
  });
});

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

  // ops-notes.md §5/§6: a NEW incoming shape as of the confirmation gate — a
  // fresh candidate match can now itself be role='unknown' (unconfirmed),
  // not just 'chps_faculty'. isHumanSet must still block on the EXISTING
  // row's own role_set_by regardless of what the incoming candidate looks
  // like — the guard was never conditioned on the incoming role.
  it("a human-set role survives even when the fresh incoming match is itself unconfirmed (not just when it's chps_faculty)", () => {
    const existing = [
      { ...author({ name: "Zhu, Y.", role: "grad_student", role_set_by: "faculty:7", position: 0 }), id: 5 },
    ];
    const incoming: AuthorInput[] = [
      author({ name: "Zhu, Y.", role: "unknown", faculty_id: 42, role_set_by: "ingest:unconfirmed_name_match_conflicting_affiliation", position: 0 }),
    ];

    const merged = mergeAuthors(existing, incoming, "crossref");

    expect(merged[0].role).toBe("grad_student");
    expect(merged[0].role_set_by).toBe("faculty:7");
    expect(merged[0].faculty_id).toBeNull(); // never silently linked, same as the grad_student direction above
  });

  // Idempotency: re-running the SAME unconfirmed candidate against a row it
  // already produced must not change anything (no duplicate write target,
  // no drifting role_set_at, no re-derived role).
  it("idempotent: re-merging the identical unconfirmed candidate against the row it already produced changes nothing", () => {
    const existing = [
      { ...author({ name: "Zhu, Y.", role: "unknown", faculty_id: 42, role_set_by: "ingest:unconfirmed_name_match_conflicting_affiliation", role_set_at: "2026-07-16T00:00:00.000Z", position: 0 }), id: 5 },
    ];
    const incoming: AuthorInput[] = [
      author({ name: "Zhu, Y.", role: "unknown", faculty_id: 42, role_set_by: "ingest:unconfirmed_name_match_conflicting_affiliation", role_set_at: "2026-07-21T00:00:00.000Z", position: 0 }),
    ];

    const merged = mergeAuthors(existing, incoming, "crossref");

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ role: "unknown", faculty_id: 42, role_set_by: "ingest:unconfirmed_name_match_conflicting_affiliation" });
    // Neither branch in mergeAuthors fires for this pair (role isn't
    // 'unknown'->'chps_faculty', and faculty_id is already non-null on both
    // sides) — the existing row's own role_set_at is left untouched, not
    // overwritten by the re-run's fresher timestamp.
    expect(merged[0].role_set_at).toBe("2026-07-16T00:00:00.000Z");
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

  // §13 item 10 regression: two different sources (e.g. ORCID's own author
  // data vs. PubMed's) can format the same name slightly differently and
  // fail the name-match check, so a genuinely-new incoming author's own
  // position (copied verbatim from its source list, e.g. 0) can collide
  // with a position ALREADY taken in the existing merged list — violating
  // publication_authors' UNIQUE(publication_id, position) constraint on
  // insert. Confirmed live: ORCID inserts a 1-author stub at position 0;
  // PubMed's later merge for the same paper has its own author at its own
  // list-index 0, which doesn't name-match the existing entry.
  it("a genuinely new author is appended at a free position, never colliding with an existing author's position", () => {
    const existing = [{ ...author({ name: "Stock, M.", role: "chps_faculty", faculty_id: 1, position: 0 }), id: 1 }];
    // "Stock, M.S." deliberately does NOT name-match "Stock, M." above (a
    // different source formatted the initials more fully) — so it's a
    // genuinely new author from mergeAuthors' point of view, carrying its
    // own source list's position: 0, same as the ALREADY-occupied slot.
    const incoming: AuthorInput[] = [author({ name: "Stock, M.S.", role: "unknown", position: 0 })];

    const merged = mergeAuthors(existing, incoming, "pubmed");

    expect(merged).toHaveLength(2);
    const positions = merged.map((a) => a.position);
    expect(new Set(positions).size).toBe(positions.length); // no two authors share a position
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

  // Session 21 (§13.24 operational backfill): 'manual' incoming already means
  // "passed a COMMS review gate" everywhere else in this codebase (§8c Tab 1
  // approvals) — a human-verified backfill reconcile is the same shape of
  // trust. Every OTHER source (crossref/pubmed/orcid/scholar) must keep the
  // narrower chps_faculty-only upgrade, since §15.4 forbids ingest from ever
  // assigning a student role on its own.
  describe("'manual' incoming source: the human-verified-backfill upgrade path", () => {
    it("upgrades unknown -> grad_student from a 'manual' incoming source", () => {
      const existing = [{ ...author({ name: "Torralba, L.", role: "unknown", position: 2 }), id: 1 }];
      const incoming: AuthorInput[] = [author({ name: "Torralba, L.", role: "grad_student", role_set_by: "manual:backfill-2025", position: 2 })];

      const merged = mergeAuthors(existing, incoming, "manual");

      expect(merged[0].role).toBe("grad_student");
      expect(merged[0].role_set_by).toBe("manual:backfill-2025");
    });

    it("upgrades unknown -> undergrad_student from a 'manual' incoming source", () => {
      const existing = [{ ...author({ name: "Sukhu, B.", role: "unknown", position: 0 }), id: 1 }];
      const incoming: AuthorInput[] = [author({ name: "Sukhu, B.", role: "undergrad_student", role_set_by: "manual:backfill-2025", position: 0 })];

      const merged = mergeAuthors(existing, incoming, "manual");

      expect(merged[0].role).toBe("undergrad_student");
    });

    it("upgrades unknown -> external from a 'manual' incoming source (a human confirming 'not CHPS', not just 'not yet reviewed')", () => {
      const existing = [{ ...author({ name: "Garcia, J.", role: "unknown", position: 1 }), id: 1 }];
      const incoming: AuthorInput[] = [author({ name: "Garcia, J.", role: "external", role_set_by: "manual:backfill-2025", position: 1 })];

      const merged = mergeAuthors(existing, incoming, "manual");

      expect(merged[0].role).toBe("external");
    });

    it("the SAME grad_student incoming role from crossref/pubmed/orcid/scholar does NOT upgrade unknown (§15.4: ingest never assigns student roles)", () => {
      for (const source of ["crossref", "pubmed", "orcid", "scholar"] as const) {
        const existing = [{ ...author({ name: "Torralba, L.", role: "unknown", position: 0 }), id: 1 }];
        const incoming: AuthorInput[] = [author({ name: "Torralba, L.", role: "grad_student", role_set_by: "somehow-set", position: 0 })];

        const merged = mergeAuthors(existing, incoming, source);

        expect(merged[0].role, `source=${source}`).toBe("unknown");
      }
    });

    it("a human-set role (faculty:/comms:) still survives a 'manual' merge — the isHumanSet guard applies regardless of incoming source", () => {
      const existing = [{ ...author({ name: "Zhu, Y.", role: "unknown", role_set_by: "comms:jsmith", position: 0 }), id: 1 }];
      const incoming: AuthorInput[] = [author({ name: "Zhu, Y.", role: "chps_faculty", faculty_id: 99, role_set_by: "manual:backfill-2025", position: 0 })];

      const merged = mergeAuthors(existing, incoming, "manual");

      expect(merged[0].role).toBe("unknown");
      expect(merged[0].role_set_by).toBe("comms:jsmith");
      expect(merged[0].faculty_id).toBeNull();
    });

    it("a 'manual' source can still add a genuinely new author (unlike scholar)", () => {
      const existing = [{ ...author({ name: "Zraick, R.I.", role: "chps_faculty", faculty_id: 1, position: 0 }), id: 1 }];
      const incoming: AuthorInput[] = [
        author({ name: "Zraick, R.I.", role: "chps_faculty", faculty_id: 1, position: 0 }),
        author({ name: "New Person, X.", role: "grad_student", role_set_by: "manual:backfill-2025", position: 1 }),
      ];

      const merged = mergeAuthors(existing, incoming, "manual");

      expect(merged).toHaveLength(2);
      expect(merged.find((a) => a.name === "New Person, X.")?.role).toBe("grad_student");
    });

    // The real production regression this session found: an existing
    // author formatted "Surname, X.M." (no internal space) must be
    // recognized as the SAME person as an incoming "Surname, X. M." (with a
    // space) — not appended as a duplicate. A real reconcile run hit this
    // exact shape and doubled an 11-author list to 22 before the fix below.
    it("does not duplicate an author whose only difference from an existing row is internal initial spacing", () => {
      const existing = [{ ...author({ name: "Lubiak, S.M.", role: "unknown", position: 0 }), id: 1 }];
      const incoming: AuthorInput[] = [author({ name: "Lubiak, S. M.", role: "grad_student", role_set_by: "manual:backfill-2025", position: 0 })];

      const merged = mergeAuthors(existing, incoming, "manual");

      expect(merged).toHaveLength(1); // not 2 — same person, not a duplicate
      expect(merged[0].role).toBe("grad_student");
    });

    // The other half of the fix's safety: it must not OVER-correct and
    // start merging genuinely different people who happen to share a
    // surname. Same three real cases as the normalizeAuthorName tests
    // above, exercised at the mergeAuthors level this time — an existing
    // "Anderson, A.W." row must stay untouched, and the incoming
    // "Anderson, K.M." must land as its own separate, new author.
    it("a real same-surname, different-person case (the Anderson collision) is never merged into one row", () => {
      const existing = [{ ...author({ name: "Anderson, A.W.", role: "chps_faculty", faculty_id: 10, role_set_by: "ingest", position: 0 }), id: 1 }];
      const incoming: AuthorInput[] = [author({ name: "Anderson, K.M.", role: "chps_faculty", faculty_id: 20, role_set_by: "manual:backfill-2025", position: 0 })];

      const merged = mergeAuthors(existing, incoming, "manual");

      expect(merged).toHaveLength(2);
      const original = merged.find((a) => a.name === "Anderson, A.W.")!;
      expect(original.faculty_id).toBe(10); // untouched, not overwritten by the incoming K.M. link
      const added = merged.find((a) => a.name === "Anderson, K.M.")!;
      expect(added.faculty_id).toBe(20);
    });
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
