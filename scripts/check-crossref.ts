// One real call against the live Crossref API. Run with:
//   npm run check:crossref -- "<title>" [year] [surname]
// Proves the whole Scholar->Crossref handoff (§5a rule 7): a bare title in, a
// roundup-ready citation out, via formatCitation from lib/citation.ts.
import { config } from "dotenv";
import path from "node:path";

config({ path: path.join(__dirname, "..", ".env.local") });

async function main() {
  const [title, yearArg, surname] = process.argv.slice(2);
  if (!title) {
    console.error('Usage: npm run check:crossref -- "<title>" [year] [surname]');
    process.exit(1);
  }
  const year = yearArg ? Number(yearArg) : undefined;

  // Dynamic import: lib/crossref.ts reads CROSSREF_MAILTO at import time,
  // same reason scripts/check-ai.ts imports lib/ai.ts dynamically after
  // config() — a static import here would be hoisted above it.
  const { resolveByTitle } = await import("../lib/crossref");
  const { formatCitation } = await import("../lib/citation");

  const resolution = await resolveByTitle(title, year, surname);

  if (!resolution) {
    console.log("null — no candidate cleared the acceptance gate.");
    return;
  }

  const now = new Date().toISOString();
  const publication = {
    id: 0,
    doi: resolution.doi,
    title: resolution.title,
    title_normalized: "",
    url: resolution.url,
    journal: resolution.journal,
    year: resolution.year,
    volume: resolution.volume,
    issue: resolution.issue,
    pages: resolution.pages,
    status: "published" as const,
    source: "crossref" as const,
    first_seen_at: now,
    date_added: now,
    released_at: null,
    roundup_id: null,
    created_at: now,
  };
  const authors = resolution.authors.map((a, i) => ({
    id: i,
    publication_id: 0,
    faculty_id: null,
    name: a.name,
    role: "unknown" as const,
    role_set_by: null,
    role_set_at: null,
    position: a.position,
  }));

  console.log(`DOI: ${resolution.doi}`);
  console.log(`Type: ${resolution.type}`);
  console.log("");
  console.log(formatCitation(publication, authors));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
