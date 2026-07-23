// Session 16 (§8c Tab 3, build-order item 16): the bulk version of what the
// personal review page (§8b) proved works for one person by hand. Every
// eligibility decision here reuses lib/review.ts's getReviewablePublications
// / unidentifiedCoAuthors — the exact functions the review page itself
// calls — so "has something to review" can never drift between the page and
// who gets emailed. §15.13: never email someone with nothing to review.
import type { Client } from "@libsql/client";
import { createReviewRequest, getReviewablePublications, unidentifiedCoAuthors } from "./review";
import { sendMessage as realSendMessage, type SendMessageInput } from "./gmail";

export interface FacultyReviewNeed {
  facultyId: number;
  wpId: string | null;
  slug: string;
  displayName: string;
  email: string | null;
  queuedPublicationCount: number;
  unidentifiedCoAuthorCount: number;
}

export async function getFacultyNeedingReview(client: Client): Promise<FacultyReviewNeed[]> {
  const facultyRows = (
    await client.execute("SELECT id, slug, wp_id, display_name, email FROM faculty WHERE active = 1")
  ).rows as unknown as Array<{ id: number; slug: string | null; wp_id: string | null; display_name: string; email: string | null }>;

  const needs: FacultyReviewNeed[] = [];
  for (const f of facultyRows) {
    // Same query the review page itself uses (lib/review.ts::getReviewablePublications)
    // — a publication shows up here iff facultyId has ANY row on it, roundup_id
    // IS NULL, and status != 'rejected'. That single definition covers both
    // "has a paper of their own queued" and "is confirmed on a paper with an
    // unknown co-author" — no second query to keep in sync.
    const pubs = await getReviewablePublications(client, f.id);
    if (pubs.length === 0) continue;

    const unidentifiedCount = pubs.reduce((sum, pub) => sum + unidentifiedCoAuthors(pub, f.id).length, 0);

    needs.push({
      facultyId: f.id,
      wpId: f.wp_id,
      slug: f.slug ?? f.wp_id ?? String(f.id),
      displayName: f.display_name,
      email: f.email,
      queuedPublicationCount: pubs.length,
      unidentifiedCoAuthorCount: unidentifiedCount,
    });
  }
  return needs;
}

export interface CampaignPlanEntry extends FacultyReviewNeed {
  alreadyHasActiveToken: boolean;
}

export interface CampaignPlan {
  cycleLabel: string;
  entries: CampaignPlanEntry[];
}

// Separates "decide who/what" from "actually write tokens and call Gmail" —
// same split as lib/release.ts::selectForRelease vs scripts/release-buffer.ts's
// UPDATE. This is what --dry-run renders.
export async function buildCampaignPlan(client: Client, cycleLabel: string): Promise<CampaignPlan> {
  const needs = await getFacultyNeedingReview(client);
  const now = new Date().toISOString();

  const entries: CampaignPlanEntry[] = [];
  for (const need of needs) {
    const existing = await client.execute({
      sql: `SELECT 1 FROM review_requests WHERE faculty_id = ? AND cycle_label = ? AND revoked = 0 AND expires_at > ?`,
      args: [need.facultyId, cycleLabel, now],
    });
    entries.push({ ...need, alreadyHasActiveToken: existing.rows.length > 0 });
  }

  return { cycleLabel, entries };
}

// Pure — no I/O. §8b "The email" + §15.13: lead with the student-credit
// framing, tailor real counts, never a "0 items" email (never called for a
// zero-need faculty member in the first place, since they never make it into
// getFacultyNeedingReview's output).
export function buildInvitationEmail(need: FacultyReviewNeed, reviewLink: string): { subject: string; body: string } {
  const parts: string[] = [];
  if (need.queuedPublicationCount > 0) {
    parts.push(`${need.queuedPublicationCount} publication${need.queuedPublicationCount === 1 ? "" : "s"} queued for the next CHPS Research Roundup`);
  }
  if (need.unidentifiedCoAuthorCount > 0) {
    parts.push(`${need.unidentifiedCoAuthorCount} co-author${need.unidentifiedCoAuthorCount === 1 ? "" : "s"} we couldn't identify`);
  }
  const summary = parts.join(" and ");
  const surname = need.displayName.split(",")[0];

  const subject = "Help us credit your students in the CHPS Research Roundup";
  const body = [
    `Dr. ${surname} — you have ${summary}.`,
    "",
    reviewLink,
    "",
    "Make sure your students get credit in the college's research post.",
  ].join("\n");

  return { subject, body };
}

