import { describe, expect, it } from "vitest";
import {
  buildAuthorInputs,
  decideArticleOutcome,
  matchAuthorNameToFaculty,
  resolveDiscoveringFaculty,
  type CrossrefOutcome,
  type DiscoveredArticle,
  type ExistingMatch,
} from "../lib/scholar-ingest";
import type { Faculty } from "../lib/types";

function faculty(overrides: Partial<Faculty>): Faculty {
  return {
    id: 1, wp_id: "1", slug: "x", display_name: "Doe, J.", full_name: "Jane Doe", email: "j@x.com",
    unit: "Department of Health Sciences", research_profile_url: null, scholar_user_id: "ABC123AAAAJ",
    orcid: null, classification: "Faculty", active: 1, last_alert_seen_at: null, last_synced_at: null,
    ...overrides,
  };
}

const ARTICLE: DiscoveredArticle = { title: "A Test Paper", year: 2026, scholarUrl: "https://scholar.google.com/scholar_url?url=x" };
const NOW = "2026-07-15T00:00:00.000Z";

describe("resolveDiscoveringFaculty — the §5a.3 join, case-sensitive exact match", () => {
  it("finds an active faculty row by exact scholar_user_id", () => {
    const roster = [faculty({ id: 1, scholar_user_id: "hs_VC0kAAAAJ" })];
    expect(resolveDiscoveringFaculty("hs_VC0kAAAAJ", roster)?.id).toBe(1);
  });

  it("an unmatched Scholar user ID returns null (never a fuzzy/case-insensitive match)", () => {
    const roster = [faculty({ id: 1, scholar_user_id: "hs_VC0kAAAAJ" })];
    expect(resolveDiscoveringFaculty("hs_vc0kaaaaj", roster)).toBeNull();
    expect(resolveDiscoveringFaculty("totally-unknown-id", roster)).toBeNull();
  });
});

describe("decideArticleOutcome — CrossrefUnavailableError produces retry_later, nothing persisted", () => {
  const unavailable: CrossrefOutcome = { kind: "unavailable", reason: "Crossref search returned 503" };

  it("from the resolved-but-then-errors direction", () => {
    const outcome = decideArticleOutcome(ARTICLE, faculty({}), unavailable, null, [], [], NOW);
    expect(outcome).toEqual({ kind: "retry_later", reason: "Crossref search returned 503" });
  });

  it("even when an existing match would otherwise have been found — unavailable always wins, never persisted", () => {
    const existingMatch: ExistingMatch = {
      id: 42,
      status: "pending_merge",
      metadata: { doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026, volume: "1", issue: "1", pages: "1-2", source: "crossref" },
      authors: [],
    };
    const outcome = decideArticleOutcome(ARTICLE, faculty({}), unavailable, existingMatch, [], [], NOW);
    expect(outcome.kind).toBe("retry_later");
  });
});

