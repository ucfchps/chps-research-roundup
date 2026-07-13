// Scholar-alert coverage detection. See amended master plan §11 and
// docs/wp-directory-notes.md §3. Pure classification + a DB read; no UI.
import type { Client } from "@libsql/client";
import { UNITS, type Faculty, type Unit } from "./types";

const KNOWN_NON_SCHOLAR_HOSTS = new Set(["www.researchgate.net", "www.ncbi.nlm.nih.gov"]);

export type ProfileClassification = "no_profile" | "scholar" | "known_non_scholar" | "unparseable";

// §3: the directory field is generic. ResearchGate/NCBI are a real, permanent
// fact (known_non_scholar) — distinct from a genuinely broken link like a bare
// DOI pasted in by mistake (unparseable), which needs a human to fix.
export function classifyResearchProfile(url: string | null | undefined): ProfileClassification {
  const trimmed = url?.trim();
  if (!trimmed) return "no_profile";

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "unparseable";
  }

  if (parsed.hostname === "scholar.google.com") return "scholar";
  if (KNOWN_NON_SCHOLAR_HOSTS.has(parsed.hostname)) return "known_non_scholar";
  return "unparseable";
}

export type CoverageBucketKey =
  | "alert_likely_not_created"
  | "working"
  | "not_google_scholar"
  | "fix_directory_link"
  | "no_profile_at_all";

// The amended §11 five buckets. "working" is not actionable — everything else
// is either a to-do ("alert_likely_not_created", "fix_directory_link") or a
// permanent fact that must not be presented as one ("not_google_scholar",
// "no_profile_at_all").
export function bucketForFaculty(
  f: Pick<Faculty, "scholar_user_id" | "research_profile_url" | "last_alert_seen_at">
): CoverageBucketKey {
  if (f.scholar_user_id) {
    return f.last_alert_seen_at ? "working" : "alert_likely_not_created";
  }

  const classification = classifyResearchProfile(f.research_profile_url);
  if (classification === "known_non_scholar") return "not_google_scholar";
  if (classification === "unparseable") return "fix_directory_link";
  return "no_profile_at_all";
}

// Surfaces prominently: any canonical unit with zero roster members (§11) —
// CARD is the currently-standing, real example (§9, docs §7–8).
export function emptyCanonicalUnits(faculty: Pick<Faculty, "unit">[]): Unit[] {
  const present = new Set(faculty.map((f) => f.unit).filter((u): u is Unit => u !== null));
  return UNITS.filter((unit) => !present.has(unit));
}

export type CoverageReport = Record<CoverageBucketKey, Faculty[]> & { emptyUnits: Unit[] };

// Pure SQL + the mapping above. Active faculty only — deactivated rows have
// already left the roster and aren't part of the coverage picture.
export async function getAlertCoverage(client: Client): Promise<CoverageReport> {
  const result = await client.execute("SELECT * FROM faculty WHERE active = 1");
  const faculty = result.rows as unknown as Faculty[];

  const report: CoverageReport = {
    alert_likely_not_created: [],
    working: [],
    not_google_scholar: [],
    fix_directory_link: [],
    no_profile_at_all: [],
    emptyUnits: emptyCanonicalUnits(faculty),
  };

  for (const f of faculty) {
    report[bucketForFaculty(f)].push(f);
  }

  return report;
}
