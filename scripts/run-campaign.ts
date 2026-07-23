// Session 16 (§8c Tab 3, build-order item 16): the bulk version of what
// scripts/mint-review-token.ts proved works for one person by hand. Mints a
// review_requests token and sends the invitation email (lib/gmail.ts::sendMessage)
// for every faculty member lib/campaigns.ts::getFacultyNeedingReview returns —
// explicitly skips everyone else, per §8c Tab 3 / §15.13.
//
// Run with:
//   npm run campaign:run -- --cycle-label "<label>" --dry-run
//   npm run campaign:run -- --cycle-label "<label>"
//   npm run campaign:run -- --cycle-label "<label>" --faculty <wp_id>   (small,
//     deliberate test slice — repeat --faculty for more than one person.
//     Sending a broken template to 60+ real inboxes is a worse failure mode
//     than most bugs in this project; scope a real run before going wide.)
//   npm run campaign:run -- --faculty <wp_id> --test-recipient <email>   (real
//     selection, real mint, real review_requests row, real send — just
//     delivered to <email> instead of the real faculty address, so you can
//     click a genuinely real link without it landing in a colleague's inbox.
//     --cycle-label defaults to today's date if omitted.)
//
// ★ --test-recipient is a CLI flag ONLY, never an env var default. An env
// default is exactly the kind of setting that's easy to leave on past the
// testing phase (silently redirecting every future real send to you) or
// easy to forget to set right before a run that should have been
// redirected. Typing it every time is the point.
import { config } from "dotenv";
import path from "node:path";
import { createClient } from "@libsql/client";
import { runCampaign, type CampaignRunResult } from "../lib/campaigns";

config({ path: path.join(__dirname, "..", ".env.local") });

export function parseArgs(argv: string[]): {
  cycleLabel: string;
  dryRun: boolean;
  facultyWpIds: string[] | null;
  testRecipient: string | null;
} {
  const dryRun = argv.includes("--dry-run");

  const cycleLabelFlag = argv.find((a) => a === "--cycle-label" || a.startsWith("--cycle-label="));
  const cycleLabel = cycleLabelFlag
    ? cycleLabelFlag.includes("=")
      ? cycleLabelFlag.split("=")[1]
      : (argv[argv.indexOf(cycleLabelFlag) + 1] ?? new Date().toISOString().slice(0, 10))
    : new Date().toISOString().slice(0, 10);

  const facultyWpIds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--faculty" && argv[i + 1]) facultyWpIds.push(argv[i + 1]);
    else if (argv[i].startsWith("--faculty=")) facultyWpIds.push(argv[i].split("=")[1]);
  }

  const testRecipientFlag = argv.find((a) => a === "--test-recipient" || a.startsWith("--test-recipient="));
  let testRecipient: string | null = null;
  if (testRecipientFlag) {
    testRecipient = testRecipientFlag.includes("=") ? testRecipientFlag.split("=")[1] : (argv[argv.indexOf(testRecipientFlag) + 1] ?? null);
  }

  return { cycleLabel, dryRun, facultyWpIds: facultyWpIds.length > 0 ? facultyWpIds : null, testRecipient };
}

function printSummary(r: CampaignRunResult): void {
  if (r.dryRun) console.log("--dry-run: nothing minted, nothing sent.\n");
  console.log(`Cycle: "${r.cycleLabel}"`);
  console.log(`${r.eligibleCount} eligible.`);

  console.log(`\n${r.sent.length} ${r.dryRun ? "would be sent" : "sent"}:`);
  for (const name of r.sent) console.log(`  ${name}`);

  if (r.skippedAlreadyActive.length > 0) {
    console.log(`\n${r.skippedAlreadyActive.length} skipped — already has an active token for this cycle:`);
    for (const name of r.skippedAlreadyActive) console.log(`  ${name}`);
  }

  if (r.sendFailures.length > 0) {
    console.log(`\n${r.sendFailures.length} send failure(s):`);
    for (const f of r.sendFailures) console.log(`  ${f.displayName} (${f.email ?? "no email on file"}): ${f.error}`);
  }

  if (r.testRedirects.length > 0) {
    console.log(`\n★★★ TEST MODE: ${r.testRedirects.length} email(s) redirected — nothing went to a real faculty inbox: ★★★`);
    for (const t of r.testRedirects) console.log(`  ${t.displayName} — would have gone to ${t.realEmail}`);
  }
}

async function main() {
  const { cycleLabel, dryRun, facultyWpIds, testRecipient } = parseArgs(process.argv.slice(2));

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");

  const appBaseUrl = process.env.APP_BASE_URL;
  if (!appBaseUrl) throw new Error("APP_BASE_URL must be set (see .env.example)");
  const emailFrom = process.env.REVIEW_EMAIL_FROM;
  if (!emailFrom) throw new Error("REVIEW_EMAIL_FROM must be set (see .env.example)");
  const emailReplyTo = process.env.REVIEW_EMAIL_REPLY_TO;
  if (!emailReplyTo) throw new Error("REVIEW_EMAIL_REPLY_TO must be set (see .env.example)");
  const ttlDays = Number(process.env.REVIEW_TOKEN_TTL_DAYS) || 90;

  const client = createClient({ url, authToken });
  const result = await runCampaign(client, cycleLabel, { dryRun, ttlDays, appBaseUrl, emailFrom, emailReplyTo, facultyWpIds, testRecipient });
  printSummary(result);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