export interface RunCampaignOptions {
  dryRun: boolean;
  ttlDays: number;
  appBaseUrl: string;
  emailFrom: string;
  emailReplyTo: string;
  // Restrict the run to these wp_ids only — a small, deliberate test slice
  // before sending to the full eligible roster. Omit/null for everyone.
  facultyWpIds?: string[] | null;
  // Redirects every actual send to this address instead of the real
  // faculty email — selection, minting, and the review_requests write are
  // untouched, only the To: header and a subject tag change. Deliberately a
  // per-call option, never an env default (scripts/run-campaign.ts requires
  // it as an explicit CLI flag on every invocation) — see that file's header
  // comment for why an env-var default would be the wrong shape here.
  testRecipient?: string | null;
  sendMessageFn?: (input: SendMessageInput) => Promise<void>;
}

export interface SendFailure {
  displayName: string;
  email: string | null;
  error: string;
}

export interface TestRedirect {
  displayName: string;
  realEmail: string;
}

export interface CampaignRunResult {
  cycleLabel: string;
  dryRun: boolean;
  eligibleCount: number;
  sent: string[];
  skippedAlreadyActive: string[];
  sendFailures: SendFailure[];
  testRedirects: TestRedirect[];
}

// The mint/send layer. Skip-if-nothing is structural here, not just at
// selection: an empty plan means this loop body never runs, so zero mints
// and zero sends regardless of anything upstream.
export async function runCampaign(client: Client, cycleLabel: string, opts: RunCampaignOptions): Promise<CampaignRunResult> {
  const sendMessageFn = opts.sendMessageFn ?? realSendMessage;
  const plan = await buildCampaignPlan(client, cycleLabel);

  const scopedEntries = opts.facultyWpIds ? plan.entries.filter((e) => e.wpId && opts.facultyWpIds!.includes(e.wpId)) : plan.entries;

  const result: CampaignRunResult = {
    cycleLabel,
    dryRun: opts.dryRun,
    eligibleCount: scopedEntries.length,
    sent: [],
    skippedAlreadyActive: [],
    sendFailures: [],
    testRedirects: [],
  };

  for (const entry of scopedEntries) {
    if (entry.alreadyHasActiveToken) {
      result.skippedAlreadyActive.push(entry.displayName);
      continue;
    }

    // Surfaced even in dry-run — a missing address is exactly the kind of
    // thing worth catching before a real batch send, not after.
    if (!entry.email) {
      result.sendFailures.push({ displayName: entry.displayName, email: null, error: "no email on file" });
      continue;
    }

    if (opts.dryRun) {
      result.sent.push(entry.displayName);
      continue;
    }

    // Real token, real review_requests row, real link — identical to a
    // normal run regardless of testRecipient. Only delivery changes, below.
    const { token } = await createReviewRequest(client, entry.facultyId, opts.ttlDays, cycleLabel);
    const link = `${opts.appBaseUrl}/review/${entry.slug}/${token}`;
    const { subject, body } = buildInvitationEmail(entry, link);

    const to = opts.testRecipient ?? entry.email;
    // Unmistakable even out of context — if this sits in an inbox or gets
    // forwarded later, it must never read as a real notice about a colleague.
    const outgoingSubject = opts.testRecipient ? `[TEST — would send to ${entry.email}] ${subject}` : subject;

    try {
      await sendMessageFn({ to, from: opts.emailFrom, replyTo: opts.emailReplyTo, subject: outgoingSubject, body });
      result.sent.push(entry.displayName);
      if (opts.testRecipient) result.testRedirects.push({ displayName: entry.displayName, realEmail: entry.email });
    } catch (err) {
      result.sendFailures.push({ displayName: entry.displayName, email: entry.email, error: (err as Error).message });
    }
  }

  return result;
}

export interface CampaignStatusEntry {
  displayName: string;
  email: string | null;
  openedAt: string | null;
  completedAt: string | null;
}

export interface CampaignStatus {
  cycleLabel: string;
  totalSent: number;
  openedCount: number;
  completedCount: number;
  notYetOpened: CampaignStatusEntry[];
}

// Stand-in for Tab 3's response dashboard until the /admin UI exists
// (mirrors coverage-report / report-unconfirmed-matches). Reports whatever
// opened_at/completed_at actually say — if nothing has ever completed a
// review, that's 0, honestly, not a bug in this query.
export async function getCampaignStatus(client: Client, cycleLabel: string): Promise<CampaignStatus> {
  const rows = (
    await client.execute({
      sql: `SELECT f.display_name as displayName, f.email, rr.opened_at as openedAt, rr.completed_at as completedAt
            FROM review_requests rr
            JOIN faculty f ON f.id = rr.faculty_id
            WHERE rr.cycle_label = ?`,
      args: [cycleLabel],
    })
  ).rows as unknown as CampaignStatusEntry[];

  return {
    cycleLabel,
    totalSent: rows.length,
    openedCount: rows.filter((r) => r.openedAt !== null).length,
    completedCount: rows.filter((r) => r.completedAt !== null).length,
    notYetOpened: rows.filter((r) => r.openedAt === null),
  };
}
