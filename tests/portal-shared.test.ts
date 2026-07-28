import { describe, expect, it } from "vitest";
import { parsePortalSubmitFormData } from "../app/portal-shared";

function baseForm(overrides: Record<string, string | string[]> = {}): FormData {
  const fields: Record<string, string | string[]> = {
    submittedBy: "Jane Submitter",
    title: "A New Paper",
    url: "https://example.com/paper",
    authorName: "Stock, M.",
    authorRole: "chps_faculty",
    ...overrides,
  };
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) fd.append(key, v);
  }
  return fd;
}

describe("parsePortalSubmitFormData", () => {
  it("parses a complete, valid submission", () => {
    const result = parsePortalSubmitFormData(baseForm());

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.submittedBy).toBe("Jane Submitter");
    expect(result.submission.title).toBe("A New Paper");
    expect(result.submission.authors).toEqual([{ name: "Stock, M.", role: "chps_faculty" }]);
  });

  it("★ honeypot: a filled 'website' field returns kind='spam', never an error", () => {
    const result = parsePortalSubmitFormData(baseForm({ website: "http://spam.example.com" }));

    expect(result).toEqual({ kind: "spam" });
  });

  it("a genuinely empty honeypot is not spam", () => {
    const result = parsePortalSubmitFormData(baseForm({ website: "" }));

    expect(result.kind).toBe("valid");
  });

  it("requires submittedBy", () => {
    const result = parsePortalSubmitFormData(baseForm({ submittedBy: "" }));

    expect(result).toEqual({ kind: "invalid", error: "Your name is required." });
  });

  it("requires title", () => {
    const result = parsePortalSubmitFormData(baseForm({ title: "" }));

    expect(result).toEqual({ kind: "invalid", error: "Title is required." });
  });

  it("requires url", () => {
    const result = parsePortalSubmitFormData(baseForm({ url: "" }));

    expect(result).toEqual({ kind: "invalid", error: "Link is required." });
  });

  it("requires at least one author", () => {
    const result = parsePortalSubmitFormData(baseForm({ authorName: "", authorRole: "chps_faculty" }));

    expect(result).toEqual({ kind: "invalid", error: "At least one author is required." });
  });

  it("rejects an unrecognized role", () => {
    const result = parsePortalSubmitFormData(baseForm({ authorRole: "not_a_real_role" }));

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.error).toMatch(/unrecognized role/i);
  });

  it("parses multiple author rows in order", () => {
    const result = parsePortalSubmitFormData(
      baseForm({ authorName: ["First, A.", "Second, B."], authorRole: ["chps_faculty", "grad_student"] })
    );

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.submission.authors).toEqual([
      { name: "First, A.", role: "chps_faculty" },
      { name: "Second, B.", role: "grad_student" },
    ]);
  });

  it("skips a blank author row without erroring", () => {
    const result = parsePortalSubmitFormData(baseForm({ authorName: ["Stock, M.", ""], authorRole: ["chps_faculty", "external"] }));

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.submission.authors).toEqual([{ name: "Stock, M.", role: "chps_faculty" }]);
  });

  it("parses an optional note", () => {
    const result = parsePortalSubmitFormData(baseForm({ note: "Found this on the department newsletter" }));

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.note).toBe("Found this on the department newsletter");
  });

  it("defaults note to null when omitted", () => {
    const result = parsePortalSubmitFormData(baseForm());

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.note).toBeNull();
  });

  it("only accepts a real Unit value for unitHint, else null", () => {
    const withReal = parsePortalSubmitFormData(baseForm({ unitHint: "Department of Health Sciences" }));
    expect(withReal.kind).toBe("valid");
    if (withReal.kind === "valid") expect(withReal.submission.unitHint).toBe("Department of Health Sciences");

    const withGarbage = parsePortalSubmitFormData(baseForm({ unitHint: "Not A Real Unit" }));
    expect(withGarbage.kind).toBe("valid");
    if (withGarbage.kind === "valid") expect(withGarbage.submission.unitHint).toBeNull();
  });
});