describe("decideArticleOutcome — a clean Crossref null (not found) produces needs_metadata", () => {
  it("when no existing record matches, and no similar-enough title exists either", () => {
    const outcome = decideArticleOutcome(ARTICLE, faculty({ id: 7 }), { kind: "not_found" }, null, [], [], NOW);

    expect(outcome.kind).toBe("insert_needs_metadata");
    if (outcome.kind !== "insert_needs_metadata") throw new Error("unreachable");
    expect(outcome.publication.status).toBe("needs_metadata");
    expect(outcome.publication.source).toBe("scholar");
    expect(outcome.publication.discovered_by_faculty_id).toBe(7);
    expect(outcome.publication.scholar_alert_url).toBe(ARTICLE.scholarUrl);
    expect(outcome.publication.title).toBe("A Test Paper");
    expect(outcome.publication.year).toBe(2026);
    expect(outcome.possibleDuplicateOf).toEqual([]);
  });

  it("no publication_authors rows are implied — insert_needs_metadata carries no authors field at all", () => {
    const outcome = decideArticleOutcome(ARTICLE, faculty({ id: 7 }), { kind: "not_found" }, null, [], [], NOW);
    if (outcome.kind !== "insert_needs_metadata") throw new Error("unreachable");
    expect("authors" in outcome).toBe(false);
  });

  it("a null Crossref result that DOES match an existing record is idempotent — merged, no new row", () => {
    const existingMatch: ExistingMatch = {
      id: 42,
      status: "needs_metadata",
      metadata: { doi: null, title: "A Test Paper", url: "https://scholar.google.com/x", journal: null, year: 2026, volume: null, issue: null, pages: null, source: "scholar" },
      authors: [],
    };
    const outcome = decideArticleOutcome(ARTICLE, faculty({ id: 7 }), { kind: "not_found" }, existingMatch, [], [], NOW);

    expect(outcome).toMatchObject({ kind: "merged", publicationId: 42 });
    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.missingJournal).toBe(true); // existingMatch.metadata.journal is null
  });

  it("a null Crossref result that DOES match an existing record with a journal already on file is not flagged", () => {
    const existingMatch: ExistingMatch = {
      id: 42,
      status: "needs_metadata",
      metadata: { doi: null, title: "A Test Paper", url: "https://scholar.google.com/x", journal: "J", year: 2026, volume: null, issue: null, pages: null, source: "scholar" },
      authors: [],
    };
    const outcome = decideArticleOutcome(ARTICLE, faculty({ id: 7 }), { kind: "not_found" }, existingMatch, [], [], NOW);

    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.missingJournal).toBe(false);
  });

  it("a not_found outcome never promotes a needs_metadata stub — Crossref found nothing new, so no promotion happens", () => {
    const existingMatch: ExistingMatch = {
      id: 42,
      status: "needs_metadata",
      metadata: { doi: null, title: "A Test Paper", url: "https://scholar.google.com/x", journal: null, year: 2026, volume: null, issue: null, pages: null, source: "scholar" },
      authors: [],
    };
    const outcome = decideArticleOutcome(ARTICLE, faculty({ id: 7 }), { kind: "not_found" }, existingMatch, [], [], NOW);

    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.status).toBe("needs_metadata");
    expect(outcome.firstSeenAt).toBeNull(); // no promotion -> first_seen_at must not be touched
  });
});

describe("decideArticleOutcome — ★ possible-duplicate surfacing on insert_needs_metadata (plan-review addendum)", () => {
  it("a drifted title that doesn't exact-match but shares most significant tokens with an existing record is flagged, not silently duplicated", () => {
    // Mirrors the real §15.8 case: one co-author's alert resolves via
    // Crossref to a slightly different title wording than the other
    // co-author's still-unresolved Scholar title. findMatch (exact title/DOI)
    // correctly returns NEEDS_FUZZY here — this is a SEPARATE, deterministic,
    // non-blocking check layered on top, not a change to findMatch itself.
    const existing = [{ id: 99, doi: null, title_normalized: "acute and chronic effects of resistance training on tendon stiffness" }];
    const article = { title: "Acute Compared to Chronic Effects of Resistance Training on Tendon Stiffness", year: 2026, scholarUrl: "https://scholar.google.com/x" };

    const outcome = decideArticleOutcome(article, faculty({ id: 7 }), { kind: "not_found" }, null, existing, [], NOW);

    if (outcome.kind !== "insert_needs_metadata") throw new Error("unreachable");
    expect(outcome.possibleDuplicateOf).toEqual([99]);
  });

  it("still inserts (never blocks) even when flagged as a possible duplicate", () => {
    const existing = [{ id: 99, doi: null, title_normalized: "acute and chronic effects of resistance training on tendon stiffness" }];
    const article = { title: "Acute Compared to Chronic Effects of Resistance Training on Tendon Stiffness", year: 2026, scholarUrl: "https://scholar.google.com/x" };

    const outcome = decideArticleOutcome(article, faculty({ id: 7 }), { kind: "not_found" }, null, existing, [], NOW);

    expect(outcome.kind).toBe("insert_needs_metadata");
  });

  it("an unrelated existing title is never flagged", () => {
    const existing = [{ id: 5, doi: null, title_normalized: "a completely different study about balance and falls in older adults" }];
    const outcome = decideArticleOutcome(ARTICLE, faculty({ id: 7 }), { kind: "not_found" }, null, existing, [], NOW);

    if (outcome.kind !== "insert_needs_metadata") throw new Error("unreachable");
    expect(outcome.possibleDuplicateOf).toEqual([]);
  });

  it("a short/generic candidate title sharing its few tokens with an unrelated, much longer title is NOT flagged — true Jaccard, not the overlap coefficient", () => {
    // Regression for the min()-based overlap coefficient bug: candidate has
    // only 3 significant tokens (effects/resistance/training), all of which
    // also appear in this unrelated, 14-significant-token title about a
    // completely different population/outcome. shared=3, so shared/min(3,14)
    // = 1.0 (would have falsely flagged), but shared/union(3+14-3=14) = 0.21,
    // correctly below threshold — these are two different papers that just
    // share generic exercise-science vocabulary.
    const existing = [
      { id: 5, doi: null, title_normalized: "long term resistance training effects on bone density cardiovascular health outcomes in postmenopausal women with diabetes" },
    ];
    const article = { title: "Effects of Resistance Training", year: 2026, scholarUrl: "https://scholar.google.com/x" };

    const outcome = decideArticleOutcome(article, faculty({ id: 7 }), { kind: "not_found" }, null, existing, [], NOW);

    if (outcome.kind !== "insert_needs_metadata") throw new Error("unreachable");
    expect(outcome.possibleDuplicateOf).toEqual([]);
  });
});

