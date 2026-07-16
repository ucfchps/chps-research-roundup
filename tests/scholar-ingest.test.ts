import { describe, expect, it } from "vitest";
import {
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
      metadata: { doi: null, title: "A Test Paper", url: "https://scholar.google.com/x", journal: null, year: 2026, volume: null, issue: null, pages: null, source: "scholar" },
      authors: [],
    };
    const outcome = decideArticleOutcome(ARTICLE, faculty({ id: 7 }), { kind: "not_found" }, existingMatch, [], [], NOW);

    expect(outcome).toMatchObject({ kind: "merged", publicationId: 42 });
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
      authors: [{ name: "Doe, J.", position: 0 }, { name: "Smith, R.", position: 1 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, null, [], roster, NOW);

    expect(outcome.kind).toBe("insert_resolved");
    if (outcome.kind !== "insert_resolved") throw new Error("unreachable");
    expect(outcome.publication.status).toBe("pending_merge");
    expect(outcome.publication.source).toBe("crossref");
    expect(outcome.publication.discovered_by_faculty_id).toBe(7);
    expect(outcome.authors).toEqual([
      { name: "Doe, J.", faculty_id: 7, role: "chps_faculty", role_set_by: "ingest", role_set_at: NOW, position: 0 },
      { name: "Smith, R.", faculty_id: null, role: "unknown", role_set_by: null, role_set_at: null, position: 1 },
    ]);
    expect(outcome.discoveringFacultyLinked).toBe(true);
    expect(outcome.possibleDuplicateOf).toEqual([]); // nothing similar in `existing` ([])
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
      authors: [{ name: "Doe, J.", position: 0 }, { name: "Smith, R.", position: 1 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." }), faculty({ id: 8, display_name: "Smith, R.", scholar_user_id: "XYZ789AAAAJ" })];
    const existingMatch: ExistingMatch = {
      id: 42,
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
