import type { Metadata } from "next";
import { client } from "@/lib/db";
import { requireAdminSession } from "../session";
import { queryPublications, type PublicationFilters, type PublicationWithUnits } from "@/lib/publications";
import { formatCitation, sortCitationsWithinUnit } from "@/lib/citation";
import { UNITS, type PublicationStatus, type Unit } from "@/lib/types";
import { ExportPanel } from "./ExportPanel";
import { Sidebar } from "./Sidebar";
import { FilterChip } from "./FilterChip";
import { archivo, inter, jetbrainsMono } from "../fonts";

export const metadata: Metadata = {
  title: "Publications",
};

const STATUS_OPTIONS: Array<{ value: PublicationStatus; label: string }> = [
  { value: "published", label: "Published" },
  { value: "pending_merge", label: "Pending merge" },
  { value: "needs_metadata", label: "Needs metadata" },
  { value: "rejected", label: "Rejected" },
];

// Shorter labels than the canonical UNITS strings, matching the reference's
// pill treatment — display-only, never used for filtering/matching logic.
const UNIT_LABELS: Record<Unit, string> = {
  "Department of Health Sciences": "Health Sciences",
  "School of Communication Sciences and Disorders": "Comm. Sciences and Disorders",
  "School of Kinesiology and Rehabilitation Sciences": "Kinesiology and Rehab Sciences",
  "School of Social Work": "Social Work",
  "Center for Autism and Related Disabilities": "Autism and Related Disabilities",
};

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

  // Same field drives the dot AND this count — see lib/publications.ts's
  // `ready`. Never two independent computations of "needs review."
  const notReadyCount = results.filter((r) => !r.ready).length;
  const zeroUnitCount = results.filter((r) => r.units.length === 0).length;

  const resultsById = new Map<number, PublicationWithUnits>(results.map((r) => [r.publication.id, r]));
  const sorted = sortCitationsWithinUnit(results.map((r) => ({ publication: r.publication, authors: r.authors })));

  return (
    <div className={`flex min-h-screen ${inter.variable} ${archivo.variable} ${jetbrainsMono.variable}`} style={{ fontFamily: "var(--font-inter)" }}>
      <Sidebar />
      <main className="flex-1 px-10 py-8 max-w-4xl">
        <p className="text-2xl font-semibold mb-1" style={{ fontFamily: "var(--font-archivo)" }}>
          Publications
        </p>
        <p className="text-sm text-[#5B5B5B] mb-6">Browse, filter, and export — nothing here marks a publication as posted.</p>

        <form method="get" className="border border-[#E5E5E5] rounded-xl bg-white p-5 mb-7 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="grid grid-cols-3 gap-5 mb-5">
            <div>
              <label htmlFor="q" className="block text-[11px] uppercase tracking-wide text-[#8A8A8A] mb-1.5">
                Person
              </label>
              <input
                type="text"
                id="q"
                name="q"
                defaultValue={filters.facultyQuery ?? ""}
                placeholder="Author name"
                className="w-full border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
              />
            </div>
            <div>
              <label htmlFor="from" className="block text-[11px] uppercase tracking-wide text-[#8A8A8A] mb-1.5">
                Collected on or after
              </label>
              <input
                type="date"
                id="from"
                name="from"
                defaultValue={filters.dateAddedFrom ?? ""}
                className="w-full border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
              />
            </div>
            <div>
              <label htmlFor="to" className="block text-[11px] uppercase tracking-wide text-[#8A8A8A] mb-1.5">
                Collected on or before
              </label>
              <input
                type="date"
                id="to"
                name="to"
                defaultValue={filters.dateAddedTo ?? ""}
                className="w-full border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
              />
            </div>
          </div>
          <p className="text-xs text-[#9A9A9A] -mt-3 mb-5">
            These filter on when a publication was <em>collected</em>, not when it was published — see §6b.
          </p>

          <span className="block text-[11px] uppercase tracking-wide text-[#8A8A8A] mb-2">Unit (matches any selected)</span>
          <div className="flex flex-wrap gap-2 mb-5">
            {UNITS.map((unit) => (
              <FilterChip key={unit} name="units" value={unit} label={UNIT_LABELS[unit]} defaultChecked={selectedUnits.includes(unit)} />
            ))}
          </div>

          <span className="block text-[11px] uppercase tracking-wide text-[#8A8A8A] mb-2">Status</span>
          <div className="flex flex-wrap gap-2 mb-5">
            {STATUS_OPTIONS.map((s) => (
              <FilterChip key={s.value} name="status" value={s.value} label={s.label} defaultChecked={activeStatuses.includes(s.value)} />
            ))}
            <FilterChip name="includePosted" value="1" label="Include already posted" defaultChecked={includePosted} />
          </div>

          <button type="submit" className="bg-[#0A0A0A] text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-[#1A1A1A] transition-colors">
            Apply filters
          </button>
        </form>

        <div className="flex items-center gap-3 mb-1.5">
          <span className="text-sm">
            <span className="font-semibold text-base" style={{ fontFamily: "var(--font-archivo)" }}>
              {results.length}
            </span>{" "}
            publication{results.length === 1 ? "" : "s"} match{results.length === 1 ? "es" : ""} the current filters
          </span>
        </div>

        {notReadyCount > 0 && (
          <div className="flex items-start gap-2 bg-[#FFF8E1] border border-[#F5E2A3] text-[#7A5D00] text-sm px-3.5 py-2 rounded-lg mb-3">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            {notReadyCount} of these have unreviewed co-authors — they won&apos;t render with a student asterisk until confirmed via
            the review page.
          </div>
        )}
        {zeroUnitCount > 0 && (
          <div className="flex items-start gap-2 bg-[#FDEDEC] border border-[#F3C6C2] text-[#7A2E26] text-sm px-3.5 py-2 rounded-lg mb-3">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            {zeroUnitCount} of these have no linked CHPS faculty author and belong to no unit — they will not appear in a real
            roundup.
          </div>
        )}

        <div className="space-y-1 mb-9 mt-6">
          {results.length === 0 && <p className="text-[#9A9A9A] text-sm px-1">No publications match the current filters.</p>}

          {sorted.map((item) => {
            const entry = resultsById.get(item.publication.id)!;
            return (
              <div key={item.publication.id} className="flex gap-3 px-4 py-3.5 rounded-lg hover:bg-[#F5F5F5] transition-colors group">
                <div
                  className={`w-1.5 h-1.5 rounded-full mt-2 shrink-0 ${entry.ready ? "bg-ucf-gold" : "bg-[#D8D8D8]"}`}
                  title={entry.ready ? "Ready for next roundup" : "Has unreviewed co-authors"}
                />
                <div className="flex-1">
                  <p
                    className="text-sm leading-relaxed [&_a]:text-[#8A6A00] [&_a]:hover:underline"
                    dangerouslySetInnerHTML={{ __html: formatCitation(item.publication, item.authors) }}
                  />
                  <div className="flex items-center gap-2 flex-wrap mt-1.5">
                    <span className="text-[11px] text-[#9A9A9A]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                      collected {entry.publication.date_added}
                    </span>
                    {entry.units.map((unit) => (
                      <span key={unit} className="text-[11px] px-2 py-0.5 rounded-full bg-[#F0F0F0] text-[#6B6B6B]">
                        {UNIT_LABELS[unit]}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {results.length > 0 && (
          <div className="flex items-center gap-4 text-[11px] text-[#9A9A9A] mb-9 px-1">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-ucf-gold" /> Ready — all co-authors reviewed
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#D8D8D8]" /> Has unreviewed co-authors
            </span>
          </div>
        )}

        <ExportPanel results={results} />
      </main>
    </div>
  );
}
