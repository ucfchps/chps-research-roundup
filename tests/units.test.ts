// Ground truth: master plan (amended §6) and docs/wp-directory-notes.md §5 —
// the term-ID -> canonical-unit map, verified against the live directory.
import { describe, expect, it } from "vitest";
import { unitForDepartmentTerms } from "../lib/units";

describe("unitForDepartmentTerms", () => {
  it("Kinesiology (204) + Exercise Physiology (442, not a unit) -> KRS", () => {
    expect(unitForDepartmentTerms([204, 442])).toEqual({
      unit: "School of Kinesiology and Rehabilitation Sciences",
      reason: "ok",
    });
  });

  it("CSD (166) + Dean's Office (71, not a unit) -> CSD", () => {
    expect(unitForDepartmentTerms([166, 71])).toEqual({
      unit: "School of Communication Sciences and Disorders",
      reason: "ok",
    });
  });

  it("Dean's Office only (71) -> null, reason 'no canonical unit'", () => {
    expect(unitForDepartmentTerms([71])).toEqual({
      unit: null,
      reason: "no canonical unit",
    });
  });

  it("empty array -> null, reason 'no canonical unit'", () => {
    expect(unitForDepartmentTerms([])).toEqual({
      unit: null,
      reason: "no canonical unit",
    });
  });

  it("Physical Therapy (239) -> KRS", () => {
    expect(unitForDepartmentTerms([239])).toEqual({
      unit: "School of Kinesiology and Rehabilitation Sciences",
      reason: "ok",
    });
  });

  it("Athletic Training (253) -> KRS", () => {
    expect(unitForDepartmentTerms([253])).toEqual({
      unit: "School of Kinesiology and Rehabilitation Sciences",
      reason: "ok",
    });
  });

  it("Health Sciences (232) -> Department of Health Sciences", () => {
    expect(unitForDepartmentTerms([232])).toEqual({
      unit: "Department of Health Sciences",
      reason: "ok",
    });
  });

  it("Social Work (83) -> School of Social Work", () => {
    expect(unitForDepartmentTerms([83])).toEqual({
      unit: "School of Social Work",
      reason: "ok",
    });
  });

  it("CARD (439) -> Center for Autism and Related Disabilities", () => {
    expect(unitForDepartmentTerms([439])).toEqual({
      unit: "Center for Autism and Related Disabilities",
      reason: "ok",
    });
  });

  it("two DIFFERENT canonical units -> null, reason names both, and never picks the first term", () => {
    // Term array order must not matter — CSD listed after Health Sciences here,
    // reversed from the term-ID numeric order, to prove order isn't load-bearing.
    const result = unitForDepartmentTerms([232, 166]);
    expect(result.unit).toBeNull();
    expect(result.reason).toContain("ambiguous");
    expect(result.reason).toContain("Department of Health Sciences");
    expect(result.reason).toContain("School of Communication Sciences and Disorders");
  });

  it("Physical Therapy (239) + Athletic Training (253) both map to KRS -> ok, not ambiguous", () => {
    // Two terms mapping to the SAME canonical unit is a single match, not two.
    expect(unitForDepartmentTerms([239, 253])).toEqual({
      unit: "School of Kinesiology and Rehabilitation Sciences",
      reason: "ok",
    });
  });

  it("only non-roundup terms (Dean's Office, TATS, UCF IT) -> no canonical unit", () => {
    expect(unitForDepartmentTerms([71, 1208, 519])).toEqual({
      unit: null,
      reason: "no canonical unit",
    });
  });
});
