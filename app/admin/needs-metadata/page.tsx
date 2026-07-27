import type { Metadata } from "next";
import { client } from "@/lib/db";
import { requireAdminSession } from "../session";
import { queryPublications } from "@/lib/publications";
import type { Faculty } from "@/lib/types";
import { Sidebar } from "../Sidebar";
import { CompletionPanel, type CompletionBanner } from "./CompletionPanel";
import { archivo, inter, jetbrainsMono } from "../fonts";

export const metadata: Metadata = {
  title: "Needs metadata",
};

// §8c Tab 2: the manual completion path for a needs_metadata stub, alongside
// lib/matching.ts::promoteFromNeedsMetadata's untouched automatic path.
//
// The success banner is derived from ?completed=&units=&authors= rather than
// client state — completeNeedsMetadataAction redirects here on success
// instead of returning state, for the same reason the archive's un-stamp
// banner had to move off client state (see complete-actions.ts).
export default async function NeedsMetadataPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminSession();

  const sp = await searchParams;
  const records = await queryPublications(client, { status: ["needs_metadata"], excludeAlreadyPosted: false });
  const facultyOptions = ((await client.execute("SELECT * FROM faculty WHERE active = 1 ORDER BY display_name")).rows as unknown as Faculty[]).map((f) => ({
    ...f,
  }));

  const completedId = typeof sp.completed === "string" ? Number(sp.completed) : NaN;
  const unitsCount = typeof sp.units === "string" ? Number(sp.units) : NaN;
  const authorsCount = typeof sp.authors === "string" ? Number(sp.authors) : NaN;
  const banner: CompletionBanner | null =
    Number.isFinite(completedId) && Number.isFinite(unitsCount) && Number.isFinite(authorsCount)
      ? { publicationId: completedId, units: unitsCount, authors: authorsCount }
      : null;

  return (
    <div className={`flex min-h-screen ${inter.variable} ${archivo.variable} ${jetbrainsMono.variable}`} style={{ fontFamily: "var(--font-inter)" }}>
      <Sidebar active="needs-metadata" />
      <main className="flex-1 px-10 py-8 max-w-4xl">
        <p className="text-2xl font-semibold mb-1" style={{ fontFamily: "var(--font-archivo)" }}>
          Needs metadata
        </p>
        <p className="text-sm text-[#5B5B5B] mb-6">
          Gray-lit discoveries Crossref couldn&apos;t resolve — Scholar found the title but never carries author data. Complete a
          record by hand to move it into the normal merge flow; these never appear in a generated roundup until then.
        </p>

        <CompletionPanel records={records} facultyOptions={facultyOptions} banner={banner} />
      </main>
    </div>
  );
}
