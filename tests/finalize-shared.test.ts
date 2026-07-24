import { describe, expect, it } from "vitest";
import { parseFinalizeFormData } from "../app/admin/publications/finalize-shared";

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
});
