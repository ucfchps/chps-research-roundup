"use server";

// §8a: the public portal's one write. Redirects to /?submitted=1 or
// /?dupe=posted|pending on success instead of returning state — same
// redirect-based banner pattern used everywhere else in this codebase
// (e.g. app/admin/archive/unstamp-actions.ts's header comment for the
// original postmortem), so a completed submission's confirmation doesn't
// depend on client state a revalidate could race.
import { redirect } from "next/navigation";
import { client } from "@/lib/db";
import { submitPublication } from "@/lib/portal";
import { parsePortalSubmitFormData, type PortalSubmitFormState } from "./portal-shared";

export async function submitPortalPublicationAction(_prev: PortalSubmitFormState, formData: FormData): Promise<PortalSubmitFormState> {
  const parsed = parsePortalSubmitFormData(formData);

  if (parsed.kind === "spam") {
    // Same success experience a real visitor gets — never reveal the
    // honeypot tripped, or a bot learns to leave it alone next time.
    redirect("/?submitted=1");
  }
  if (parsed.kind === "invalid") {
    return { error: parsed.error };
  }

  const result = await submitPublication(client, parsed.submittedBy, parsed.submission, parsed.note);

  if (result.outcome === "already_posted") {
    redirect(`/?dupe=posted&label=${encodeURIComponent(result.roundupLabel ?? "")}`);
  }
  if (result.outcome === "already_pending") {
    redirect("/?dupe=pending");
  }
  redirect("/?submitted=1");
}
