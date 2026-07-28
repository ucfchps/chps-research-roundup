import { describe, expect, it } from "vitest";
import { seedDraftAuthors } from "../app/admin/pending-submissions/submission-shared";

describe("seedDraftAuthors — Tab 1's additive branch for the §8a public-portal payload shape", () => {
  it("seeds from payload.authors when present and non-empty (a portal submission)", () => {
    const result = seedDraftAuthors(
      { authors: [{ name: "Stock, M.", role: "chps_faculty" }, { name: "Doe, J.", role: "grad_student" }] },
      { name: "Fallback Submitter", role: "chps_faculty", facultyId: 42 }
    );

    expect(result).toEqual([
      { name: "Stock, M.", role: "chps_faculty", facultyId: null },
      { name: "Doe, J.", role: "grad_student", facultyId: null },
    ]);
  });

  it("falls back to the single-submitter row when payload.authors is absent (a review-page submission, unchanged today)", () => {
    const result = seedDraftAuthors({}, { name: "Stock, M.", role: "chps_faculty", facultyId: 7 });

    expect(result).toEqual([{ name: "Stock, M.", role: "chps_faculty", facultyId: 7 }]);
  });

  it("falls back to the single-submitter row when payload.authors is present but empty", () => {
    const result = seedDraftAuthors({ authors: [] }, { name: "Stock, M.", role: "chps_faculty", facultyId: 7 });

    expect(result).toEqual([{ name: "Stock, M.", role: "chps_faculty", facultyId: 7 }]);
  });

  it("preserves author order from payload.authors", () => {
    const result = seedDraftAuthors(
      { authors: [{ name: "Third, C.", role: "external" }, { name: "First, A.", role: "chps_faculty" }] },
      { name: "Fallback", role: "chps_faculty", facultyId: null }
    );

    expect(result.map((a) => a.name)).toEqual(["Third, C.", "First, A."]);
  });
});
