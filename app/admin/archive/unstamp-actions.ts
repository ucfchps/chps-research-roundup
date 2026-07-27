"use server";

// Session 24 (§8c Tab 5): the Server Actions behind the archive's one write.
// Both call lib/roundup-finalize.ts::unstampRoundup — the same function
// scripts/unstamp-roundup.ts calls — never a second reversal implementation.
// Same auth-gated-glue shape as app/admin/publications/finalize-actions.ts.
//
// ★ On a real reversal, unstampAction redirects to
// /admin/archive?reversed=<id>&count=<n>&label=<label> instead of returning
// success state to useActionState. A prior version returned {success} and
// had the client's EditionCard lift it to the parent via a useEffect — but
// the same revalidatePath that refreshes the roundups list also unmounts
// that exact card (its edition is now gone from the list) in the same
// client transition, so the effect never got a committed render to fire
// from and the confirmation banner silently never appeared, even though
// the reversal itself was correct. Encoding the result in the redirect URL
// sidesteps the unmounting-child entirely — page.tsx reads it server-side
// on the fresh navigation and renders the banner itself, not client state
// owned by a component the action just deleted the reason to exist for.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { client } from "@/lib/db";
import { requireAdminSession } from "../session";
import { unstampRoundup, type UnstampSummary } from "@/lib/roundup-finalize";
import { parseUnstampFormData, type UnstampFormState } from "./unstamp-shared";

// Called directly (not as a form action) when COMMS opens the confirm step,
// so the exact reversal that would happen is on screen before anyone types
// the label back — not a separately-computed count that could drift from it.
export async function dryRunUnstampAction(roundupId: number): Promise<UnstampSummary> {
  await requireAdminSession();
  return unstampRoundup(client, roundupId, { dryRun: true });
}

export async function unstampAction(_prev: UnstampFormState, formData: FormData): Promise<UnstampFormState> {
  await requireAdminSession();

  const parsed = parseUnstampFormData(formData);
  if ("error" in parsed) return { error: parsed.error };

  let summary: UnstampSummary;
  try {
    summary = await unstampRoundup(client, parsed.roundupId, { dryRun: false });
  } catch (err) {
    return { error: (err as Error).message };
  }

  // A race (someone else reversed it between this form's dry-run preview
  // and this submit) — nothing to report, just go back to the current list.
  if (summary.noop) {
    redirect("/admin/archive");
  }

  revalidatePath("/admin/publications"); // Tab 4's eligibility list should reflect the re-opened publications
  const params = new URLSearchParams({
    reversed: String(summary.roundupId),
    count: String(summary.publicationIds.length),
    label: summary.label ?? "",
  });
  redirect(`/admin/archive?${params.toString()}`);
}
