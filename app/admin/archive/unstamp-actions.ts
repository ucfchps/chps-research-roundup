"use server";

// Session 24 (§8c Tab 5): the Server Actions behind the archive's one write.
// Both call lib/roundup-finalize.ts::unstampRoundup — the same function
// scripts/unstamp-roundup.ts calls — never a second reversal implementation.
// Same auth-gated-glue shape as app/admin/publications/finalize-actions.ts.
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
  if ("error" in parsed) return { error: parsed.error, success: null };

  try {
    const summary = await unstampRoundup(client, parsed.roundupId, { dryRun: false });
    revalidatePath("/admin/archive");
    revalidatePath("/admin/publications");
    return { error: null, success: summary };
  } catch (err) {
    return { error: (err as Error).message, success: null };
  }
}
