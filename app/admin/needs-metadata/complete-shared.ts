// Pure parsing/validation for the completion form, split out of
// complete-actions.ts because a "use server" file may only export async
// functions. Unit-testable without a DB; the actual write is covered by
// tests/needs-metadata.test.ts against lib/needs-metadata.ts.
import type { CompleteAuthorInput, CompleteNeedsMetadataParams } from "@/lib/needs-metadata";
import type { AuthorRole } from "@/lib/types";

export interface CompletionFormState {
  error: string | null;
}

export const initialCompletionFormState: CompletionFormState = { error: null };

export type ParsedCompletionForm = { publicationId: number; params: CompleteNeedsMetadataParams } | { error: string };

const VALID_ROLES = new Set<AuthorRole>(["chps_faculty", "grad_student", "undergrad_student", "external"]);

// The server-side half of the completion form — client-side gating (the
// disabled submit button) is UX friction only, never trusted on its own,
// same posture as every other form in this codebase.
export function parseCompletionFormData(formData: FormData): ParsedCompletionForm {
  const publicationIdRaw = String(formData.get("publicationId") ?? "").trim();
  const publicationId = Number(publicationIdRaw);
  if (!publicationIdRaw || Number.isNaN(publicationId)) {
    return { error: "Missing or invalid publication id." };
  }

  const completedBy = String(formData.get("completedBy") ?? "").trim();
  if (!completedBy) {
    return { error: "Your name is required." };
  }

  const journal = String(formData.get("journal") ?? "").trim() || null;
  const volume = String(formData.get("volume") ?? "").trim() || null;
  const issue = String(formData.get("issue") ?? "").trim() || null;
  const pages = String(formData.get("pages") ?? "").trim() || null;
  const doi = String(formData.get("doi") ?? "").trim() || null;
  const acknowledgedMissingJournal = formData.get("acknowledgedMissingJournal") === "on";
  const acknowledgedZeroLinkedAuthors = formData.get("acknowledgedZeroLinkedAuthors") === "on";

  const names = formData.getAll("authorName").map((v) => String(v).trim());
  const roles = formData.getAll("authorRole").map((v) => String(v));
  const facultyIdsRaw = formData.getAll("authorFacultyId").map((v) => String(v));

  if (names.length !== roles.length || names.length !== facultyIdsRaw.length) {
    return { error: "Malformed author rows — row counts don't match." };
  }

  const authors: CompleteAuthorInput[] = [];
  for (let i = 0; i < names.length; i++) {
    if (!names[i]) continue; // an added-then-never-filled-in row — drop it, not an error
    const role = roles[i];
    if (!VALID_ROLES.has(role as AuthorRole)) {
      return { error: `Unrecognized role "${role}" on author "${names[i]}".` };
    }
    authors.push({
      name: names[i],
      role: role as AuthorRole,
      facultyId: facultyIdsRaw[i] ? Number(facultyIdsRaw[i]) : null,
    });
  }

  return {
    publicationId,
    params: { completedBy, journal, volume, issue, pages, doi, acknowledgedMissingJournal, acknowledgedZeroLinkedAuthors, authors },
  };
}
