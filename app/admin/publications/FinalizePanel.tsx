"use client";

// Session 19 (§6b, §8c Tab 4): the one write in this system meant to be
// permanent. Per-row checkboxes default to checked; unchecking one just
// leaves it out of THIS pass — it stays eligible (roundup_id stays NULL)
// and reappears next time. None of the three pre-flight warnings below
// block finalize — they're informed-consent, not gates (§8c Tab 4).
import { useActionState, useState } from "react";
import { formatCitation } from "@/lib/citation";
import type { PublicationWithUnits } from "@/lib/publications";
import type { OutstandingReviewer } from "@/lib/review";
import { finalizeRoundupAction } from "./finalize-actions";
import { initialFinalizeFormState } from "./finalize-shared";
import { DEFAULT_TITLE, DEFAULT_INTRO, DEFAULT_LEGEND } from "./ExportPanel";

export function FinalizePanel({
  results,
  outstandingReviewersByPublication,
  cutoff,
}: {
  results: PublicationWithUnits[];
  outstandingReviewersByPublication: Record<number, OutstandingReviewer[]>;
  cutoff: string;
}) {
  const [state, formAction, pending] = useActionState(finalizeRoundupAction, initialFinalizeFormState);

  const [checked, setChecked] = useState<Set<number>>(new Set(results.map((r) => r.publication.id)));
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [intro, setIntro] = useState(DEFAULT_INTRO);
  const [legend, setLegend] = useState(DEFAULT_LEGEND);
  const [label, setLabel] = useState("");
  const [generatedBy, setGeneratedBy] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  function toggle(id: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const checkedResults = results.filter((r) => checked.has(r.publication.id));
  const unreviewedCoAuthorCount = checkedResults.filter((r) => !r.ready).length;
  const zeroUnitCount = checkedResults.filter((r) => r.units.length === 0).length;

  const outstandingFaculty = new Map<number, string>();
  for (const r of checkedResults) {
    for (const o of outstandingReviewersByPublication[r.publication.id] ?? []) {
      outstandingFaculty.set(o.facultyId, o.displayName);
    }
  }

  const canOpenConfirm = checked.size > 0 && label.trim() !== "" && generatedBy.trim() !== "";

  return (
    <div className="border border-[#E5E5E5] rounded-xl bg-white overflow-hidden shadow-[0_1px_2px_rgba(0,0,0,0.03)] mt-7">
      <div className="border-b border-[#E5E5E5] bg-[#FFF8E1] px-5 py-2.5 text-[13px] text-[#7A5D00] flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-ucf-gold shrink-0" />
        Finalizing permanently marks the checked publications as posted. This cannot be undone from this page — see below.
      </div>

      <form action={formAction} className="p-5 flex flex-col gap-5">
        <p className="text-lg font-semibold" style={{ fontFamily: "var(--font-archivo)" }}>
          Finalize this edition
        </p>

        <input type="hidden" name="cutoffDate" value={cutoff} />

        <div className="flex flex-col gap-3 max-w-xl">
          <label className="text-sm flex flex-col gap-1">
            Post title
            <input
              name="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
            />
          </label>
          <label className="text-sm flex flex-col gap-1">
            Intro paragraph
            <textarea
              name="intro"
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              rows={3}
              className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
            />
          </label>
          <label className="text-sm flex flex-col gap-1">
            Legend line
            <input
              name="legendLine"
              value={legend}
              onChange={(e) => setLegend(e.target.value)}
              className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
            />
          </label>
          <label className="text-sm flex flex-col gap-1">
            Edition label
            <input
              name="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder='e.g. "Spring and Summer 2026"'
              className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
            />
          </label>
          <label className="text-sm flex flex-col gap-1">
            Your name (recorded as generated_by — no per-user login exists)
            <input
              name="generatedBy"
              value={generatedBy}
              onChange={(e) => setGeneratedBy(e.target.value)}
              className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
            />
          </label>
        </div>

        <div>
          <p className="text-[11px] uppercase tracking-wide text-[#8A8A8A] mb-2">
            {checked.size} of {results.length} publication{results.length === 1 ? "" : "s"} included
          </p>
          <div className="space-y-1 max-h-80 overflow-y-auto border border-[#E5E5E5] rounded-md p-2">
            {results.map((r) => (
              <label key={r.publication.id} className="flex items-start gap-2.5 px-2 py-1.5 rounded-md hover:bg-[#F5F5F5] cursor-pointer">
                <input
                  type="checkbox"
                  name="publicationIds"
                  value={r.publication.id}
                  checked={checked.has(r.publication.id)}
                  onChange={() => toggle(r.publication.id)}
                  className="mt-1"
                />
                <span
                  className="text-sm leading-relaxed [&_a]:text-[#8A6A00] [&_a]:hover:underline"
                  dangerouslySetInnerHTML={{ __html: formatCitation(r.publication, r.authors) }}
                />
              </label>
            ))}
            {results.length === 0 && <p className="text-sm text-[#9A9A9A] px-2 py-1.5">No eligible publications for this cutoff date.</p>}
          </div>
        </div>

        <div className="flex flex-col gap-2 text-sm">
          {unreviewedCoAuthorCount > 0 && (
            <p className="bg-[#FFF8E1] border border-[#F5E2A3] text-[#7A5D00] px-3.5 py-2 rounded-lg">
              {unreviewedCoAuthorCount} included publication{unreviewedCoAuthorCount === 1 ? "" : "s"} still {unreviewedCoAuthorCount === 1 ? "has" : "have"}{" "}
              unreviewed co-authors.
            </p>
          )}
          {zeroUnitCount > 0 && (
            <p className="bg-[#FDEDEC] border border-[#F3C6C2] text-[#7A2E26] px-3.5 py-2 rounded-lg">
              {zeroUnitCount} included publication{zeroUnitCount === 1 ? "" : "s"} {zeroUnitCount === 1 ? "has" : "have"} no linked CHPS faculty author and{" "}
              {zeroUnitCount === 1 ? "belongs" : "belong"} to no unit — {zeroUnitCount === 1 ? "it" : "they"} will still be marked posted, but will not appear
              in the exported HTML.
            </p>
          )}
          {outstandingFaculty.size > 0 && (
            <div className="bg-[#F0F4FF] border border-[#C6D4F3] text-[#26377A] px-3.5 py-2 rounded-lg">
              <p>{outstandingFaculty.size} faculty on included publications still have an outstanding review request:</p>
              <p className="mt-1">{[...outstandingFaculty.values()].join(", ")}</p>
            </div>
          )}
        </div>

        {!showConfirm && (
          <button
            type="button"
            disabled={!canOpenConfirm}
            onClick={() => setShowConfirm(true)}
            className="self-start bg-[#0A0A0A] text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-[#1A1A1A] transition-colors disabled:opacity-40"
          >
            Review and finalize this edition →
          </button>
        )}

        {showConfirm && (
          <div className="border border-[#D8D8D8] rounded-lg p-4 flex flex-col gap-3 bg-[#FAFAFA]">
            <p className="text-sm font-medium">
              You are about to permanently mark <strong>{checked.size}</strong> publication{checked.size === 1 ? "" : "s"} as posted under the edition
              label &quot;{label}&quot;.
            </p>
            <p className="text-sm text-[#7A2E26]">
              There is currently no way to undo this from the admin UI. A CLI safety net exists (<code>npm run roundup:unstamp</code>) but treat this as
              final.
            </p>
            <label className="text-sm flex flex-col gap-1 max-w-sm">
              Type the edition label (&quot;{label}&quot;) to confirm
              <input
                name="confirmText"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={confirmText !== label || pending}
                className="bg-[#7A2E26] text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-[#5F241E] transition-colors disabled:opacity-40"
              >
                {pending ? "Finalizing…" : "Finalize this edition"}
              </button>
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="border border-[#D8D8D8] text-sm px-4 py-2 rounded-md hover:border-[#B8B8B8] transition-colors"
              >
                Back
              </button>
            </div>
          </div>
        )}

        {state.error && <p className="text-sm text-red-600">{state.error}</p>}
        {state.success && (
          <p className="text-sm text-green-700">
            Finalized as roundup #{state.success.roundupId} — {state.success.pubCount} publication{state.success.pubCount === 1 ? "" : "s"} stamped.
          </p>
        )}
      </form>
    </div>
  );
}
