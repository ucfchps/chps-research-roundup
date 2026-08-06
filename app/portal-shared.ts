// Pure parsing/validation for the §8a public portal's submission form, split
// out of portal-actions.ts because a "use server" file may only export async
// functions. Unit-testable without a DB — the actual write/duplicate-check
// is covered by tests/portal.test.ts against lib/portal.ts.
import type { PublicationSubmission } from "@/lib/review-actions";
import type { AuthorRole, Unit } from "@/lib/types";
import { UNITS } from "@/lib/types";
import { isAllowedCitationUrl } from "@/lib/citation";

export interface PortalSubmitFormState {
  error: string | null;
}

export const initialPortalSubmitFormState: PortalSubmitFormState = { error: null };

const VALID_ROLES = new Set<AuthorRole>(["chps_faculty", "grad_student", "undergrad_student", "external"]);

export type ParsedPortalSubmitForm =
  | { kind: "spam" }
  | { kind: "invalid"; error: string }
  | { kind: "valid"; submittedBy: string; submission: PublicationSubmission; note: string | null };

// ★ Honeypot field ("website") — real visitors never see or fill it
// (off-screen in the form), a bot's autofill heuristics often do. A tripped
// honeypot returns "spam", never an error — the caller shows the exact same
// success experience a real submission gets, just writes nothing, so a bot
// never learns which field gave it away.
export function parsePortalSubmitFormData(formData: FormData): ParsedPortalSubmitForm {
  if (String(formData.get("website") ?? "").trim() !== "") {
    return { kind: "spam" };
  }

  const submittedBy = String(formData.get("submittedBy") ?? "").trim();
  if (!submittedBy) return { kind: "invalid", error: "Your name is required." };

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { kind: "invalid", error: "Title is required." };

  const url = String(formData.get("url") ?? "").trim();
  if (!url) return { kind: "invalid", error: "Link is required." };
  // Phase 5 hardening (Session 7 finding): an unauthenticated submitter
  // could otherwise put a javascript:/data: URL straight into
  // pending_submissions, which lib/citation.ts::formatCitation would later
  // render as a live href in the admin's own Tab 1 review view. Rejected
  // here, at the earliest possible point, same allowlist formatCitation
  // itself enforces at render time — belt and suspenders, not
  // either/or (§15.1: nothing goes public unreviewed, but "unreviewed"
  // includes a reviewer's own browser while they're doing the reviewing).
  if (!isAllowedCitationUrl(url)) return { kind: "invalid", error: "Link must be a valid web address (http/https) or mailto link." };

  const doi = String(formData.get("doi") ?? "").trim() || null;
  const journal = String(formData.get("journal") ?? "").trim() || null;
  const volume = String(formData.get("volume") ?? "").trim() || null;
  const issue = String(formData.get("issue") ?? "").trim() || null;
  const pages = String(formData.get("pages") ?? "").trim() || null;
  const yearRaw = String(formData.get("year") ?? "").trim();
  const year = yearRaw ? Number(yearRaw) : null;

  const unitHintRaw = String(formData.get("unitHint") ?? "").trim();
  const unitHint: Unit | null = (UNITS as readonly string[]).includes(unitHintRaw) ? (unitHintRaw as Unit) : null;

  const names = formData.getAll("authorName").map((v) => String(v).trim());
  const roles = formData.getAll("authorRole").map((v) => String(v));
  if (names.length !== roles.length) return { kind: "invalid", error: "Malformed author rows — row counts don't match." };

  const authors: Array<{ name: string; role: AuthorRole }> = [];
  for (let i = 0; i < names.length; i++) {
    if (!names[i]) continue;
    const role = roles[i];
    if (!VALID_ROLES.has(role as AuthorRole)) return { kind: "invalid", error: `Unrecognized role "${role}" on author "${names[i]}".` };
    authors.push({ name: names[i], role: role as AuthorRole });
  }
  if (authors.length === 0) return { kind: "invalid", error: "At least one author is required." };

  const note = String(formData.get("note") ?? "").trim() || null;

  return {
    kind: "valid",
    submittedBy,
    submission: { title, doi, url, journal, year, volume, issue, pages, authors, unitHint },
    note,
  };
}
