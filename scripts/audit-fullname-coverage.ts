// Diagnostic (§13 item 10): which faculty does the full_name PubMed-query
// fix actually change behavior for? Reuses parseFullNameForPubmedQuery /
// toPubmedQueryName directly — the exact functions
// scripts/ingest-pubmed-orcid.ts calls via buildPubmedAuthorQuery — so this
// can't drift out of sync with what the ingest script actually does.
// Read-only: no writes, no network calls. Run with: npm run audit:fullname
import { config } from "dotenv";
import path from "node:path";
import { createClient } from "@libsql/client";
import { parseFullNameForPubmedQuery, toPubmedQueryName } from "../lib/names";
import type { Faculty } from "../lib/types";

config({ path: path.join(__dirname, "..", ".env.local") });

function trailingInitials(queryName: string): string {
  const idx = queryName.lastIndexOf(" ");
  return idx === -1 ? "" : queryName.slice(idx + 1);
}

export interface AuditRow {
  displayName: string;
  fullName: string;
  oldQuery: string;
  newQuery: string;
}

export function auditFullnameCoverage(faculty: Pick<Faculty, "display_name" | "full_name">[]): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const f of faculty) {
    if (!f.full_name) continue;
    const knownSurname = f.display_name.split(",")[0]?.trim() ?? "";
    const parsed = knownSurname ? parseFullNameForPubmedQuery(f.full_name, knownSurname) : null;
    if (!parsed) continue;

    const oldQuery = toPubmedQueryName(f.display_name);
    if (trailingInitials(oldQuery) === parsed.initials) continue;

    rows.push({ displayName: f.display_name, fullName: f.full_name, oldQuery, newQuery: parsed.queryName });
  }
  return rows;
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");

  const client = createClient({ url, authToken });
  const faculty = (
    await client.execute("SELECT display_name, full_name FROM faculty WHERE active = 1 AND full_name IS NOT NULL")
  ).rows as unknown as Faculty[];

  const rows = auditFullnameCoverage(faculty);
  if (rows.length === 0) {
    console.log("No faculty found where full_name-derived initials differ from display_name-derived initials.");
    return;
  }
  console.log(`${rows.length} faculty member(s) where this fix changes the PubMed query:\n`);
  for (const r of rows) {
    console.log(`${r.displayName}  (${r.fullName})`);
    console.log(`  old: "${r.oldQuery}[Author]"`);
    console.log(`  new: "${r.newQuery}[Author]"\n`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
