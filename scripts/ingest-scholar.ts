// Orchestrates the Scholar-alert ingester (§13 item 9): Gmail -> parse ->
// Crossref -> decide -> persist. All I/O lives here; all judgment lives in
// lib/scholar-ingest.ts (pure) and lib/scholar-alert.ts (pure). Run with:
//   npm run ingest:scholar -- --dry-run
//   npm run ingest:scholar -- --limit 5
import { config } from "dotenv";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import type { ExistingAuthor, MatchableExisting, MergeableExisting } from "../lib/matching";
import type { Faculty, PublicationStatus } from "../lib/types";
import type { CrossrefOutcome, DiscoveredArticle, ExistingMatch, IngestOutcome } from "../lib/scholar-ingest";
import { recordPossibleDuplicates } from "../lib/duplicates";

config({ path: path.join(__dirname, "..", ".env.local") });

export interface RunOptions {
  dryRun: boolean;
  limit: number | null;
}

export function parseArgs(argv: string[]): RunOptions {
  const dryRun = argv.includes("--dry-run");
  const limitFlag = argv.find((a) => a === "--limit" || a.startsWith("--limit="));
  let limit: number | null = null;
  if (limitFlag) {
    const value = limitFlag.includes("=") ? limitFlag.split("=")[1] : argv[argv.indexOf(limitFlag) + 1];
    limit = value ? Number(value) : null;
  }
  return { dryRun, limit };
}

export interface RunSummary {
  emailsScanned: number;
  parsed: number;
  rejected: Record<string, number>;
  alertsMatchedToFaculty: number;
  unknownScholarIds: { scholarUserId: string; displayName: string }[];
  articlesSeen: number;
  resolved: number;
  merged: number;
  insertedNew: number;
  needsMetadata: number;
  retryLater: number;
  discoveringFacultyNotLinked: { publicationTitle: string; facultyName: string }[];
  possibleDuplicates: { newTitle: string; existingPublicationIds: number[] }[];
  missingJournal: { publicationTitle: string }[];
  emailsLabeled: number;
  erroredEmails: { id: string; error: string }[];
}

function emptySummary(): RunSummary {
  return {
    emailsScanned: 0, parsed: 0, rejected: {}, alertsMatchedToFaculty: 0, unknownScholarIds: [],
    articlesSeen: 0, resolved: 0, merged: 0, insertedNew: 0, needsMetadata: 0, retryLater: 0,
    discoveringFacultyNotLinked: [], possibleDuplicates: [], missingJournal: [], emailsLabeled: 0, erroredEmails: [],
  };
}

