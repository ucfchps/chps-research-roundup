"use server";

// §8c Tab 2: the Server Action behind a manual needs_metadata completion.
//
// ★ On success this redirects to /admin/needs-metadata?completed=<id>&...
// instead of returning state to useActionState. A completed record leaves
// this queue (status flips to pending_merge), so the card announcing success
// would be exactly the card the save just removed from the list — the same
// failure mode Session 24's un-stamp banner had (see archive/unstamp-actions.ts's
// comment for the full postmortem). Building it redirect-based from the
// start here rather than repeating that mistake.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { client } from "@/lib/db";
import { requireAdminSession } from "../session";
import { completeNeedsMetadataRecord } from "@/lib/needs-metadata";
import { parseCompletionFormData, type CompletionFormState } from "./complete-shared";

export async function completeNeedsMetadataAction(_prev: CompletionFormState, formData: FormData): Promise<CompletionFormState> {
  await requireAdminSession();

  const parsed = parseCompletionFormData(formData);
  if ("error" in parsed) return { error: parsed.error };

  let result;
  try {
    result = await completeNeedsMetadataRecord(client, parsed.publicationId, parsed.params);
  } catch (err) {
    return { error: (err as Error).message };
  }

  if (result.outcome === "already_promoted") {
    return {
      error: `This record left the Needs Metadata queue already (now "${result.currentStatus}") — likely an automatic DOI match landed first. Nothing was written; refresh to see current state.`,
    };
  }

  revalidatePath("/admin/publications"); // it's now pending_merge, visible there once released
  const params = new URLSearchParams({
    completed: String(result.publicationId),
    units: String(result.units.length),
    authors: String(result.authorCount),
  });
  redirect(`/admin/needs-metadata?${params.toString()}`);
}
