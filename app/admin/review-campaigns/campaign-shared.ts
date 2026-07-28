// Pure parsing/validation for review-campaigns' two forms, split out of
// campaign-actions.ts because a "use server" file may only export async
// functions. Same shape as app/admin/archive/unstamp-shared.ts.
//
// No `success` field on either state — on a real mutation, the action
// redirects to /admin/review-campaigns?... instead of returning state, so
// the confirmation banner is rendered server-side from that search param
// (page.tsx), not from client state a revalidate could unmount out from
// under. See app/admin/archive/unstamp-actions.ts for the bug this avoids.

export interface SendCampaignFormState {
  error: string | null;
}

export const initialSendCampaignFormState: SendCampaignFormState = { error: null };

export type ParsedSendCampaignForm = { cycleLabel: string } | { error: string };

// The server-side half of "type the cycle label back to confirm" — at
// least as strong as archive's un-stamp gate, per this tab's send action
// being strictly harder to undo (a DB write can be un-stamped; an email
// cannot be unsent).
export function parseSendCampaignFormData(formData: FormData): ParsedSendCampaignForm {
  const cycleLabel = String(formData.get("cycleLabel") ?? "").trim();
  const confirmText = String(formData.get("confirmText") ?? "").trim();

  if (!cycleLabel) return { error: "Missing cycle label." };
  if (confirmText !== cycleLabel) return { error: "The confirmation text didn't match the cycle label exactly." };

  return { cycleLabel };
}

export interface RevokeFormState {
  error: string | null;
}

export const initialRevokeFormState: RevokeFormState = { error: null };

export type ParsedRevokeForm = { reviewRequestId: number; cycleLabel: string } | { error: string };

export function parseRevokeFormData(formData: FormData): ParsedRevokeForm {
  const idRaw = String(formData.get("reviewRequestId") ?? "").trim();
  const cycleLabel = String(formData.get("cycleLabel") ?? "").trim();

  const reviewRequestId = Number(idRaw);
  if (!idRaw || Number.isNaN(reviewRequestId)) return { error: "Missing or invalid review request id." };

  return { reviewRequestId, cycleLabel };
}
