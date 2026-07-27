// Pure parsing/validation for the un-stamp confirm form, split out of
// unstamp-actions.ts because a "use server" file may only export async
// functions — this can't live there. Unit-testable without a DB; the actual
// reversal is covered by tests/roundup-finalize.test.ts against
// lib/roundup-finalize.ts::unstampRoundup.
import type { UnstampSummary } from "@/lib/roundup-finalize";

export interface UnstampFormState {
  error: string | null;
  success: UnstampSummary | null;
}

export const initialUnstampFormState: UnstampFormState = { error: null, success: null };

export type ParsedUnstampForm = { roundupId: number } | { error: string };

// The server-side half of "type it back to confirm" — the client-side
// disabled-button check is UX friction only, never trusted on its own. Same
// shape as app/admin/publications/finalize-shared.ts::parseFinalizeFormData.
export function parseUnstampFormData(formData: FormData): ParsedUnstampForm {
  const roundupIdRaw = String(formData.get("roundupId") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  const confirmText = String(formData.get("confirmText") ?? "").trim();

  const roundupId = Number(roundupIdRaw);
  if (!roundupIdRaw || Number.isNaN(roundupId)) {
    return { error: "Missing or invalid roundup id." };
  }
  if (!label) {
    return { error: "Missing edition label." };
  }
  if (confirmText !== label) {
    return { error: "The confirmation text didn't match the edition label exactly." };
  }

  return { roundupId };
}
