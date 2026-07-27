// Pure parsing/validation for the un-stamp confirm form, split out of
// unstamp-actions.ts because a "use server" file may only export async
// functions — this can't live there. Unit-testable without a DB; the actual
// reversal is covered by tests/roundup-finalize.test.ts against
// lib/roundup-finalize.ts::unstampRoundup.
//
// No `success` field here — on a real reversal, unstampAction redirects to
// /admin/archive?reversed=... instead of returning state. The success
// banner is rendered server-side from that search param (page.tsx), not
// from client state owned by the EditionCard the reversal itself unmounts.
// See app/admin/archive/unstamp-actions.ts for why.
export interface UnstampFormState {
  error: string | null;
}

export const initialUnstampFormState: UnstampFormState = { error: null };

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
