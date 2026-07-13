// Daily roster sync: WordPress directory -> `faculty`. See amended master plan
// §9 and docs/wp-directory-notes.md. Run with: npm run sync:roster
import { config } from "dotenv";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { classifyResearchProfile } from "../lib/coverage";
import { fetchClassTaxonomy, fetchRoster, includeInRoster, mapPersonToFaculty } from "../lib/wordpress";

config({ path: path.join(__dirname, "..", ".env.local") });

export interface ScholarIdCollision {
  scholarUserId: string;
  keptWpId: string;
  keptName: string;
  droppedWpId: string;
  droppedName: string;
}

export interface SyncSummary {
  fetched: number;
  included: number;
  inserted: number;
  updated: number;
  deactivated: number;
  noCanonicalUnit: number;
  ambiguousUnit: number;
  lowConfidenceCitation: number;
  notGoogleScholar: number;
  unparseableProfile: number;
  scholarIdCollisions: ScholarIdCollision[];
}

const UPSERT_SQL = `
  INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, research_profile_url, scholar_user_id, orcid, classification, active, last_synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT(wp_id) DO UPDATE SET
    slug = excluded.slug,
    display_name = excluded.display_name,
    full_name = excluded.full_name,
    email = excluded.email,
    unit = excluded.unit,
    research_profile_url = excluded.research_profile_url,
    scholar_user_id = excluded.scholar_user_id,
    orcid = excluded.orcid,
    classification = excluded.classification,
    active = 1,
    last_synced_at = excluded.last_synced_at
`;

export async function syncRoster(client: Client, apiUrl: string): Promise<SyncSummary> {
  const [people, classTermNames] = await Promise.all([
    fetchRoster(apiUrl),
    fetchClassTaxonomy(apiUrl),
  ]);

  const mapped = people.map((p) => mapPersonToFaculty(p, classTermNames));
  const included = mapped.filter((f) => includeInRoster(f.classification, f.research_profile_url));

  const existing = await client.execute("SELECT wp_id, scholar_user_id, display_name FROM faculty");
  const existingWpIds = new Set(existing.rows.map((r) => String(r.wp_id)));

  // scholar_user_id -> current owner. Seeded from the DB, then updated as we
  // process this run's batch — catches collisions against prior syncs AND
  // within a single WordPress copy-paste mistake in the same pull.
  const scholarIdOwners = new Map<string, { wpId: string; name: string }>();
  for (const row of existing.rows) {
    const sid = row.scholar_user_id as string | null;
    if (sid) scholarIdOwners.set(sid, { wpId: String(row.wp_id), name: String(row.display_name) });
  }

  const summary: SyncSummary = {
    fetched: people.length,
    included: included.length,
    inserted: 0,
    updated: 0,
    deactivated: 0,
    noCanonicalUnit: 0,
    ambiguousUnit: 0,
    lowConfidenceCitation: 0,
    notGoogleScholar: 0,
    unparseableProfile: 0,
    scholarIdCollisions: [],
  };

  const now = new Date().toISOString();
  const includedWpIds = new Set<string>();

  for (const f of included) {
    includedWpIds.add(f.wp_id);

    if (f.unit_reason === "no canonical unit") summary.noCanonicalUnit++;
    else if (f.unit_reason.startsWith("ambiguous")) summary.ambiguousUnit++;

    if (!f.display_name_confident) summary.lowConfidenceCitation++;

    if (f.research_profile_url && !f.scholar_user_id) {
      const classification = classifyResearchProfile(f.research_profile_url);
      if (classification === "known_non_scholar") summary.notGoogleScholar++;
      else if (classification === "unparseable") summary.unparseableProfile++;
    }

    let scholarUserIdToStore = f.scholar_user_id;
    if (scholarUserIdToStore) {
      const owner = scholarIdOwners.get(scholarUserIdToStore);
      if (owner && owner.wpId !== f.wp_id) {
        // A copy-paste error someone made in WordPress. Keep the existing
        // owner, drop it from this record, and report both by name — don't
        // let the UNIQUE constraint crash the run.
        summary.scholarIdCollisions.push({
          scholarUserId: scholarUserIdToStore,
          keptWpId: owner.wpId,
          keptName: owner.name,
          droppedWpId: f.wp_id,
          droppedName: f.display_name,
        });
        scholarUserIdToStore = null;
      } else {
        scholarIdOwners.set(scholarUserIdToStore, { wpId: f.wp_id, name: f.display_name });
      }
    }

    const isNew = !existingWpIds.has(f.wp_id);
    await client.execute({
      sql: UPSERT_SQL,
      args: [
        f.wp_id, f.slug, f.display_name, f.full_name, f.email, f.unit,
        f.research_profile_url, scholarUserIdToStore, f.orcid, f.classification, now,
      ],
    });

    if (isNew) summary.inserted++;
    else summary.updated++;
  }

  // Deactivate — never delete; publications reference faculty rows. Covers
  // both "vanished from WordPress" and "no longer meets the §7 roster filter."
  for (const wpId of existingWpIds) {
    if (includedWpIds.has(wpId)) continue;
    const result = await client.execute({
      sql: "UPDATE faculty SET active = 0, last_synced_at = ? WHERE wp_id = ? AND active = 1",
      args: [now, wpId],
    });
    if (result.rowsAffected > 0) summary.deactivated++;
  }

  return summary;
}

function printSummary(summary: SyncSummary) {
  console.log(
    `${summary.fetched} fetched · ${summary.included} included · ${summary.inserted} inserted · ` +
      `${summary.updated} updated · ${summary.deactivated} deactivated`
  );
  console.log(`${summary.noCanonicalUnit} with no canonical unit          (unit left NULL — needs a human)`);
  console.log(`${summary.ambiguousUnit} with an ambiguous unit          (unit left NULL — needs a human)`);
  console.log(`${summary.lowConfidenceCitation} with a low-confidence citation name  (from toCitationName — needs a human)`);
  console.log(`${summary.notGoogleScholar} with a research profile that is not Google Scholar   (expected; not an error)`);
  console.log(`${summary.unparseableProfile} with an unparseable profile URL (bad directory link — needs fixing)`);

  if (summary.scholarIdCollisions.length > 0) {
    console.log(`\n${summary.scholarIdCollisions.length} scholar_user_id collision(s) — fix in WordPress:`);
    for (const c of summary.scholarIdCollisions) {
      console.log(
        `  "${c.scholarUserId}" claimed by ${c.keptName} (wp_id ${c.keptWpId}); ` +
          `also entered for ${c.droppedName} (wp_id ${c.droppedWpId}) — dropped for the latter`
      );
    }
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const apiUrl = process.env.WP_DIRECTORY_API_URL;
  if (!url || !authToken) {
    throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");
  }
  if (!apiUrl) {
    throw new Error("WP_DIRECTORY_API_URL must be set (see .env.example)");
  }

  const client = createClient({ url, authToken });
  const summary = await syncRoster(client, apiUrl);
  printSummary(summary);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
