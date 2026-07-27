"use client";

// §8c Tab 2 (Session 25): the queue list and the per-record completion form.
// Author editor + live citation preview reuse lib/citation.ts directly
// (formatCitation, unitsForPublication) — the exact same formatter Tabs 4/5
// use, so what a reviewer sees here is provably what would actually
// publish, not a guess. Acknowledgment-gate UX mirrors FinalizePanel's
// existing zero-unit-acknowledgment pattern (app/admin/publications/
// FinalizePanel.tsx) rather than inventing a new convention.
import { useActionState, useMemo, useState } from "react";
import { formatCitation } from "@/lib/citation";
import type { PublicationWithUnits } from "@/lib/publications";
import type { AuthorRole, Faculty, Publication, PublicationAuthor } from "@/lib/types";
import { completeNeedsMetadataAction } from "./complete-actions";
import { initialCompletionFormState } from "./complete-shared";

export interface CompletionBanner {
  publicationId: number;
  units: number;
  authors: number;
}

const ROLE_OPTIONS: Array<{ value: AuthorRole; label: string }> = [
  { value: "chps_faculty", label: "CHPS faculty" },
  { value: "grad_student", label: "Grad student" },
  { value: "undergrad_student", label: "Undergrad student" },
  { value: "external", label: "Not CHPS" },
];

interface DraftAuthor {
  name: string;
  role: AuthorRole;
  facultyId: number | null;
}

function whatsMissing(pub: Publication, authorCount: number): string[] {
  const missing: string[] = [];
  if (!pub.journal) missing.push("journal");
  if (!pub.volume && !pub.issue && !pub.pages) missing.push("volume/issue/pages");
  if (!pub.doi) missing.push("DOI");
  if (authorCount === 0) missing.push("authors");
  return missing;
}

