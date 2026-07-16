// Mirrors db/migrations/001_initial.sql. Keep in sync — see §6 of the master plan.

// Canonical order — drives <h2> heading order in the generated roundup (§6).
export const UNITS = [
  "School of Communication Sciences and Disorders",
  "Center for Autism and Related Disabilities",
  "Department of Health Sciences",
  "School of Kinesiology and Rehabilitation Sciences",
  "School of Social Work",
] as const;
export type Unit = (typeof UNITS)[number];

export type PublicationStatus =
  | "pending_merge"
  | "needs_metadata"
  | "published"
  | "rejected";

export type PublicationSource =
  | "scholar"
  | "crossref"
  | "pubmed"
  | "orcid"
  | "manual";

export type AuthorRole =
  | "chps_faculty"
  | "grad_student"
  | "undergrad_student"
  | "external"
  | "unknown";

export interface Faculty {
  id: number;
  wp_id: string | null;
  slug: string | null;
  display_name: string;
  full_name: string | null;
  email: string | null;
  unit: Unit | null;
  research_profile_url: string | null;
  scholar_user_id: string | null;
  orcid: string | null;
  classification: string | null;
  active: number;
  last_alert_seen_at: string | null;
  last_synced_at: string | null;
}

export interface Publication {
  id: number;
  doi: string | null;
  title: string;
  title_normalized: string;
  url: string;
  journal: string | null;
  year: number | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  status: PublicationStatus;
  source: PublicationSource;
  first_seen_at: string;
  date_added: string;
  released_at: string | null;
  roundup_id: number | null;
  discovered_by_faculty_id: number | null;
  scholar_alert_url: string | null;
  created_at: string;
}

export interface PublicationAuthor {
  id: number;
  publication_id: number;
  faculty_id: number | null;
  name: string;
  role: AuthorRole;
  role_set_by: string | null;
  role_set_at: string | null;
  position: number;
}

export type SubmittedVia = "review_page" | "public_portal";
export type SubmissionStatus = "pending" | "approved" | "rejected";

export interface PendingSubmission {
  id: number;
  faculty_id: number | null;
  submitted_via: SubmittedVia;
  submitted_by: string;
  payload: string;
  note: string | null;
  status: SubmissionStatus;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

export interface ReviewRequest {
  id: number;
  faculty_id: number;
  token_hash: string;
  slug: string;
  cycle_label: string | null;
  created_at: string;
  expires_at: string;
  opened_at: string | null;
  completed_at: string | null;
  revoked: number;
}

export interface Roundup {
  id: number;
  label: string;
  generated_at: string;
  generated_by: string | null;
  pub_count: number;
  html: string;
}

// Result of the Crossref resolver (lib/crossref.ts, §5a rule 7). Author
// names and order only — role/faculty_id are roster-matching concerns that
// belong to the merge engine (§7), never to resolution.
export interface CrossrefResolutionAuthor {
  name: string;
  position: number;
  affiliation?: string;
}

export interface CrossrefResolution {
  doi: string;
  title: string;
  url: string;
  journal: string | null;
  year: number | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  type: string;
  authors: CrossrefResolutionAuthor[];
}

export interface UsageLog {
  id: number;
  app_name: string;
  provider: string;
  model: string;
  task_type: string;
  input_tokens: number | null;
  output_tokens: number | null;
  success: number;
  created_at: string;
}
