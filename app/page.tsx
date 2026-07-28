import type { Metadata } from "next";
import { client } from "@/lib/db";
import { queryPublications } from "@/lib/publications";
import { formatCitation } from "@/lib/citation";
import { PortalSubmitForm } from "./PortalSubmitForm";

export const metadata: Metadata = {
  title: "CHPS Research Roundup",
  description: "Search College of Health Professions and Sciences faculty publications, or add one we're missing.",
};

// §8a: the public portal — no login, no admin fields, no links into /admin/
// anywhere on this page. This is the first fully public, unauthenticated
// route in the codebase; treat it with the same care as anything shown to
// an external audience.
//
// Visibility scope (confirmed, not silently chosen): status='published' AND
// roundup_id IS NOT NULL — only publications that have actually appeared in
// a finalized roundup. A published-but-not-yet-posted record is exactly
// what §8b's private, token-gated personal review page exists to let a
// faculty member confirm before it goes out; showing that same
// not-yet-announced set on this public, search-engine-indexable route would
// scoop COMMS's own announcement and duplicate what §8b is deliberately
// private to provide.
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";

  // excludeAlreadyPosted must be forced false here — its default (true)
  // adds roundup_id IS NULL, which combined with postedOnly's roundup_id IS
  // NOT NULL would AND together into a contradiction and return nothing,
  // always. The two options are orthogonal by design (see
  // lib/publications.ts's PublicationFilters comment); this is the one
  // caller that needs postedOnly without inheriting the other's default.
  const results = q
    ? await queryPublications(client, { searchQuery: q, status: ["published"], postedOnly: true, excludeAlreadyPosted: false })
    : [];

  const submitted = sp.submitted === "1";
  const dupe = typeof sp.dupe === "string" ? sp.dupe : null;
  const dupeLabel = typeof sp.label === "string" ? sp.label : null;

  return (
    <div className="flex flex-col flex-1 items-center bg-white">
      <main className="flex flex-1 w-full max-w-2xl flex-col gap-6 py-16 px-6">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">CHPS Research Roundup</h1>
          <p className="text-sm text-zinc-600 mt-1">Search College of Health Professions and Sciences faculty publications.</p>
        </div>

        {submitted && (
          <div className="border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm px-3.5 py-2.5 rounded-lg">
            Thanks — your submission is on its way to be reviewed.
          </div>
        )}
        {dupe === "posted" && (
          <div className="border border-amber-200 bg-amber-50 text-amber-800 text-sm px-3.5 py-2.5 rounded-lg">
            That paper is already posted{dupeLabel ? ` (edition "${dupeLabel}")` : ""} — search above to find it.
          </div>
        )}
        {dupe === "pending" && (
          <div className="border border-amber-200 bg-amber-50 text-amber-800 text-sm px-3.5 py-2.5 rounded-lg">
            That paper is already collected and queued for a future edition — nothing more to do.
          </div>
        )}

        <form method="GET" className="flex gap-2">
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="Search by title or author name"
            className="flex-1 border border-zinc-300 rounded-md px-3 py-2 text-sm"
          />
          <button type="submit" className="bg-zinc-950 text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-zinc-800">
            Search
          </button>
        </form>

        {q && (
          <div className="flex flex-col gap-3">
            {results.length === 0 && <p className="text-sm text-zinc-500">No matching publications found.</p>}
            {results.map((r) => (
              <div key={r.publication.id} className="text-sm leading-relaxed border-b border-zinc-100 pb-3">
                <p dangerouslySetInnerHTML={{ __html: formatCitation(r.publication, r.authors) }} />
                {r.units.length > 0 && <p className="text-xs text-zinc-500 mt-1">{r.units.join(" · ")}</p>}
              </div>
            ))}
          </div>
        )}

        <div className="pt-4 border-t border-zinc-200">
          <PortalSubmitForm />
        </div>
      </main>
    </div>
  );
}
