// Pure parsing/validation for the review form, split out of
// submission-actions.ts because a "use server" file may only export async
// functions. Unit-testable without a DB; the actual writes are covered by
// tests/pending-submissions.test.ts against lib/pending-submissions.ts.
import type { ApproveParams, ReviewAuthorInput } from "@/lib/pending-submissions";
import type { AuthorRole } from "@/lib/types";

export interface SubmissionFormState {
  error: string | null;
}

export const initialSubmissionFormState: SubmissionFormState = { error: null };

const VALID_ROLES = new Set<AuthorRole>(["chps_faculty", "grad_student", "undergrad_student", "external"]);

export type ParsedApproveForm = { submissionId: number; params: ApproveParams } | { error: string };

export function parseApproveFormData(formData: FormData): ParsedApproveForm {
  const submissionIdRaw = String(formData.get("submissionId") ?? "").trim();
  const submissionId = Number(submissionIdRaw);
  if (!submissionIdRaw || Number.isNaN(submissionId)) return { error: "Missing or invalid submission id." };

  const reviewedBy = String(formData.get("reviewedBy") ?? "").trim();
  if (!reviewedBy) return { error: "Your name is required." };

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { error: "Title is required." };

  const url = String(formData.get("url") ?? "").trim();
  if (!url) return { error: "Link is required." };

  const doi = String(formData.get("doi") ?? "").trim() || null;
  const journal = String(formData.get("journal") ?? "").trim() || null;
  const volume = String(formData.get("volume") ?? "").trim() || null;
  const issue = String(formData.get("issue") ?? "").trim() || null;
  const pages = String(formData.get("pages") ?? "").trim() || null;
  const yearRaw = String(formData.get("year") ?? "").trim();
  const year = yearRaw ? Number(yearRaw) : null;

  const names = formData.getAll("authorName").map((v) => String(v).trim());
  const roles = formData.getAll("authorRole").map((v) => String(v));
  const facultyIdsRaw = formData.getAll("authorFacultyId").map((v) => String(v));

  if (names.length !== roles.length || names.length !== facultyIdsRaw.length) {
    return { error: "Malformed author rows — row counts don't match." };
  }

  const authors: ReviewAuthorInput[] = [];
  for (let i = 0; i < names.length; i++) {
    if (!names[i]) continue;
    const role = roles[i];
    if (!VALID_ROLES.has(role as AuthorRole)) return { error: `Unrecognized role "${role}" on author "${names[i]}".` };
    authors.push({ name: names[i], role: role as AuthorRole, facultyId: facultyIdsRaw[i] ? Number(facultyIdsRaw[i]) : null });
  }

  return { submissionId, params: { reviewedBy, title, doi, url, journal, year, volume, issue, pages, authors } };
}

export type ParsedRejectForm = { submissionId: number; reviewedBy: string } | { error: string };

export function parseRejectFormData(formData: FormData): ParsedRejectForm {
  const submissionIdRaw = String(formData.get("submissionId") ?? "").trim();
  const submissionId = Number(submissionIdRaw);
  if (!submissionIdRaw || Number.isNaN(submissionId)) return { error: "Missing or invalid submission id." };

  const reviewedBy = String(formData.get("reviewedBy") ?? "").trim();
  if (!reviewedBy) return { error: "Your name is required." };

  return { submissionId, reviewedBy };
}
