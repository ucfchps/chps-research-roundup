"use client";

// §8c Tab 1 (Session 26): the queue list and per-submission review form.
// Author editor + live preview reuse lib/citation.ts directly, same
// convention Session 25's Needs Metadata tab established. The author editor
// starts pre-populated with exactly one row — the submitter, from the
// known pending_submissions.faculty_id — because the real submission
// payload never carries an author list (confirmed via Session 26 recon);
// anything beyond that row is the reviewer adding co-authors they know
// about, not something being deserialized from the payload.
import { useActionState, useMemo, useState } from "react";
import { formatCitation } from "@/lib/citation";
import type { PendingSubmissionRecord } from "@/lib/pending-submissions";
import type { AuthorRole, Faculty, Publication, PublicationAuthor } from "@/lib/types";
import { approveSubmissionAction, rejectSubmissionAction } from "./submission-actions";
import { initialSubmissionFormState } from "./submission-shared";

export interface SubmissionBanner {
  submissionId: number;
  kind: "approved" | "rejected";
  publicationId?: number;
  linked?: boolean;
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

interface SubmissionWithStaleCheck extends PendingSubmissionRecord {
  staleMatch: { publicationId: number; finalized: boolean } | null;
}

function SubmissionCard({ record, facultyOptions, facultyById }: { record: SubmissionWithStaleCheck; facultyOptions: Faculty[]; facultyById: Record<number, Faculty> }) {
  const { payload } = record;
  const [expanded, setExpanded] = useState(false);

  const submitterName = record.facultyId !== null ? (facultyById[record.facultyId]?.display_name ?? record.submittedBy) : record.submittedBy;
  const [draftAuthors, setDraftAuthors] = useState<DraftAuthor[]>([{ name: submitterName, role: "chps_faculty", facultyId: record.facultyId }]);

  const [title, setTitle] = useState(payload.title);
  const [doi, setDoi] = useState(payload.doi ?? "");
  const [url, setUrl] = useState(payload.url);
  const [journal, setJournal] = useState(payload.journal ?? "");
  const [year, setYear] = useState(payload.year != null ? String(payload.year) : "");
  const [volume, setVolume] = useState(payload.volume ?? "");
  const [issue, setIssue] = useState(payload.issue ?? "");
  const [pages, setPages] = useState(payload.pages ?? "");
  const [reviewedBy, setReviewedBy] = useState("");

  const [approveState, approveFormAction, approvePending] = useActionState(approveSubmissionAction, initialSubmissionFormState);
  const [rejectState, rejectFormAction, rejectPending] = useActionState(rejectSubmissionAction, initialSubmissionFormState);

  const facultyByDisplayName = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of facultyOptions) m.set(f.display_name, f.id);
    return m;
  }, [facultyOptions]);

  const filledAuthors = draftAuthors.filter((a) => a.name.trim() !== "");
  const previewAuthors: PublicationAuthor[] = filledAuthors.map((a, i) => ({
    id: -1,
    publication_id: -1,
    faculty_id: a.facultyId,
    name: a.name,
    role: a.role,
    role_set_by: null,
    role_set_at: null,
    position: i,
  }));
  const previewPub: Publication = {
    id: -1,
    doi: doi || null,
    title,
    title_normalized: "",
    url,
    journal: journal || null,
    year: year ? Number(year) : null,
    volume: volume || null,
    issue: issue || null,
    pages: pages || null,
    status: "published",
    source: "manual",
    first_seen_at: "",
    date_added: "",
    released_at: null,
    roundup_id: null,
    discovered_by_faculty_id: null,
    scholar_alert_url: null,
    created_at: "",
  };
  const previewHtml = formatCitation(previewPub, previewAuthors);

  // Collapsed-card preview: the citation as originally submitted (payload
  // fields, submitter as the only author), independent of the live-edited
  // draft state above — this is "what they sent us," not "what's in the form."
  const submittedPreviewHtml = formatCitation(
    { ...previewPub, title: payload.title, journal: payload.journal ?? null, year: payload.year ?? null, volume: payload.volume ?? null, issue: payload.issue ?? null, pages: payload.pages ?? null, doi: payload.doi },
    [{ id: -1, publication_id: -1, faculty_id: record.facultyId, name: submitterName, role: "chps_faculty", role_set_by: null, role_set_at: null, position: 0 }]
  );

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

  const canSubmit = title.trim() !== "" && url.trim() !== "" && reviewedBy.trim() !== "" && !approvePending && !rejectPending;

  return (
    <div className="border border-[#E5E5E5] rounded-xl bg-white overflow-hidden shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <div className="p-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: submittedPreviewHtml }} />
          <div className="flex items-center gap-2 flex-wrap mt-1.5 text-[11px] text-[#9A9A9A]">
            <span>submitted by {record.submittedBy}</span>
            <span>{new Date(record.submittedAt).toLocaleDateString()}</span>
            {record.note && <span className="px-2 py-0.5 rounded-full bg-[#F0F0F0] text-[#6B6B6B]">note: {record.note}</span>}
            {record.staleMatch && (
              <span className="px-2 py-0.5 rounded-full bg-[#FDEDEC] text-[#7A2E26]">
                possible duplicate — publication #{record.staleMatch.publicationId} now matches{record.staleMatch.finalized ? " (already posted)" : ""}
              </span>
            )}
          </div>
        </div>
        <button type="button" onClick={() => setExpanded((v) => !v)} className="border border-[#D8D8D8] text-sm px-3.5 py-1.5 rounded-md hover:border-[#B8B8B8] transition-colors shrink-0">
          {expanded ? "Close" : "Review"}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-[#E5E5E5] p-5 flex flex-col gap-5">
          {record.staleMatch && (
            <div className="bg-[#FDEDEC] border border-[#F3C6C2] text-[#7A2E26] px-3.5 py-2 rounded-lg text-sm">
              A publication matching this title/DOI now exists (#{record.staleMatch.publicationId}
              {record.staleMatch.finalized ? ", already posted in a past edition" : ""}) — likely landed independently since this was submitted. Approving will{" "}
              {record.staleMatch.finalized ? "be refused (reject this instead)" : "link the submitter to that existing publication rather than create a duplicate"}.
            </div>
          )}

          <div>
            <p className="text-[11px] uppercase tracking-wide text-[#8A8A8A] mb-2">Authors</p>
            <div className="flex flex-col gap-2">
              {draftAuthors.map((a, i) => (
                <div key={i} className="flex items-center gap-2 flex-wrap">
                  <input type="hidden" name="authorFacultyId" value={a.facultyId ?? ""} form="approve-form" />
                  <input
                    name="authorName"
                    form="approve-form"
                    value={a.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      const matchedId = facultyByDisplayName.get(name) ?? null;
                      updateAuthor(i, { name, facultyId: matchedId ?? a.facultyId });
                    }}
                    list="faculty-options-ps"
                    placeholder="Author name (citation form, e.g. Stock, M.)"
                    className="flex-1 min-w-[220px] border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
                  />
                  <select name="authorRole" form="approve-form" value={a.role} onChange={(e) => updateAuthor(i, { role: e.target.value as AuthorRole })} className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm">
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <span className="text-[11px] text-[#9A9A9A] w-28 shrink-0">{a.facultyId ? `linked · ${facultyById[a.facultyId]?.unit ?? ""}` : "not linked"}</span>
                  <div className="flex gap-1 shrink-0">
                    <button type="button" onClick={() => moveAuthorRow(i, -1)} disabled={i === 0} className="border border-[#D8D8D8] rounded px-2 py-1 text-xs disabled:opacity-30">
                      ↑
                    </button>
                    <button type="button" onClick={() => moveAuthorRow(i, 1)} disabled={i === draftAuthors.length - 1} className="border border-[#D8D8D8] rounded px-2 py-1 text-xs disabled:opacity-30">
                      ↓
                    </button>
                    <button type="button" onClick={() => removeAuthorRow(i)} className="border border-[#F3C6C2] text-[#7A2E26] rounded px-2 py-1 text-xs hover:bg-[#FDEDEC]">
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <datalist id="faculty-options-ps">
              {facultyOptions.map((f) => (
                <option key={f.id} value={f.display_name} />
              ))}
            </datalist>
            <button type="button" onClick={addAuthorRow} className="mt-2 border border-[#D8D8D8] text-sm px-3 py-1.5 rounded-md hover:border-[#B8B8B8] transition-colors">
              + Add author
            </button>
            <p className="text-[11px] text-[#9A9A9A] mt-1">Pre-filled with the submitter (the only author the submission form captured) — add any co-authors you know about.</p>
          </div>

          <div className="flex flex-col gap-3 max-w-xl">
            <label className="text-sm flex flex-col gap-1">
              Title
              <input form="approve-form" name="title" value={title} onChange={(e) => setTitle(e.target.value)} className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25" />
            </label>
            <label className="text-sm flex flex-col gap-1">
              Link (URL)
              <input form="approve-form" name="url" value={url} onChange={(e) => setUrl(e.target.value)} className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm" />
            </label>
            <label className="text-sm flex flex-col gap-1">
              Journal
              <input form="approve-form" name="journal" value={journal} onChange={(e) => setJournal(e.target.value)} className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm" />
            </label>
            <div className="flex gap-3">
              <label className="text-sm flex flex-col gap-1 flex-1">
                Year
                <input form="approve-form" name="year" value={year} onChange={(e) => setYear(e.target.value)} className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm" />
              </label>
              <label className="text-sm flex flex-col gap-1 flex-1">
                Volume
                <input form="approve-form" name="volume" value={volume} onChange={(e) => setVolume(e.target.value)} className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm" />
              </label>
              <label className="text-sm flex flex-col gap-1 flex-1">
                Issue
                <input form="approve-form" name="issue" value={issue} onChange={(e) => setIssue(e.target.value)} className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm" />
              </label>
              <label className="text-sm flex flex-col gap-1 flex-1">
                Pages
                <input form="approve-form" name="pages" value={pages} onChange={(e) => setPages(e.target.value)} className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm" />
              </label>
            </div>
            <label className="text-sm flex flex-col gap-1">
              DOI (optional)
              <input form="approve-form" name="doi" value={doi} onChange={(e) => setDoi(e.target.value)} className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm" />
            </label>
            <label className="text-sm flex flex-col gap-1">
              Your name (recorded as who reviewed this — no per-user login exists)
              <input
                name="reviewedBy"
                form="approve-form"
                value={reviewedBy}
                onChange={(e) => setReviewedBy(e.target.value)}
                className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
              />
            </label>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-wide text-[#8A8A8A] mb-2">Live preview — exactly what would publish</p>
            <div className="border border-[#E5E5E5] rounded-md p-4 max-w-2xl text-sm" style={{ fontFamily: "Georgia, serif" }} dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>

          <form id="approve-form" action={approveFormAction} className="flex flex-col gap-2">
            <input type="hidden" name="submissionId" value={record.id} />
            <div className="flex gap-2">
              <button type="submit" disabled={!canSubmit} className="bg-[#0A0A0A] text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-[#1A1A1A] transition-colors disabled:opacity-40">
                {approvePending ? "Approving…" : "Approve and publish"}
              </button>
            </div>
            {approveState.error && <p className="text-sm text-red-700">{approveState.error}</p>}
          </form>

          <form action={rejectFormAction} className="flex flex-col gap-2">
            <input type="hidden" name="submissionId" value={record.id} />
            <input type="hidden" name="reviewedBy" value={reviewedBy} />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={reviewedBy.trim() === "" || approvePending || rejectPending}
                className="border border-[#F3C6C2] text-[#7A2E26] text-sm font-medium px-4 py-2 rounded-md hover:bg-[#FDEDEC] transition-colors disabled:opacity-40"
              >
                {rejectPending ? "Rejecting…" : "Reject"}
              </button>
              <button type="button" onClick={() => setExpanded(false)} className="border border-[#D8D8D8] text-sm px-4 py-2 rounded-md hover:border-[#B8B8B8] transition-colors">
                Cancel
              </button>
            </div>
            {rejectState.error && <p className="text-sm text-red-700">{rejectState.error}</p>}
          </form>
        </div>
      )}
    </div>
  );
}

export function SubmissionsPanel({ submissions, facultyOptions, banner }: { submissions: SubmissionWithStaleCheck[]; facultyOptions: Faculty[]; banner: SubmissionBanner | null }) {
  const facultyById: Record<number, Faculty> = {};
  for (const f of facultyOptions) facultyById[f.id] = f;

  return (
    <div className="flex flex-col gap-4">
      {banner && (
        <div className="border border-[#F5E2A3] bg-[#FFF8E1] text-[#7A5D00] text-sm px-3.5 py-2.5 rounded-lg">
          {banner.kind === "approved"
            ? `Submission #${banner.submissionId} approved — ${banner.linked ? `linked to existing publication #${banner.publicationId}` : `published as #${banner.publicationId}`}.`
            : `Submission #${banner.submissionId} rejected.`}
        </div>
      )}

      {submissions.length === 0 && <p className="text-[#9A9A9A] text-sm px-1">Nothing in the Pending Submissions queue right now.</p>}

      {submissions.map((s) => (
        <SubmissionCard key={s.id} record={s} facultyOptions={facultyOptions} facultyById={facultyById} />
      ))}
    </div>
  );
}
