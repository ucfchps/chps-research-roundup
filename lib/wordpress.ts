// WordPress directory client. See §5a.3, amended §6/§9 of the master plan, and
// docs/wp-directory-notes.md for the real endpoint shape, field map, and
// department term-ID map this codes against.
import { orcidId } from "./orcid";
import { scholarUserId } from "./scholar";
import { toCitationName } from "./names";
import { unitForDepartmentTerms } from "./units";
import type { Unit } from "./types";

// REST shape trimmed to what we use — see docs/wp-directory-notes.md §1–2.
// _fields=id,slug,title,acf,departments,class
export interface WpPerson {
  id: number;
  slug: string;
  title: { rendered: string };
  departments: number[];
  class: number[];
  acf: {
    profile_F_name: string | null;
    profile_L_name: string | null;
    email_address: string | null;
    google_scholar: string | null;
    orcid: string | null;
  };
}

export interface NormalizedFacultyRecord {
  wp_id: string;
  slug: string;
  full_name: string;
  display_name: string;
  display_name_confident: boolean;
  email: string | null;
  unit: Unit | null;
  unit_reason: string;
  research_profile_url: string | null;
  scholar_user_id: string | null;
  orcid: string | null;
  classification: string | null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// §7 — do NOT filter on `class` alone. At least one active, publishing faculty
// member is Leadership-only, and the entire CARD roster is classed Staff.
// Self-healing: the moment anyone adds a research profile link, they enter the
// roster regardless of classification.
export function includeInRoster(
  classification: string | null,
  researchProfileUrl: string | null
): boolean {
  const classes = (classification ?? "").split("|").map((c) => c.trim());
  return classes.includes("Faculty") || classes.includes("Leadership") || Boolean(nonEmpty(researchProfileUrl));
}

function classificationString(termIds: number[], classTermNames: Record<number, string>): string | null {
  const names = termIds.map((id) => classTermNames[id]).filter((n): n is string => Boolean(n));
  return names.length > 0 ? names.join("|") : null;
}

const PERSON_FIELDS = "id,slug,title,acf,departments,class";

// Fetches the full `person` roster, following pagination to the end — stopping
// at page 1 would silently truncate the roster (§1). Trims the response via
// _fields; the default payload is ~60% Yoast SEO metadata.
export async function fetchRoster(apiUrl: string): Promise<WpPerson[]> {
  const results: WpPerson[] = [];
  let page = 1;

  while (true) {
    const url = `${apiUrl}?per_page=100&page=${page}&_fields=${PERSON_FIELDS}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`WordPress directory fetch failed: ${res.status} ${res.statusText}`);
    }

    const batch = (await res.json()) as WpPerson[];
    results.push(...batch);

    const totalPages = Number(res.headers.get("X-WP-TotalPages") ?? "1");
    if (page >= totalPages || batch.length === 0) break;
    page++;
  }

  return results;
}

// The `class` taxonomy term-ID -> name map. Unlike `departments`, the ground
// truth doc gives no hardcoded map for this taxonomy — resolve it live against
// the same verification endpoint documented in docs/wp-directory-notes.md §11.
export async function fetchClassTaxonomy(apiUrl: string): Promise<Record<number, string>> {
  const base = apiUrl.replace(/\/person\/?$/, "");
  const res = await fetch(`${base}/class?per_page=100&_fields=id,name,slug`);
  if (!res.ok) {
    throw new Error(`WordPress class taxonomy fetch failed: ${res.status} ${res.statusText}`);
  }

  const terms = (await res.json()) as { id: number; name: string }[];
  const map: Record<number, string> = {};
  for (const term of terms) map[term.id] = term.name;
  return map;
}

// Pure. Maps one raw WP REST record to the normalized shape sync-roster
// upserts into `faculty`. classTermNames resolves `class[]` term IDs to
// names — the ground-truth doc gives no hardcoded map for this taxonomy
// (unlike `departments`), so sync-roster fetches it live (§11 verification
// commands) and passes the result in here.
export function mapPersonToFaculty(
  person: WpPerson,
  classTermNames: Record<number, string>
): NormalizedFacultyRecord {
  const given = person.acf.profile_F_name ?? "";
  const family = person.acf.profile_L_name ?? "";
  const citation = toCitationName(given, family);
  const unitResult = unitForDepartmentTerms(person.departments ?? []);
  const researchProfileUrl = nonEmpty(person.acf.google_scholar);

  return {
    wp_id: String(person.id),
    slug: person.slug,
    full_name: person.title?.rendered ?? "",
    display_name: citation.name,
    display_name_confident: citation.confident,
    email: nonEmpty(person.acf.email_address),
    unit: unitResult.unit,
    unit_reason: unitResult.reason,
    research_profile_url: researchProfileUrl,
    scholar_user_id: scholarUserId(researchProfileUrl),
    orcid: orcidId(person.acf.orcid),
    classification: classificationString(person.class ?? [], classTermNames),
  };
}
