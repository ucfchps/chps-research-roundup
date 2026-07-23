import type { Metadata } from "next";
import { client } from "@/lib/db";
import { requireAdminSession } from "../session";
import { queryPublications, type PublicationFilters } from "@/lib/publications";
import { formatCitation, sortCitationsWithinUnit } from "@/lib/citation";
import { UNITS, type PublicationStatus, type Unit } from "@/lib/types";
import { ExportPanel } from "./ExportPanel";

export const metadata: Metadata = {
  title: "Publications",
};

const STATUS_OPTIONS: PublicationStatus[] = ["published", "pending_merge", "needs_metadata", "rejected"];

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseFilters(sp: Record<string, string | string[] | undefined>): PublicationFilters {
  const facultyQuery = typeof sp.q === "string" && sp.q.trim() ? sp.q.trim() : undefined;
  const units = toArray(sp.units) as Unit[];
  const status = toArray(sp.status) as PublicationStatus[];
  const dateAddedFrom = typeof sp.from === "string" && sp.from ? sp.from : undefined;
  const dateAddedTo = typeof sp.to === "string" && sp.to ? sp.to : undefined;
  const excludeAlreadyPosted = sp.includePosted === "1" ? false : true;

  return {
    facultyQuery,
    units: units.length > 0 ? units : undefined,
    status: status.length > 0 ? status : undefined,
    dateAddedFrom,
    dateAddedTo,
    excludeAlreadyPosted,
  };
}

export default async function PublicationsPage({
  searchParams,
}: {
  // Next.js 15: searchParams is async in Server Components.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminSession();

  const sp = await searchParams;
  const filters = parseFilters(sp);
  const results = await queryPublications(client, filters);

  const activeStatuses = filters.status ?? ["published"];
  const selectedUnits = filters.units ?? [];
  const includePosted = !filters.excludeAlreadyPosted;

  const unknownCoAuthorCount = results.filter((r) => r.authors.some((a) => a.role === "unknown")).length;
  const zeroUnitCount = results.filter((r) => r.units.length === 0).length;

  // Group by derived unit unless exactly one unit filter narrows it — a flat
  // list reads better when the grouping would be a single, redundant header.
  const groupByUnit = selectedUnits.length !== 1;
  const presentUnits = UNITS.filter((unit) => results.some((r) => r.units.includes(unit)));

  return (
    <main className="max-w-4xl mx-auto py-12 px-6 flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold">Publications</h1>
        <p className="mt-1 text-zinc-600">Browse, filter, and export — nothing here marks a publication as posted.</p>
      </header>

      <form method="get" className="border rounded-lg p-4 flex flex-col gap-4">
        <label className="text-sm flex flex-col gap-1 max-w-sm">
          Person
          <input type="text" name="q" defaultValue={filters.facultyQuery ?? ""} placeholder="Author name" className="border rounded px-3 py-1.5" />
        </label>

        <div>
          <span className="text-sm font-medium text-zinc-600">Unit (matches any selected)</span>
          <div className="flex flex-wrap gap-3 mt-1">
            {UNITS.map((unit) => (
              <label key={unit} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="units" value={unit} defaultChecked={selectedUnits.includes(unit)} />
                {unit}
              </label>
            ))}
          </div>
        </div>

        <div className="flex gap-4 flex-wrap">
          <label className="text-sm flex flex-col gap-1">
            Collected on or after
            <input type="date" name="from" defaultValue={filters.dateAddedFrom ?? ""} className="border rounded px-2 py-1" />
          </label>
          <label className="text-sm flex flex-col gap-1">
            Collected on or before
            <input type="date" name="to" defaultValue={filters.dateAddedTo ?? ""} className="border rounded px-2 py-1" />
          </label>
        </div>
        <p className="text-xs text-zinc-500 -mt-2">
          These filter on when a publication was <em>collected</em>, not when it was published — see §6b.
        </p>

        <div>
          <span className="text-sm font-medium text-zinc-600">Status</span>
          <div className="flex flex-wrap gap-3 mt-1">
            {STATUS_OPTIONS.map((s) => (
              <label key={s} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="status" value={s} defaultChecked={activeStatuses.includes(s)} />
                {s}
              </label>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" name="includePosted" value="1" defaultChecked={includePosted} />
          Include publications already posted in a past roundup
        </label>

        <button type="submit" className="rounded bg-black text-white px-4 py-2 self-start">
          Apply filters
        </button>
      </form>

      <div className="text-sm text-zinc-600 flex flex-col gap-1">
        <p>
          {results.length} publication{results.length === 1 ? "" : "s"} match{results.length === 1 ? "es" : ""} the current filters.
        </p>
        {unknownCoAuthorCount > 0 && (
          <p className="text-amber-700">
            ⚠ {unknownCoAuthorCount} of these have unreviewed (unknown-role) co-authors — they will render with no student
            asterisk until confirmed via the review page.
          </p>
        )}
        {zeroUnitCount > 0 && (
          <p className="text-red-700">
            ⚠ {zeroUnitCount} of these have no linked CHPS faculty author and belong to no unit — they will not appear in any
            unit section below, or in a real roundup.
          </p>
        )}
      </div>

      <section className="flex flex-col gap-6">
        {results.length === 0 && <p className="text-zinc-500 text-sm">No publications match the current filters.</p>}

        {groupByUnit
          ? presentUnits.map((unit) => {
              const inUnit = results.filter((r) => r.units.includes(unit));
              const sorted = sortCitationsWithinUnit(inUnit.map((r) => ({ publication: r.publication, authors: r.authors })));
              return (
                <div key={unit}>
                  <h2 className="font-semibold text-lg border-b pb-1 mb-3">{unit}</h2>
                  <div className="flex flex-col gap-2">
                    {sorted.map((item) => (
                      <p key={item.publication.id} dangerouslySetInnerHTML={{ __html: formatCitation(item.publication, item.authors) }} />
                    ))}
                  </div>
                </div>
              );
            })
          : (() => {
              const sorted = sortCitationsWithinUnit(results.map((r) => ({ publication: r.publication, authors: r.authors })));
              return (
                <div className="flex flex-col gap-2">
                  {sorted.map((item) => (
                    <p key={item.publication.id} dangerouslySetInnerHTML={{ __html: formatCitation(item.publication, item.authors) }} />
                  ))}
                </div>
              );
            })()}
      </section>

      <ExportPanel results={results} />
    </main>
  );
}