async function applyOutcome(client: Client, outcome: IngestOutcome): Promise<void> {
  const nowIso = new Date().toISOString();

  if (outcome.kind === "insert_needs_metadata") {
    const p = outcome.publication;
    const result = await client.execute({
      sql: `INSERT INTO publications (title, title_normalized, url, year, status, source, discovered_by_faculty_id, scholar_alert_url, first_seen_at, date_added, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [p.title, p.title_normalized, p.url, p.year, p.status, p.source, p.discovered_by_faculty_id, p.scholar_alert_url, p.first_seen_at, p.date_added, nowIso],
    });
    // Durable record of the possible-duplicate flag (§7) — the console
    // summary (printSummary, below) still reports it too, but this survives
    // past this run. See lib/duplicates.ts.
    if (outcome.possibleDuplicateOf.length > 0) {
      await recordPossibleDuplicates(client, Number(result.lastInsertRowid), outcome.possibleDuplicateOf, "near_duplicate_title");
    }
    return;
  }

  if (outcome.kind === "insert_resolved") {
    const p = outcome.publication;
    const result = await client.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, journal, year, volume, issue, pages, status, source, discovered_by_faculty_id, scholar_alert_url, first_seen_at, date_added, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [p.doi, p.title, p.title_normalized, p.url, p.journal, p.year, p.volume, p.issue, p.pages, p.status, p.source, p.discovered_by_faculty_id, p.scholar_alert_url, p.first_seen_at, p.date_added, nowIso],
    });
    const publicationId = Number(result.lastInsertRowid);
    for (const a of outcome.authors) {
      await client.execute({
        sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [publicationId, a.faculty_id, a.name, a.role, a.role_set_by, a.role_set_at, a.position],
      });
    }
    // Durable record of the possible-duplicate flag (§7) — same as the
    // insert_needs_metadata path above, kept symmetric. See lib/duplicates.ts.
    if (outcome.possibleDuplicateOf.length > 0) {
      await recordPossibleDuplicates(client, publicationId, outcome.possibleDuplicateOf, "near_duplicate_title");
    }
    return;
  }

  if (outcome.kind === "merged") {
    // first_seen_at = COALESCE(?, first_seen_at): outcome.firstSeenAt is only
    // non-null when this merge just promoted the record out of
    // needs_metadata (§7/§15.11 — see promoteFromNeedsMetadata,
    // lib/matching.ts) — a fresh buffer window for a record that's only now
    // becoming mergeable. Null leaves the column untouched, the normal case.
    await client.execute({
      sql: `UPDATE publications SET doi=?, title=?, title_normalized=?, url=?, journal=?, year=?, volume=?, issue=?, pages=?, status=?, first_seen_at = COALESCE(?, first_seen_at) WHERE id=?`,
      args: [
        outcome.metadata.doi, outcome.metadata.title, outcome.metadata.title_normalized, outcome.metadata.url,
        outcome.metadata.journal, outcome.metadata.year, outcome.metadata.volume, outcome.metadata.issue,
        outcome.metadata.pages, outcome.status, outcome.firstSeenAt, outcome.publicationId,
      ],
    });
    for (const a of outcome.authors) {
      if (a.id === null) {
        await client.execute({
          sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [outcome.publicationId, a.faculty_id, a.name, a.role, a.role_set_by, a.role_set_at, a.position],
        });
      } else {
        await client.execute({
          sql: `UPDATE publication_authors SET faculty_id=?, role=?, role_set_by=?, role_set_at=? WHERE id=?`,
          args: [a.faculty_id, a.role, a.role_set_by, a.role_set_at, a.id],
        });
      }
    }
  }
}

export async function runIngestScholar(client: Client, opts: RunOptions): Promise<RunSummary> {
  const gmail = await import("../lib/gmail");
  const { parseAlertEmail } = await import("../lib/scholar-alert");
  const crossref = await import("../lib/crossref");
  const ingest = await import("../lib/scholar-ingest");

  const query = process.env.GMAIL_ALERT_QUERY;
  const labelName = process.env.GMAIL_PROCESSED_LABEL_NAME;
  const envLabelId = process.env.GMAIL_PROCESSED_LABEL_ID;
  if (!query) throw new Error("GMAIL_ALERT_QUERY must be set (see .env.example)");
  if (!labelName || !envLabelId) throw new Error("GMAIL_PROCESSED_LABEL_NAME and GMAIL_PROCESSED_LABEL_ID must be set (see .env.example)");
  // Re-bound to a definitely-string const: TS narrowing from the guard above
  // doesn't carry into processEmail, a nested function closing over this
  // scope (same reason lib/crossref.ts re-binds CROSSREF_MAILTO).
  const labelId: string = envLabelId;

  const summary = emptySummary();
  const roster = (await client.execute("SELECT * FROM faculty WHERE active = 1")).rows as unknown as Faculty[];

  let ids = await gmail.listMessages(`${query} -label:${labelName}`);
  if (opts.limit !== null) ids = ids.slice(0, opts.limit);

  // Everything from fetch through the per-article loop for a single email,
  // isolated in its own function so a bug on one email (parser edge case,
  // constraint violation, anything not already handled as
  // CrossrefUnavailableError/retry_later) can be caught per-email below
  // without losing the rest of the batch — mirrors lib/refresh-metadata.ts's
  // per-record isolation.
  async function processEmail(id: string): Promise<void> {
    const message = await gmail.getMessage(id);
    const html = gmail.extractHtmlBody(message);
    if (!html) {
      summary.rejected.no_html_part = (summary.rejected.no_html_part ?? 0) + 1;
      console.log(`[skip] ${id}: no HTML part`);
      return;
    }

    const subject = message.payload.headers?.find((h) => h.name === "Subject")?.value ?? "";
    const parsed = parseAlertEmail(html, subject);
    if (parsed.kind === "rejected") {
      summary.rejected[parsed.reason] = (summary.rejected[parsed.reason] ?? 0) + 1;
      console.log(`[rejected:${parsed.reason}] ${id}: ${parsed.detail}`);
      return;
    }
    summary.parsed++;

    const matchedFaculty = ingest.resolveDiscoveringFaculty(parsed.scholarUserId, roster);
    if (!matchedFaculty) {
      summary.unknownScholarIds.push({ scholarUserId: parsed.scholarUserId, displayName: parsed.displayName });
      console.log(`[skip_unknown_author] ${parsed.displayName} (${parsed.scholarUserId})`);
      // Terminal, known reason — label it so it isn't rescanned every run.
      if (!opts.dryRun) {
        await gmail.applyLabel(id, labelId);
        summary.emailsLabeled++;
      }
      return;
    }
    summary.alertsMatchedToFaculty++;

    const nowIso = new Date().toISOString();
    if (!opts.dryRun) {
      await client.execute({ sql: "UPDATE faculty SET last_alert_seen_at = ? WHERE id = ?", args: [nowIso, matchedFaculty.id] });
    }

    let allTerminal = true;
    const surname = matchedFaculty.display_name.split(",")[0].trim();

    for (const article of parsed.articles) {
      summary.articlesSeen++;
      const discovered: DiscoveredArticle = { title: article.title, year: article.year, scholarUrl: article.scholarUrl };

      const crossrefOutcome = await resolveArticle(crossref, discovered, surname);
      if (crossrefOutcome.kind === "resolved") summary.resolved++;

      const candidateTitle = crossrefOutcome.kind === "resolved" ? crossrefOutcome.resolution.title : discovered.title;
      const candidateDoi = crossrefOutcome.kind === "resolved" ? crossrefOutcome.resolution.doi : null;

      // Re-query fresh every article — never cache a snapshot (§9): two
      // faculty members' alerts for the same paper routinely land in the
      // same run.
      const existingList = (await client.execute("SELECT id, doi, title_normalized FROM publications")).rows as unknown as MatchableExisting[];
      const matchResult = ingest.findCandidateMatch(candidateTitle, candidateDoi, existingList);

      let existingMatch: ExistingMatch | null = null;
      if (matchResult.type === "MATCH") {
        const pubRow = (
          await client.execute({
            sql: "SELECT doi, title, url, journal, year, volume, issue, pages, source, status FROM publications WHERE id = ?",
            args: [matchResult.publicationId],
          })
        ).rows[0] as unknown as MergeableExisting & { status: PublicationStatus };
        const authorRows = (
          await client.execute({
            sql: "SELECT id, faculty_id, name, role, role_set_by, role_set_at, position FROM publication_authors WHERE publication_id = ? ORDER BY position",
            args: [matchResult.publicationId],
          })
        ).rows as unknown as ExistingAuthor[];
        existingMatch = { id: matchResult.publicationId, status: pubRow.status, metadata: pubRow, authors: authorRows };
      }

      const outcome = ingest.decideArticleOutcome(discovered, matchedFaculty, crossrefOutcome, existingMatch, existingList, roster, nowIso);
      tally(summary, outcome, matchedFaculty, candidateTitle);

      if (outcome.kind === "retry_later") {
        allTerminal = false;
        console.log(`[retry_later] "${candidateTitle}": ${outcome.reason}`);
        continue;
      }

      console.log(`[${outcome.kind}] "${candidateTitle}"`);
      if (!opts.dryRun) await applyOutcome(client, outcome);
    }

    if (allTerminal && !opts.dryRun) {
      await gmail.applyLabel(id, labelId);
      summary.emailsLabeled++;
    }
  }

  for (const id of ids) {
    summary.emailsScanned++;
    try {
      await processEmail(id);
    } catch (err) {
      if (err instanceof gmail.GmailUnavailableError) throw err; // Gmail itself is down — abort the whole run, retrying other emails against a dead API wastes time
      console.error(`[error] ${id}: unexpected failure while processing email`, err);
      summary.erroredEmails.push({ id, error: err instanceof Error ? err.message : String(err) });
      // Left unlabeled on purpose, same as retry_later — a future run retries it.
    }
  }

  return summary;
}

async function resolveArticle(
  crossref: typeof import("../lib/crossref"),
  article: DiscoveredArticle,
  surnameHint: string
): Promise<CrossrefOutcome> {
  try {
    const resolution = await crossref.resolveByTitle(article.title, article.year ?? undefined, surnameHint);
    return resolution ? { kind: "resolved", resolution } : { kind: "not_found" };
  } catch (err) {
    if (err instanceof crossref.CrossrefUnavailableError) return { kind: "unavailable", reason: err.message };
    throw err;
  }
}

function tally(summary: RunSummary, outcome: IngestOutcome, matchedFaculty: Faculty, candidateTitle: string): void {
  if (outcome.kind === "merged") summary.merged++;
  if (outcome.kind === "insert_resolved") summary.insertedNew++;
  if (outcome.kind === "insert_needs_metadata") summary.needsMetadata++;
  if (outcome.kind === "retry_later") summary.retryLater++;

  if ((outcome.kind === "merged" || outcome.kind === "insert_resolved") && !outcome.discoveringFacultyLinked) {
    summary.discoveringFacultyNotLinked.push({ publicationTitle: candidateTitle, facultyName: matchedFaculty.display_name });
  }

  if (
    (outcome.kind === "insert_needs_metadata" || outcome.kind === "insert_resolved") &&
    outcome.possibleDuplicateOf.length > 0
  ) {
    summary.possibleDuplicates.push({ newTitle: candidateTitle, existingPublicationIds: outcome.possibleDuplicateOf });
  }

  if ((outcome.kind === "merged" || outcome.kind === "insert_resolved") && outcome.missingJournal) {
    summary.missingJournal.push({ publicationTitle: candidateTitle });
  }
}

function printSummary(s: RunSummary): void {
  console.log(`\n${s.emailsScanned} emails scanned · ${s.parsed} parsed · ${s.alertsMatchedToFaculty} matched to faculty`);
  console.log(`rejected: ${JSON.stringify(s.rejected)}`);
  console.log(`${s.articlesSeen} articles seen · ${s.resolved} resolved · ${s.merged} merged · ${s.insertedNew} inserted new · ${s.needsMetadata} needs_metadata · ${s.retryLater} retry_later`);
  console.log(`${s.emailsLabeled} emails labeled`);

  if (s.unknownScholarIds.length > 0) {
    console.log(`\nUnknown Scholar IDs (${s.unknownScholarIds.length}) — real to-do, someone left the roster or was never added:`);
    for (const u of s.unknownScholarIds) console.log(`  ${u.displayName} (${u.scholarUserId})`);
  }

  if (s.discoveringFacultyNotLinked.length > 0) {
    console.log(`\nDiscovering faculty not linked to their own paper (${s.discoveringFacultyNotLinked.length}) — a roster/Crossref name mismatch (§15.11):`);
    for (const d of s.discoveringFacultyNotLinked) console.log(`  ${d.facultyName} — "${d.publicationTitle}"`);
  }

  if (s.erroredEmails.length > 0) {
    console.log(`\nEmails that errored during processing (${s.erroredEmails.length}) — left unlabeled, will retry next run:`);
    for (const e of s.erroredEmails) console.log(`  ${e.id}: ${e.error}`);
  }

  if (s.possibleDuplicates.length > 0) {
    console.log(`\nPossible duplicates flagged on insert (${s.possibleDuplicates.length}) — similar title already in the database, not auto-merged, needs a human look:`);
    for (const d of s.possibleDuplicates) console.log(`  "${d.newTitle}" ~ existing publication id(s) ${d.existingPublicationIds.join(", ")}`);
  }

  if (s.missingJournal.length > 0) {
    console.log(`\nResolved with no journal name (${s.missingJournal.length}) — Crossref had no container-title for these; not blocked, but the roundup generator (§8c Tab 4, a later session) should check for this before finalizing an edition:`);
    for (const m of s.missingJournal) console.log(`  "${m.publicationTitle}"`);
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");

  const opts = parseArgs(process.argv.slice(2));
  if (opts.dryRun) console.log("--dry-run: parsing, resolving, and deciding only. Nothing will be written or labeled.\n");

  const client = createClient({ url, authToken });
  const summary = await runIngestScholar(client, opts);
  printSummary(summary);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
