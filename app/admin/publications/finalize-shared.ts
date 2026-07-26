// Pure parsing/validation for the finalize form, split out of
// finalize-actions.ts because a "use server" file may only export async
// functions — this can't live there. Unit-testable without a DB; the actual
// write is covered by tests/roundup-finalize.test.ts.
import type { FinalizeParams } from "@/lib/roundup-finalize";
import type { PublicationWithUnits } from "@/lib/publications";

export interface FinalizeFormState {
  error: string | null;
  success: { roundupId: number; pubCount: number } | null;
}

export const initialFinalizeFormState: FinalizeFormState = { error: null, success: null };

export type ParsedFinalizeForm = { params: FinalizeParams } | { error: string };

// The server-side half of "type it back to confirm" — the client-side
// disabled-button check is UX friction only, never trusted on its own.
export function parseFinalizeFormData(formData: FormData): ParsedFinalizeForm {
  const label = String(formData.get("label") ?? "").trim();
  const generatedBy = String(formData.get("generatedBy") ?? "").trim();
  const cutoffDate = String(formData.get("cutoffDate") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const intro = String(formData.get("intro") ?? "").trim();
  const legendLine = String(formData.get("legendLine") ?? "").trim();
  const confirmText = String(formData.get("confirmText") ?? "").trim();
  const publicationIds = formData.getAll("publicationIds").map(Number);
  const acknowledgedZeroUnitIds = formData.getAll("acknowledgedZeroUnitIds").map(Number);

  if (!label || !generatedBy || !cutoffDate) {
    return { error: "Edition label, your name, and a cutoff date are all required." };
  }
  if (publicationIds.length === 0) {
    return { error: "No publications selected." };
  }
  if (confirmText !== label) {
    return { error: "The confirmation text didn't match the edition label exactly." };
  }

  return {
    params: {
      label,
      generatedBy,
      cutoffDate,
      title,
      intro,
      legendLine,
      publicationIds,
      ...(acknowledgedZeroUnitIds.length > 0 ? { acknowledgedZeroUnitIds } : {}),
    },
  };
}

// Session 22 (Bug 2, §15.11): a zero-unit publication (no linked CHPS
// faculty author, §6a) must never default into the checked/included set —
// that default is exactly the "gap that looks like a decision" §15.11
// exists to prevent. A human must deliberately opt one in.
export function defaultCheckedPublicationIds(results: PublicationWithUnits[]): number[] {
  return results.filter((r) => r.units.length > 0).map((r) => r.publication.id);
}

// Named explicitly (title + id) in the panel's warning banners — the same
// "never just a count" requirement the §8c Tab 4 pre-flight warnings already
// follow elsewhere.
export function zeroUnitPublications(results: PublicationWithUnits[]): PublicationWithUnits[] {
  return results.filter((r) => r.units.length === 0);
}
