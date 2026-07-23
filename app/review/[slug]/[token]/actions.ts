"use server";

// Server Actions backing the §8b personal review page. Every action takes
// the token (bound from the page, never trusted from a hidden/editable form
// field alone would be equally fine here since it's already the capability
// itself) and re-derives facultyId server-side via getReviewRequestByToken —
// the row ids in the submitted FormData are never trusted on their own; the
// lib/review-actions.ts functions they call re-check scope against the DB.
import { revalidatePath } from "next/cache";
import { client } from "@/lib/db";
import { getReviewRequestByToken, markReviewComplete } from "@/lib/review";
import {
  addMissingPublication,
  editCitation,
  rejectAuthorAttribution,
  setCoAuthorRole,
} from "@/lib/review-actions";
import type { AuthorRole } from "@/lib/types";

async function resolveFacultyId(token: string): Promise<number> {
  const reviewRequest = await getReviewRequestByToken(client, token);
  if (!reviewRequest) throw new Error("This review link is no longer valid.");
  return reviewRequest.faculty_id;
}

export async function setRoleAction(token: string, slug: string, publicationAuthorId: number, formData: FormData): Promise<void> {
  const facultyId = await resolveFacultyId(token);
  const role = formData.get("role") as AuthorRole;
  await setCoAuthorRole(client, facultyId, publicationAuthorId, role);
  revalidatePath(`/review/${slug}/${token}`);
}

export async function rejectAttributionAction(token: string, slug: string, publicationAuthorId: number): Promise<void> {
  const facultyId = await resolveFacultyId(token);
  await rejectAuthorAttribution(client, facultyId, publicationAuthorId);
  revalidatePath(`/review/${slug}/${token}`);
}

// The Zhu/Dykstra shape: the reviewer's own row is the unconfirmed one, and
// "yes, this is mine" is just confirming it as chps_faculty — the same
// setCoAuthorRole path as tagging any other co-author.
export async function confirmOwnAttributionAction(token: string, slug: string, publicationAuthorId: number): Promise<void> {
  const facultyId = await resolveFacultyId(token);
  await setCoAuthorRole(client, facultyId, publicationAuthorId, "chps_faculty");
  revalidatePath(`/review/${slug}/${token}`);
}

export async function editCitationAction(token: string, slug: string, publicationId: number, formData: FormData): Promise<void> {
  const facultyId = await resolveFacultyId(token);
  await editCitation(client, facultyId, publicationId, {
    title: String(formData.get("title") ?? ""),
    journal: String(formData.get("journal") ?? ""),
    volume: String(formData.get("volume") ?? ""),
    issue: String(formData.get("issue") ?? ""),
    pages: String(formData.get("pages") ?? ""),
  });
  revalidatePath(`/review/${slug}/${token}`);
}

// No publicationAuthorId/reviewRequestId ever comes from the client here —
// the only row this can ever touch is whichever one the token itself
// resolves to, freshly looked up on every call.
export async function markReviewCompleteAction(token: string, slug: string): Promise<void> {
  const reviewRequest = await getReviewRequestByToken(client, token);
  if (!reviewRequest) throw new Error("This review link is no longer valid.");
  await markReviewComplete(client, reviewRequest.id);
  revalidatePath(`/review/${slug}/${token}`);
}

export interface AddPublicationFormState {
  message: string | null;
}

export async function addPublicationAction(
  token: string,
  slug: string,
  _prevState: AddPublicationFormState,
  formData: FormData
): Promise<AddPublicationFormState> {
  const facultyId = await resolveFacultyId(token);
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { message: "Title is required." };

  const result = await addMissingPublication(client, facultyId, {
    title,
    doi: String(formData.get("doi") ?? "").trim() || null,
    url: String(formData.get("url") ?? "").trim(),
    journal: String(formData.get("journal") ?? "").trim() || null,
    volume: String(formData.get("volume") ?? "").trim() || null,
    issue: String(formData.get("issue") ?? "").trim() || null,
    pages: String(formData.get("pages") ?? "").trim() || null,
  });

  revalidatePath(`/review/${slug}/${token}`);

  switch (result.outcome) {
    case "already_posted":
      return { message: `Good news — we already shared this one${result.roundupLabel ? ` in the ${result.roundupLabel} roundup` : ""}.` };
    case "already_in_queue":
      return { message: "This one's already in your list below." };
    case "linked_you":
      return { message: "Found it — we had this paper but hadn't connected it to you. Fixed." };
    case "pending_submission":
      return { message: "Thanks — we'll review this and add it soon." };
  }
}