describe("decideArticleOutcome — an unmatched Scholar author never reaches this function; it's the caller's job to short-circuit via resolveDiscoveringFaculty", () => {
  it("documented, not re-tested here (see the resolveDiscoveringFaculty suite above)", () => {
    expect(true).toBe(true);
  });
});

describe("decideArticleOutcome — a resolved Crossref hit with no existing match inserts a full record", () => {
  it("builds publication + full author list, tagging the discovering faculty as chps_faculty when their name matches", () => {
    const resolution = {
      doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      // Doe carries a UCF-confirming affiliation — this test's point is a
      // genuinely confirmed match (ops-notes.md §5/§6), not merely a name hit.
      authors: [{ name: "Doe, J.", position: 0, affiliation: "University of Central Florida" }, { name: "Smith, R.", position: 1 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, null, [], roster, NOW);

    expect(outcome.kind).toBe("insert_resolved");
    if (outcome.kind !== "insert_resolved") throw new Error("unreachable");
    expect(outcome.publication.status).toBe("pending_merge");
    expect(outcome.publication.source).toBe("crossref");
    expect(outcome.publication.discovered_by_faculty_id).toBe(7);
    expect(outcome.authors).toEqual([
      { name: "Doe, J.", faculty_id: 7, role: "chps_faculty", role_set_by: "ingest", role_set_at: NOW, position: 0, affiliation: "University of Central Florida" },
      { name: "Smith, R.", faculty_id: null, role: "unknown", role_set_by: null, role_set_at: null, position: 1, affiliation: undefined },
    ]);
    expect(outcome.discoveringFacultyLinked).toBe(true);
    expect(outcome.possibleDuplicateOf).toEqual([]); // nothing similar in `existing` ([])
    expect(outcome.missingJournal).toBe(false); // journal: "J" is present
  });

  it("★ a Crossref resolution with no container-title flags missingJournal, but still inserts (non-blocking)", () => {
    // extractJournal (lib/crossref.ts) returns null when Crossref has
    // neither container-title nor short-container-title — a legitimate,
    // non-error outcome (e.g. ahead-of-print records). This must never
    // block the insert, only surface in the run summary.
    const resolution = {
      doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: null, year: 2026,
      volume: null, issue: null, pages: null, type: "journal-article",
      authors: [{ name: "Doe, J.", position: 0 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, null, [], roster, NOW);

    expect(outcome.kind).toBe("insert_resolved");
    if (outcome.kind !== "insert_resolved") throw new Error("unreachable");
    expect(outcome.missingJournal).toBe(true);
    expect(outcome.publication.status).toBe("pending_merge"); // not blocked
  });

  it("★ the discovering faculty's own name failing to match the roster is counted, not papered over", () => {
    const resolution = {
      doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      authors: [{ name: "Doerr, J.", position: 0 }], // Crossref's hyphenation/spelling disagrees with the roster
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, null, [], roster, NOW);

    if (outcome.kind !== "insert_resolved") throw new Error("unreachable");
    expect(outcome.discoveringFacultyLinked).toBe(false);
    expect(outcome.authors.every((a) => a.role === "unknown")).toBe(true);
  });
});

describe("decideArticleOutcome — ★ possible-duplicate surfacing mirrored onto insert_resolved (plan-review round 2)", () => {
  it("a resolved alert flags an earlier needs_metadata stub for the same paper — the stub is never left orphaned", () => {
    // The scenario from the review comment: Faculty A's alert produced a
    // needs_metadata stub with a title-drifted wording (Crossref not_found
    // at the time — some other resolver call, not modeled here). Faculty
    // B's alert for the SAME paper now resolves cleanly via Crossref. This
    // resolved insert must flag the stub, not silently create a second,
    // disconnected record.
    const resolution = {
      doi: "10.1/y", title: "Acute and Chronic Effects of Resistance Training on Tendon Stiffness", url: "https://doi.org/10.1/y", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      authors: [{ name: "Doe, J.", position: 0 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];
    const existing = [{ id: 99, doi: null, title_normalized: "acute compared to chronic effects of resistance training on tendon stiffness" }];

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, null, existing, roster, NOW);

    expect(outcome.kind).toBe("insert_resolved");
    if (outcome.kind !== "insert_resolved") throw new Error("unreachable");
    expect(outcome.possibleDuplicateOf).toEqual([99]);
  });

  it("still inserts (never blocks, never auto-merges) even when flagged", () => {
    const resolution = {
      doi: "10.1/y", title: "Acute and Chronic Effects of Resistance Training on Tendon Stiffness", url: "https://doi.org/10.1/y", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      authors: [{ name: "Doe, J.", position: 0 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];
    const existing = [{ id: 99, doi: null, title_normalized: "acute compared to chronic effects of resistance training on tendon stiffness" }];

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, null, existing, roster, NOW);

    expect(outcome.kind).toBe("insert_resolved"); // not merged into 99 — that's a human call
  });
});

describe("decideArticleOutcome — a resolved Crossref hit that matches an existing record merges (§7)", () => {
  it("two alerts for the same paper converge: existing authors are preserved, faculty_id set via mergeAuthors' upgrade rule", () => {
    const resolution = {
      doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      // Smith's own incoming affiliation now confirms UCF — this test's point
      // is mergeAuthors' unknown->chps_faculty upgrade path specifically
      // (ops-notes.md §5/§6: that upgrade requires a genuinely confirmed
      // incoming match, not merely a name hit).
      authors: [{ name: "Doe, J.", position: 0 }, { name: "Smith, R.", position: 1, affiliation: "University of Central Florida" }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." }), faculty({ id: 8, display_name: "Smith, R.", scholar_user_id: "XYZ789AAAAJ" })];
    const existingMatch: ExistingMatch = {
      id: 42,
      status: "pending_merge",
      metadata: { doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026, volume: "1", issue: "1", pages: "1-2", source: "crossref" },
      authors: [
        { id: 1, name: "Doe, J.", faculty_id: 7, role: "chps_faculty", role_set_by: "ingest", role_set_at: NOW, position: 0 },
        { id: 2, name: "Smith, R.", faculty_id: null, role: "unknown", role_set_by: null, role_set_at: null, position: 1 },
      ],
    };

    // Second alert arrives from Smith
    const outcome = decideArticleOutcome(ARTICLE, roster[1], { kind: "resolved", resolution }, existingMatch, [], roster, NOW);

    expect(outcome.kind).toBe("merged");
    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.publicationId).toBe(42);
    expect(outcome.authors.find((a) => a.name === "Smith, R.")).toMatchObject({ faculty_id: 8, role: "chps_faculty" });
    expect(outcome.discoveringFacultyLinked).toBe(true);
    expect(outcome.missingJournal).toBe(false); // journal: "J" survives the merge
  });

  it("★ a merge that ends up with no journal name flags missingJournal, but the promotion still proceeds (non-blocking)", () => {
    // Same class of gap as insert_resolved's own null-journal case, but on
    // the merge path: neither the existing needs_metadata stub nor the
    // incoming Crossref resolution has a journal name, so mergeMetadata
    // produces a merged record with journal: null. Must not block the
    // promotion to pending_merge.
    const resolution = {
      doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: null, year: 2026,
      volume: null, issue: null, pages: null, type: "journal-article",
      authors: [{ name: "Doe, J.", position: 0 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];
    const existingMatch: ExistingMatch = {
      id: 42,
      status: "needs_metadata",
      metadata: { doi: null, title: "A Test Paper", url: "https://scholar.google.com/x", journal: null, year: 2026, volume: null, issue: null, pages: null, source: "scholar" },
      authors: [{ id: 1, name: "Doe, J.", faculty_id: null, role: "unknown", role_set_by: null, role_set_at: null, position: 0 }],
    };

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, existingMatch, [], roster, NOW);

    expect(outcome.kind).toBe("merged");
    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.missingJournal).toBe(true);
    expect(outcome.status).toBe("pending_merge"); // still promoted, not blocked
  });

  it("a human-set role survives the merge (§15.4 — mergeAuthors' own guarantee, exercised here)", () => {
    const resolution = {
      doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      authors: [{ name: "Doe, J.", position: 0 }, { name: "Grad, S.", position: 1 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];
    const existingMatch: ExistingMatch = {
      id: 42,
      status: "pending_merge",
      metadata: { doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026, volume: "1", issue: "1", pages: "1-2", source: "crossref" },
      authors: [
        { id: 1, name: "Doe, J.", faculty_id: 7, role: "chps_faculty", role_set_by: "ingest", role_set_at: NOW, position: 0 },
        { id: 2, name: "Grad, S.", faculty_id: null, role: "grad_student", role_set_by: "faculty:7", role_set_at: NOW, position: 1 },
      ],
    };

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, existingMatch, [], roster, NOW);

    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.authors.find((a) => a.name === "Grad, S.")).toMatchObject({ role: "grad_student", role_set_by: "faculty:7" });
  });

  it("★ the discovering faculty's own name failing to match the roster is counted on the merge path too, not just insert_resolved", () => {
    // Mirrors the insert_resolved "Doerr, J." vs. roster "Doe, J." mismatch
    // case above, but for the merged outcome: neither the existing record's
    // author list nor the incoming Crossref author list link faculty_id 7
    // anywhere, because Crossref's own spelling of the discovering faculty's
    // name doesn't match the roster. discoveringFacultyLinked must reflect
    // that miss, not silently report true just because a merge happened.
    const resolution = {
      doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      authors: [{ name: "Doerr, J.", position: 0 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];
    const existingMatch: ExistingMatch = {
      id: 42,
      status: "pending_merge",
      metadata: { doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026, volume: "1", issue: "1", pages: "1-2", source: "crossref" },
      authors: [
        { id: 1, name: "Doerr, J.", faculty_id: null, role: "unknown", role_set_by: null, role_set_at: null, position: 0 },
      ],
    };

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, existingMatch, [], roster, NOW);

    expect(outcome.kind).toBe("merged");
    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.discoveringFacultyLinked).toBe(false);
  });

  it("★ a resolved Crossref hit promotes a needs_metadata stub to pending_merge once it actually gets a DOI (post-plan holistic-review fix)", () => {
    // The bug this fix addresses: a needs_metadata stub created because
    // Crossref had nothing at the time later gets matched by a NEW alert
    // that DOES resolve via Crossref. Without this promotion, the row gets
    // a real DOI, full metadata, and linked authors but stays
    // needs_metadata forever — silently excluded from the merge-buffer ->
    // roundup pipeline (§15.11).
    const resolution = {
      doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      authors: [{ name: "Doe, J.", position: 0 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];
    const existingMatch: ExistingMatch = {
      id: 42,
      status: "needs_metadata",
      metadata: { doi: null, title: "A Test Paper", url: "https://scholar.google.com/x", journal: null, year: 2026, volume: null, issue: null, pages: null, source: "scholar" },
      authors: [{ id: 1, name: "Doe, J.", faculty_id: null, role: "unknown", role_set_by: null, role_set_at: null, position: 0 }],
    };

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, existingMatch, [], roster, NOW);

    expect(outcome.kind).toBe("merged");
    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.status).toBe("pending_merge");
    // §7: a stub can sit in needs_metadata for weeks before this promotion
    // happens. Without a fresh first_seen_at, the promoted record would skip
    // the merge buffer outright — release-buffer would see it as already far
    // past MERGE_BUFFER_HOURS and release it on its very next run.
    expect(outcome.firstSeenAt).toBe(NOW);
  });

  it("a resolved Crossref hit merging into an already pending_merge record leaves status untouched (no double-promotion)", () => {
    const resolution = {
      doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      authors: [{ name: "Doe, J.", position: 0 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];
    const existingMatch: ExistingMatch = {
      id: 42,
      status: "pending_merge",
      metadata: { doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026, volume: "1", issue: "1", pages: "1-2", source: "crossref" },
      authors: [{ id: 1, name: "Doe, J.", faculty_id: 7, role: "chps_faculty", role_set_by: "ingest", role_set_at: NOW, position: 0 }],
    };

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, existingMatch, [], roster, NOW);

    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.status).toBe("pending_merge");
    expect(outcome.firstSeenAt).toBeNull(); // already pending_merge -> no promotion -> untouched
  });

  it("a resolved Crossref hit merging into an already published record never touches its status — a published record is permanently settled (§6b)", () => {
    const resolution = {
      doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      authors: [{ name: "Doe, J.", position: 0 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];
    const existingMatch: ExistingMatch = {
      id: 42,
      status: "published",
      metadata: { doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026, volume: "1", issue: "1", pages: "1-2", source: "crossref" },
      authors: [{ id: 1, name: "Doe, J.", faculty_id: 7, role: "chps_faculty", role_set_by: "ingest", role_set_at: NOW, position: 0 }],
    };

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, existingMatch, [], roster, NOW);

    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.status).toBe("published");
    expect(outcome.firstSeenAt).toBeNull(); // already settled -> no promotion -> untouched
  });
});

// ops-notes.md §5/§6 follow-up: matchAuthorNameToFaculty alone (family +
// first initial) is not identity confirmation — a real wrong link (Zhu, Y.)
// shipped to production from exactly this gap. This is the shared,
// structural gate every ingester routes through via buildAuthorInputs,
// replacing scripts/ingest-crossref.ts's now-retired flagNameOnlyMatches
// (which only ever logged the same risk, never blocked the write).
describe("buildAuthorInputs — the shared confirmation gate (ops-notes.md §5/§6)", () => {
  const NOW2 = "2026-07-21T00:00:00.000Z";

  it("name match + affiliation corroborates UCF -> chps_faculty, role_set_by='ingest' (today's confirmed-match behavior, unchanged)", () => {
    const roster = [faculty({ id: 7, display_name: "Zraick, R.I." })];
    const authors = [{ name: "Zraick, R.I.", position: 0, affiliation: "University of Central Florida, Orlando, FL" }];

    const result = buildAuthorInputs(authors, roster, NOW2);

    expect(result).toEqual([
      { name: "Zraick, R.I.", faculty_id: 7, role: "chps_faculty", role_set_by: "ingest", role_set_at: NOW2, position: 0, affiliation: "University of Central Florida, Orlando, FL" },
    ]);
  });

  it("name match, no affiliation data at all -> unknown, faculty_id preserved as a reviewable hint, role_set_by='ingest:unconfirmed_name_match'", () => {
    // The exact shape of a PubMed-sourced author (esummary has no per-author
    // affiliation field at all) and of a Crossref record with a genuinely
    // empty affiliation array (§5: "inconsistently populated").
    const roster = [faculty({ id: 7, display_name: "Zraick, R.I." })];
    const authors = [{ name: "Zraick, R.I.", position: 0 }]; // no `affiliation` key at all

    const result = buildAuthorInputs(authors, roster, NOW2);

    expect(result).toEqual([
      { name: "Zraick, R.I.", faculty_id: 7, role: "unknown", role_set_by: "ingest:unconfirmed_name_match", role_set_at: NOW2, position: 0, affiliation: undefined },
    ]);
  });

  it("name match, affiliation present but does NOT mention UCF -> unknown, distinct role_set_by tag ('conflicting_affiliation') — stronger negative evidence than no data at all, must not look identical to it", () => {
    // The confirmed real case this whole fix pack exists for: a "Zhu, Y."
    // match whose actual Crossref affiliation was unrelated-field
    // (embedded systems, quantum computing, etc.) — real evidence the name
    // match is wrong, not merely unconfirmed.
    const roster = [faculty({ id: 7, display_name: "Zhu, Y." })];
    const authors = [{ name: "Zhu, Y.", position: 0, affiliation: "Department of Ophthalmology, University of Pennsylvania" }];

    const result = buildAuthorInputs(authors, roster, NOW2);

    expect(result).toEqual([
      {
        name: "Zhu, Y.", faculty_id: 7, role: "unknown", role_set_by: "ingest:unconfirmed_name_match_conflicting_affiliation",
        role_set_at: NOW2, position: 0, affiliation: "Department of Ophthalmology, University of Pennsylvania",
      },
    ]);
  });

  it("the two unconfirmed buckets are genuinely distinguishable, not just differently-worded", () => {
    const roster = [faculty({ id: 7, display_name: "Zhu, Y." })];
    const noData = buildAuthorInputs([{ name: "Zhu, Y.", position: 0 }], roster, NOW2);
    const conflicting = buildAuthorInputs([{ name: "Zhu, Y.", position: 0, affiliation: "Unrelated University" }], roster, NOW2);

    expect(noData[0].role_set_by).not.toBe(conflicting[0].role_set_by);
    expect(noData[0].role).toBe("unknown");
    expect(conflicting[0].role).toBe("unknown");
  });

  it("no name match at all -> unknown, faculty_id null, role_set_by null (unchanged — this is a stranger, not an unconfirmed roster member)", () => {
    const roster = [faculty({ id: 7, display_name: "Zraick, R.I." })];
    const authors = [{ name: "Nobody, N.", position: 0, affiliation: "University of Central Florida" }];

    const result = buildAuthorInputs(authors, roster, NOW2);

    expect(result).toEqual([{ name: "Nobody, N.", faculty_id: null, role: "unknown", role_set_by: null, role_set_at: null, position: 0, affiliation: "University of Central Florida" }]);
  });
});

describe("matchAuthorNameToFaculty", () => {
  it("matches on normalized family name + first initial", () => {
    const roster = [faculty({ id: 1, display_name: "Ploutz-Snyder, L." })];
    expect(matchAuthorNameToFaculty("Ploutz-Snyder, L.", roster)?.id).toBe(1);
  });

  it("does not match a different family name sharing an initial", () => {
    const roster = [faculty({ id: 1, display_name: "Stock, M.S." })];
    expect(matchAuthorNameToFaculty("Stark, M.S.", roster)).toBeNull();
  });

  it("an author name with no comma (organizational author) never matches, never throws", () => {
    const roster = [faculty({ id: 1, display_name: "Doe, J." })];
    expect(() => matchAuthorNameToFaculty("World Health Organization", roster)).not.toThrow();
    expect(matchAuthorNameToFaculty("World Health Organization", roster)).toBeNull();
  });
});