function RecordCard({ record, facultyOptions, facultyById }: { record: PublicationWithUnits; facultyOptions: Faculty[]; facultyById: Record<number, Faculty> }) {
  const { publication: pub, authors: existingAuthors } = record;
  const [expanded, setExpanded] = useState(false);

  const [draftAuthors, setDraftAuthors] = useState<DraftAuthor[]>(
    existingAuthors.length > 0
      ? [...existingAuthors].sort((a, b) => a.position - b.position).map((a) => ({ name: a.name, role: a.role === "unknown" ? "external" : a.role, facultyId: a.faculty_id }))
      : [{ name: "", role: "chps_faculty", facultyId: null }]
  );
  const [journal, setJournal] = useState(pub.journal ?? "");
  const [volume, setVolume] = useState(pub.volume ?? "");
  const [issue, setIssue] = useState(pub.issue ?? "");
  const [pages, setPages] = useState(pub.pages ?? "");
  const [doi, setDoi] = useState(pub.doi ?? "");
  const [completedBy, setCompletedBy] = useState("");
  const [ackMissingJournal, setAckMissingJournal] = useState(false);
  const [ackZeroLinked, setAckZeroLinked] = useState(false);

  const [state, formAction, pending] = useActionState(completeNeedsMetadataAction, initialCompletionFormState);

  const facultyByDisplayName = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of facultyOptions) m.set(f.display_name, f.id);
    return m;
  }, [facultyOptions]);

  const filledAuthors = draftAuthors.filter((a) => a.name.trim() !== "");
  const previewAuthors: PublicationAuthor[] = filledAuthors.map((a, i) => ({
    id: -1,
    publication_id: pub.id,
    faculty_id: a.facultyId,
    name: a.name,
    role: a.role,
    role_set_by: null,
    role_set_at: null,
    position: i,
  }));
  const liveUnits = useMemo(() => {
    const present = new Set<string>();
    for (const a of previewAuthors) {
      if (a.role !== "chps_faculty" || a.faculty_id === null) continue;
      const f = facultyById[a.faculty_id];
      if (f?.unit) present.add(f.unit);
    }
    return [...present];
  }, [previewAuthors, facultyById]);

  const previewPub: Publication = { ...pub, journal: journal || null, volume: volume || null, issue: issue || null, pages: pages || null, doi: doi || null };
  const previewHtml = formatCitation(previewPub, previewAuthors);

  const journalOk = journal.trim() !== "" || ackMissingJournal;
  const unitsOk = liveUnits.length > 0 || ackZeroLinked;
  const canSubmit = completedBy.trim() !== "" && journalOk && unitsOk && !pending;

  function updateAuthor(i: number, patch: Partial<DraftAuthor>) {
    setDraftAuthors((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }
  function addAuthorRow() {
    setDraftAuthors((prev) => [...prev, { name: "", role: "external", facultyId: null }]);
  }
  function removeAuthorRow(i: number) {
    setDraftAuthors((prev) => prev.filter((_, idx) => idx !== i));
  }
  function moveAuthorRow(i: number, dir: -1 | 1) {
    setDraftAuthors((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  const missing = whatsMissing(pub, existingAuthors.length);

  return (
    <div className="border border-[#E5E5E5] rounded-xl bg-white overflow-hidden shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <div className="p-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm leading-relaxed">{pub.title}</p>
          <div className="flex items-center gap-2 flex-wrap mt-1.5 text-[11px] text-[#9A9A9A]">
            {pub.discovered_by_faculty_id && facultyById[pub.discovered_by_faculty_id] && (
              <span>discovered by {facultyById[pub.discovered_by_faculty_id].display_name}</span>
            )}
            {pub.scholar_alert_url && (
              <a href={pub.scholar_alert_url} target="_blank" rel="noopener noreferrer" className="text-[#8A6A00] hover:underline">
                Scholar link
              </a>
            )}
            {missing.length > 0 && <span className="px-2 py-0.5 rounded-full bg-[#FDEDEC] text-[#7A2E26]">missing: {missing.join(", ")}</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="border border-[#D8D8D8] text-sm px-3.5 py-1.5 rounded-md hover:border-[#B8B8B8] transition-colors shrink-0"
        >
          {expanded ? "Close" : "Complete this record"}
        </button>
      </div>

      {expanded && (
        <form action={formAction} className="border-t border-[#E5E5E5] p-5 flex flex-col gap-5">
          <input type="hidden" name="publicationId" value={pub.id} />

          <div>
            <p className="text-[11px] uppercase tracking-wide text-[#8A8A8A] mb-2">Authors</p>
            <div className="flex flex-col gap-2">
              {draftAuthors.map((a, i) => (
                <div key={i} className="flex items-center gap-2 flex-wrap">
                  <input type="hidden" name="authorFacultyId" value={a.facultyId ?? ""} />
                  <input
                    name="authorName"
                    value={a.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      const matchedId = facultyByDisplayName.get(name) ?? null;
                      updateAuthor(i, { name, facultyId: matchedId ?? a.facultyId });
                    }}
                    list="faculty-options"
                    placeholder="Author name (citation form, e.g. Stock, M.)"
                    className="flex-1 min-w-[220px] border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
                  />
                  <select
                    name="authorRole"
                    value={a.role}
                    onChange={(e) => updateAuthor(i, { role: e.target.value as AuthorRole })}
                    className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm"
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <span className="text-[11px] text-[#9A9A9A] w-28 shrink-0">
                    {a.facultyId ? `linked · ${facultyById[a.facultyId]?.unit ?? ""}` : "not linked"}
                  </span>
                  <div className="flex gap-1 shrink-0">
                    <button type="button" onClick={() => moveAuthorRow(i, -1)} disabled={i === 0} className="border border-[#D8D8D8] rounded px-2 py-1 text-xs disabled:opacity-30">
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveAuthorRow(i, 1)}
                      disabled={i === draftAuthors.length - 1}
                      className="border border-[#D8D8D8] rounded px-2 py-1 text-xs disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button type="button" onClick={() => removeAuthorRow(i)} className="border border-[#F3C6C2] text-[#7A2E26] rounded px-2 py-1 text-xs hover:bg-[#FDEDEC]">
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <datalist id="faculty-options">
              {facultyOptions.map((f) => (
                <option key={f.id} value={f.display_name} />
              ))}
            </datalist>
            <button type="button" onClick={addAuthorRow} className="mt-2 border border-[#D8D8D8] text-sm px-3 py-1.5 rounded-md hover:border-[#B8B8B8] transition-colors">
              + Add author
            </button>
          </div>

          <div className="flex flex-col gap-3 max-w-xl">
            <label className="text-sm flex flex-col gap-1">
              Journal
              <input
                name="journal"
                value={journal}
                onChange={(e) => setJournal(e.target.value)}
                className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
              />
            </label>
            <div className="flex gap-3">
              <label className="text-sm flex flex-col gap-1 flex-1">
                Volume
                <input name="volume" value={volume} onChange={(e) => setVolume(e.target.value)} className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm" />
              </label>
              <label className="text-sm flex flex-col gap-1 flex-1">
                Issue
                <input name="issue" value={issue} onChange={(e) => setIssue(e.target.value)} className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm" />
              </label>
              <label className="text-sm flex flex-col gap-1 flex-1">
                Pages
                <input name="pages" value={pages} onChange={(e) => setPages(e.target.value)} className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm" />
              </label>
            </div>
            <label className="text-sm flex flex-col gap-1">
              DOI (optional — gray lit frequently has none)
              <input name="doi" value={doi} onChange={(e) => setDoi(e.target.value)} className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm" />
            </label>
            <label className="text-sm flex flex-col gap-1">
              Your name (recorded as who completed this — no per-user login exists)
              <input
                name="completedBy"
                value={completedBy}
                onChange={(e) => setCompletedBy(e.target.value)}
                className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
              />
            </label>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-wide text-[#8A8A8A] mb-2">Live preview — exactly what would publish</p>
            <div className="border border-[#E5E5E5] rounded-md p-4 max-w-2xl text-sm" style={{ fontFamily: "Georgia, serif" }} dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>

          <div className="flex flex-col gap-2 text-sm">
            {journal.trim() === "" && (
              <label className="flex items-start gap-2 bg-[#FFF8E1] border border-[#F5E2A3] text-[#7A5D00] px-3.5 py-2 rounded-lg">
                <input type="checkbox" name="acknowledgedMissingJournal" checked={ackMissingJournal} onChange={(e) => setAckMissingJournal(e.target.checked)} className="mt-0.5" />
                No journal name — confirm it's genuinely unavailable and complete anyway.
              </label>
            )}
            {liveUnits.length === 0 && (
              <label className="flex items-start gap-2 bg-[#FDEDEC] border border-[#F3C6C2] text-[#7A2E26] px-3.5 py-2 rounded-lg">
                <input type="checkbox" name="acknowledgedZeroLinkedAuthors" checked={ackZeroLinked} onChange={(e) => setAckZeroLinked(e.target.checked)} className="mt-0.5" />
                No author is linked to a CHPS faculty row — this will derive no unit and won&apos;t appear in any roundup section. Confirm and complete anyway.
              </label>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!canSubmit}
              className="bg-[#0A0A0A] text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-[#1A1A1A] transition-colors disabled:opacity-40"
            >
              {pending ? "Saving…" : "Save and move to Pending Merge"}
            </button>
            <button type="button" onClick={() => setExpanded(false)} className="border border-[#D8D8D8] text-sm px-4 py-2 rounded-md hover:border-[#B8B8B8] transition-colors">
              Cancel
            </button>
          </div>

          {state.error && <p className="text-sm text-red-700">{state.error}</p>}
        </form>
      )}
    </div>
  );
}

export function CompletionPanel({
  records,
  facultyOptions,
  banner,
}: {
  records: PublicationWithUnits[];
  facultyOptions: Faculty[];
  banner: CompletionBanner | null;
}) {
  const facultyById: Record<number, Faculty> = {};
  for (const f of facultyOptions) facultyById[f.id] = f;

  return (
    <div className="flex flex-col gap-4">
      {banner && (
        <div className="border border-[#F5E2A3] bg-[#FFF8E1] text-[#7A5D00] text-sm px-3.5 py-2.5 rounded-lg">
          Publication #{banner.publicationId} completed — {banner.authors} author{banner.authors === 1 ? "" : "s"}, {banner.units} unit
          {banner.units === 1 ? "" : "s"} derived, moved to Pending Merge.
        </div>
      )}

      {records.length === 0 && <p className="text-[#9A9A9A] text-sm px-1">Nothing in the Needs Metadata queue right now.</p>}

      {records.map((r) => (
        <RecordCard key={r.publication.id} record={r} facultyOptions={facultyOptions} facultyById={facultyById} />
      ))}
    </div>
  );
}
