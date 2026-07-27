import { describe, expect, it } from "vitest";
import { parseUnstampFormData } from "../app/admin/archive/unstamp-shared";

function baseForm(overrides: Record<string, string> = {}): FormData {
  const fields: Record<string, string> = {
    roundupId: "7",
    label: "Spring and Summer 2026",
    confirmText: "Spring and Summer 2026",
    ...overrides,
  };
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  return fd;
}

describe("parseUnstampFormData", () => {
  it("parses a complete, correctly-confirmed form", () => {
    expect(parseUnstampFormData(baseForm())).toEqual({ roundupId: 7 });
  });

  it("errors when the confirmation text doesn't match the edition label exactly", () => {
    expect(parseUnstampFormData(baseForm({ confirmText: "wrong text" }))).toHaveProperty("error");
  });

  it("errors when the confirmation text matches case-sensitively-different casing", () => {
    expect(parseUnstampFormData(baseForm({ confirmText: "spring and summer 2026" }))).toHaveProperty("error");
  });

  it("errors when roundupId is missing", () => {
    expect(parseUnstampFormData(baseForm({ roundupId: "" }))).toHaveProperty("error");
  });

  it("errors when roundupId is not a number", () => {
    expect(parseUnstampFormData(baseForm({ roundupId: "not-a-number" }))).toHaveProperty("error");
  });

  it("errors when label is missing", () => {
    expect(parseUnstampFormData(baseForm({ label: "" }))).toHaveProperty("error");
  });
});
