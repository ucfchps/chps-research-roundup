import type { Metadata } from "next";
import { client } from "@/lib/db";
import { requireAdminSession } from "../session";
import { listPendingSubmissions, checkForStaleMatch } from "@/lib/pending-submissions";
import type { Faculty } from "@/lib/types";
import { Sidebar } from "../Sidebar";
import { SubmissionsPanel, type SubmissionBanner } from "./SubmissionsPanel";
import { archivo, inter, jetbrainsMono } from "../fonts";

export const metadata: Metadata = {
  title: "Pending submissions",
};

// §8c Tab 1: the admin side of lib/review-actions.ts::addMissingPublication's
// "genuinely novel" outcome. The staleness check here (checkForStaleMatch)
// is read-only and purely informational — the authoritative re-check that
// actually prevents a duplicate happens at approve time
// (lib/pending-submissions.ts::approvePendingSubmission).
//
// Success banner is derived from ?approved=/?rejected= rather than client
// state, same redirect-based fix applied proactively in Session 25 — a
// reviewed submission leaves this queue, so the confirming component would
// otherwise be exactly the component the action just removed.
export default async function PendingSubmissionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminSession();

  const sp = await searchParams;
  const submissions = await listPendingSubmissions(client);
  const withStaleCheck = await Promise.all(
    submissions.map(async (s) => ({ ...s, staleMatch: await checkForStaleMatch(client, s.payload) }))
  );
  const facultyOptions = ((await client.execute("SELECT * FROM faculty WHERE active = 1 ORDER BY display_name")).rows as unknown as Faculty[]).map((f) => ({ ...f }));

  let banner: SubmissionBanner | null = null;
  if (typeof sp.approved === "string") {
    const submissionId = Number(sp.approved);
    const publicationId = typeof sp.publicationId === "string" ? Number(sp.publicationId) : undefined;
    if (Number.isFinite(submissionId)) banner = { submissionId, kind: "approved", publicationId, linked: sp.linked === "true" };
  } else if (typeof sp.rejected === "string") {
    const submissionId = Number(sp.rejected);
    if (Number.isFinite(submissionId)) banner = { submissionId, kind: "rejected" };
  }

  return (
    <div className={`flex min-h-screen ${inter.variable} ${archivo.variable} ${jetbrainsMono.variable}`} style={{ fontFamily: "var(--font-inter)" }}>
      <Sidebar active="pending-submissions" />
      <main className="flex-1 px-10 py-8 max-w-4xl">
        <p className="text-2xl font-semibold mb-1" style={{ fontFamily: "var(--font-archivo)" }}>
          Pending submissions
        </p>
        <p className="text-sm text-[#5B5B5B] mb-6">
          Faculty-submitted publications from the personal review page, awaiting COMMS review before going out under the
          college&apos;s name. Approve publishes it directly; reject leaves nothing behind in Publications.
        </p>

        <SubmissionsPanel submissions={withStaleCheck} facultyOptions={facultyOptions} banner={banner} />
      </main>
    </div>
  );
}
