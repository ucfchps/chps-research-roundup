"use server";

// §8c Tab 1: the Server Actions behind approve/reject. Both redirect to
// /admin/pending-submissions?<outcome>=<id>... on success rather than
// returning state to useActionState — a reviewed submission leaves this
// queue, so the confirming component would be exactly the component the
// action just removed from the list. Same fix applied proactively in
// Session 25 (see needs-metadata/complete-actions.ts's comment for the
// original postmortem, from the archive un-stamp banner).
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { client } from "@/lib/db";
import { requireAdminSession } from "../session";
import { approvePendingSubmission, rejectPendingSubmission } from "@/lib/pending-submissions";
import { parseApproveFormData, parseRejectFormData, type SubmissionFormState } from "./submission-shared";

export async function approveSubmissionAction(_prev: SubmissionFormState, formData: FormData): Promise<SubmissionFormState> {
  await requireAdminSession();

  const parsed = parseApproveFormData(formData);
  if ("error" in parsed) return { error: parsed.error };

  let result;
  try {
    result = await approvePendingSubmission(client, parsed.submissionId, parsed.params);
  } catch (err) {
    return { error: (err as Error).message };
  }

  if (result.outcome === "not_pending") {
    return { error: `This submission was already ${result.currentStatus} — someone else reviewed it. Refresh to see current state.` };
  }
  if (result.outcome === "already_posted") {
    return {
      error: `A matching publication is already posted${result.roundupLabel ? ` (edition "${result.roundupLabel}")` : ""} — this looks like a duplicate. Reject this submission instead of approving it.`,
    };
  }

  revalidatePath("/admin/publications");
  const params = new URLSearchParams({ approved: String(parsed.submissionId), publicationId: String(result.publicationId), linked: String(result.outcome === "linked_existing") });
  redirect(`/admin/pending-submissions?${params.toString()}`);
}

export async function rejectSubmissionAction(_prev: SubmissionFormState, formData: FormData): Promise<SubmissionFormState> {
  await requireAdminSession();

  const parsed = parseRejectFormData(formData);
  if ("error" in parsed) return { error: parsed.error };

  let result;
  try {
    result = await rejectPendingSubmission(client, parsed.submissionId, parsed.reviewedBy);
  } catch (err) {
    return { error: (err as Error).message };
  }

  if (result.outcome === "not_pending") {
    return { error: `This submission was already ${result.currentStatus} — someone else reviewed it. Refresh to see current state.` };
  }

  redirect(`/admin/pending-submissions?rejected=${parsed.submissionId}`);
}
