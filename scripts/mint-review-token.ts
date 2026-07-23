// ★ STOPGAP / TESTING UTILITY ONLY — NOT the real campaign tool (§8b's
// bulk mailer, out of scope for this session). This exists purely so a
// developer/COMMS can manually mint one review link at a time (e.g. to
// verify the page end-to-end, or to hand-deliver a link while the real
// campaign flow doesn't exist yet).
//
// Run with: npm run mint:review-token -- --faculty <wp_id>
import { config } from "dotenv";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { createReviewRequest } from "../lib/review";

config({ path: path.join(__dirname, "..", ".env.local") });

export function parseArgs(argv: string[]): { facultyWpId: string | null } {
  const facultyFlag = argv.find((a) => a === "--faculty" || a.startsWith("--faculty="));
  let facultyWpId: string | null = null;
  if (facultyFlag) {
    facultyWpId = facultyFlag.includes("=") ? facultyFlag.split("=")[1] : (argv[argv.indexOf(facultyFlag) + 1] ?? null);
  }
  return { facultyWpId };
}

// Thin wrapper over the shared lib/review.ts::createReviewRequest — this
// stopgap CLI is the only caller that still deals in wp_id strings instead
// of faculty ids, so it does its own lookup and delegates the actual insert.
export async function mintReviewToken(client: Client, facultyWpId: string, ttlDays: number): Promise<{ token: string; slug: string }> {
  const facultyResult = await client.execute({
    sql: "SELECT id FROM faculty WHERE wp_id = ?",
    args: [facultyWpId],
  });
  const faculty = facultyResult.rows[0] as unknown as { id: number } | undefined;
  if (!faculty) throw new Error(`No faculty found with wp_id "${facultyWpId}"`);

  return createReviewRequest(client, faculty.id, ttlDays, null);
}

async function main() {
  const { facultyWpId } = parseArgs(process.argv.slice(2));
  if (!facultyWpId) throw new Error("Usage: npm run mint:review-token -- --faculty <wp_id>");

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");

  const appBaseUrl = process.env.APP_BASE_URL;
  if (!appBaseUrl) throw new Error("APP_BASE_URL must be set (see .env.example)");
  const ttlDays = Number(process.env.REVIEW_TOKEN_TTL_DAYS) || 90;

  const client = createClient({ url, authToken });
  const { token, slug } = await mintReviewToken(client, facultyWpId, ttlDays);

  // Printed once, here, and nowhere else — only the hash is ever persisted.
  console.log(`${appBaseUrl}/review/${slug}/${token}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
