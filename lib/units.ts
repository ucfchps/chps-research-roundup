// Pure department-term -> canonical-unit mapping. No I/O. See amended master
// plan §6 and docs/wp-directory-notes.md §5 for the term-ID ground truth.
import type { Unit } from "./types";

// Keyed on term ID, never on term name — the directory emits "&amp;" and curly
// apostrophes in names, and those drift. Terms not listed here (Dean's Office,
// Exercise Physiology & Rehabilitation Science, TATS, UCF IT, ...) are real
// department terms that are deliberately not roundup units — never guess a
// mapping for them.
const DEPARTMENT_TERM_TO_UNIT: Record<number, Unit> = {
  166: "School of Communication Sciences and Disorders",
  232: "Department of Health Sciences",
  83: "School of Social Work",
  204: "School of Kinesiology and Rehabilitation Sciences",
  239: "School of Kinesiology and Rehabilitation Sciences",
  253: "School of Kinesiology and Rehabilitation Sciences",
  439: "Center for Autism and Related Disabilities",
};

export interface UnitResolution {
  unit: Unit | null;
  reason: string;
}

export function unitForDepartmentTerms(termIds: number[]): UnitResolution {
  const matched = new Set<Unit>();
  for (const termId of termIds) {
    const unit = DEPARTMENT_TERM_TO_UNIT[termId];
    if (unit) matched.add(unit);
  }

  if (matched.size === 0) return { unit: null, reason: "no canonical unit" };
  if (matched.size === 1) return { unit: [...matched][0], reason: "ok" };

  // Never take the first term — taxonomy array order is not meaningful.
  return { unit: null, reason: `ambiguous: ${[...matched].join(" + ")}` };
}
