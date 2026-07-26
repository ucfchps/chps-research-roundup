import { describe, expect, it } from "vitest";
import { parseFinalizeFormData, defaultCheckedPublicationIds, zeroUnitPublications } from "../app/admin/publications/finalize-shared";
import type { PublicationWithUnits } from "../lib/publications";

function baseForm(overrides: Record<string, string | string[]> = {}): FormData {
  const fields: Record<string, string | string[]> = {
    label: "Spring and Summer 2026",
    generatedBy: "Test User",
    cutoffDate: "2026-06-30",
    title: "Research Roundup",
    intro: "Intro.",
    legendLine: "Legend.",
    confirmText: "Spring and Summer 2026",
    publicationIds: ["1", "2"],
    ...overrides,
  };
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) fd.append(key, v);
  }
  return fd;
}

describe("parseFinalizeFormData", () => {
  it("parses a complete, correctly-confirmed form into FinalizeParams", () => {
    const result = parseFinalizeFormData(baseForm());

    expect(result).toEqual({
      params: {
        label: "Spring and Summer 2026",
        generatedBy: "Test User",
        cutoffDate: "2026-06-30",
        title: "Research Roundup",
        intro: "Intro.",
        legendLine: "Legend.",
        publicationIds: [1, 2],
      },
    });
  });

  it("errors when the confirmation text doesn't match the edition label exactly", () => {
    const result = parseFinalizeFormData(baseForm({ confirmText: "wrong text" }));
    expect(result).toHaveProperty("error");
  });

  it("errors when the confirmation text matches case-sensitively-different casing", () => {
    const result = parseFinalizeFormData(baseForm({ confirmText: "spring and summer 2026" }));
    expect(result).toHaveProperty("error");
  });

  it("errors when the label is missing", () => {
    const result = parseFinalizeFormData(baseForm({ label: "" }));
    expect(result).toHaveProperty("error");
  });

  it("errors when generatedBy is missing", () => {
    const result = parseFinalizeFormData(baseForm({ generatedBy: "" }));
    expect(result).toHaveProperty("error");
  });

  it("errors when cutoffDate is missing", () => {
    const result = parseFinalizeFormData(baseForm({ cutoffDate: "" }));
    expect(result).toHaveProperty("error");
  });

  it("errors when no publications are checked", () => {
    const result = parseFinalizeFormData(baseForm({ publicationIds: [] }));
    expect(result).toHaveProperty("error");
  });

  it("parses acknowledgedZeroUnitIds when the form includes them (Session 22, Bug 2)", () => {
    const result = parseFinalizeFormData(baseForm({ publicationIds: ["1", "2", "3"], acknowledgedZeroUnitIds: ["3"] }));
    expect(result).toEqual({
      params: {
        label: "Spring and Summer 2026",
        generatedBy: "Test User",
        cutoffDate: "2026-06-30",
        title: "Research Roundup",
        intro: "Intro.",
        legendLine: "Legend.",
        publicationIds: [1, 2, 3],
        acknowledgedZeroUnitIds: [3],
      },
    });
  });
});

function pub(overrides: { id: number; title?: string; unitsCount: number }): PublicationWithUnits {
  return {
    publication: { id: overrides.id, title: overrides.title ?? `Paper ${overrides.id}` } as PublicationWithUnits["publication"],
    authors: [],
    units: overrides.unitsCount > 0 ? (Array(overrides.unitsCount).fill("Department of Health Sciences") as PublicationWithUnits["units"]) : [],
    ready: true,
  };
}

describe("defaultCheckedPublicationIds (Session 22, Bug 2 — §15.11)", () => {
  it("excludes zero-unit publications by default; includes everything else", () => {
    const results = [pub({ id: 1, unitsCount: 1 }), pub({ id: 2, unitsCount: 0 }), pub({ id: 3, unitsCount: 2 })];
    expect(defaultCheckedPublicationIds(results)).toEqual([1, 3]);
  });

  it("returns an empty array when every result is zero-unit", () => {
    const results = [pub({ id: 1, unitsCount: 0 }), pub({ id: 2, unitsCount: 0 })];
    expect(defaultCheckedPublicationIds(results)).toEqual([]);
  });
});

describe("zeroUnitPublications (Session 22, Bug 2)", () => {
  it("returns only the zero-unit publications, in original order", () => {
    const results = [pub({ id: 1, unitsCount: 1 }), pub({ id: 2, unitsCount: 0, title: "Orphan" }), pub({ id: 3, unitsCount: 0, title: "Also Orphan" })];
    expect(zeroUnitPublications(results).map((r) => r.publication.id)).toEqual([2, 3]);
  });

  it("returns an empty array when nothing is zero-unit", () => {
    const results = [pub({ id: 1, unitsCount: 1 })];
    expect(zeroUnitPublications(results)).toEqual([]);
  });
});
