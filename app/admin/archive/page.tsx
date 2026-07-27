import type { Metadata } from "next";
import { client } from "@/lib/db";
import { requireAdminSession } from "../session";
import { listRoundups } from "@/lib/roundup-finalize";
import { Sidebar } from "../Sidebar";
import { ArchivePanel, type UnstampBanner } from "./ArchivePanel";
import { archivo, inter, jetbrainsMono } from "../fonts";

export const metadata: Metadata = {
  title: "Roundup archive",
};

// §8c Tab 5: read-only by default — listRoundups is a SELECT, nothing here
// writes. The only write on this whole route is the explicit, confirmed
// un-stamp action (unstamp-actions.ts).
//
// The success banner is derived from ?reversed=&count=&label= rather than
// client state: unstampAction redirects here on success instead of
// returning state, specifically so the confirmation doesn't depend on a
// client component surviving its own reversal — see unstamp-actions.ts for
// the failure mode that forced this.
export default async function ArchivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminSession();

  const sp = await searchParams;
  const roundups = await listRoundups(client);

  const reversedId = typeof sp.reversed === "string" ? Number(sp.reversed) : NaN;
  const reversedCount = typeof sp.count === "string" ? Number(sp.count) : NaN;
  const banner: UnstampBanner | null =
    Number.isFinite(reversedId) && Number.isFinite(reversedCount)
      ? { roundupId: reversedId, count: reversedCount, label: typeof sp.label === "string" ? sp.label : null }
      : null;

  return (
    <div className={`flex min-h-screen ${inter.variable} ${archivo.variable} ${jetbrainsMono.variable}`} style={{ fontFamily: "var(--font-inter)" }}>
      <Sidebar active="archive" />
      <main className="flex-1 px-10 py-8 max-w-4xl">
        <p className="text-2xl font-semibold mb-1" style={{ fontFamily: "var(--font-archivo)" }}>
          Roundup archive
        </p>
        <p className="text-sm text-[#5B5B5B] mb-6">
          Every past edition, exactly as it was published — the stored HTML is a read-only audit record, never edited in place. To
          change what an edition contains: un-stamp it, fix the underlying records, then regenerate and re-finalize from the
          Publications tab.
        </p>

        <ArchivePanel roundups={roundups} banner={banner} />
      </main>
    </div>
  );
}
