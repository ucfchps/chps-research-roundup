import type { Metadata } from "next";
import { client } from "@/lib/db";
import { requireAdminSession } from "../session";
import { listRoundups } from "@/lib/roundup-finalize";
import { Sidebar } from "../Sidebar";
import { ArchivePanel } from "./ArchivePanel";
import { archivo, inter, jetbrainsMono } from "../fonts";

export const metadata: Metadata = {
  title: "Roundup archive",
};

// §8c Tab 5: read-only by default — listRoundups is a SELECT, nothing here
// writes. The only write on this whole route is the explicit, confirmed
// un-stamp action inside ArchivePanel (Session 24).
export default async function ArchivePage() {
  await requireAdminSession();

  const roundups = await listRoundups(client);

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

        <ArchivePanel roundups={roundups} />
      </main>
    </div>
  );
}
