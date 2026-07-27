"use client";

// Session 24 (§8c Tab 5): the archive list, the read-only HTML viewer (same
// preview/source/copy/download pattern as ExportPanel.tsx, reused rather
// than reinvented), and the guarded un-stamp flow. Un-stamp gets the exact
// same friction as finalize (FinalizePanel.tsx) — a confirm step with the
// live dry-run result on screen and a type-the-label-back gate — because it
// reverses the one irreversible action in the system.
import { useActionState, useState, useTransition } from "react";
import type { RoundupListEntry, UnstampSummary } from "@/lib/roundup-finalize";
import { dryRunUnstampAction, unstampAction } from "./unstamp-actions";
import { initialUnstampFormState } from "./unstamp-shared";

export interface UnstampBanner {
  roundupId: number;
  count: number;
  label: string | null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function EditionCard({ roundup }: { roundup: RoundupListEntry }) {
  const [viewing, setViewing] = useState(false);
  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);

  const [confirming, setConfirming] = useState(false);
  const [dryRun, setDryRun] = useState<UnstampSummary | null>(null);
  const [dryRunPending, startDryRun] = useTransition();
  const [confirmText, setConfirmText] = useState("");

  // On success this redirects to /admin/archive?reversed=... instead of
  // returning state — see unstamp-actions.ts. `state` here only ever
  // carries a validation error; there's no success branch to read.
  const [state, formAction, pending] = useActionState(unstampAction, initialUnstampFormState);

  function handleCopy() {
    navigator.clipboard.writeText(roundup.html);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  function handleDownload() {
    const blob = new Blob([roundup.html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${roundup.label.replace(/\s+/g, "-").toLowerCase()}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function beginUnstamp() {
    setConfirming(true);
    setDryRun(null);
    startDryRun(async () => {
      const result = await dryRunUnstampAction(roundup.id);
      setDryRun(result);
    });
  }

  const drift = roundup.live_stamped_count !== roundup.pub_count;

  return (
    <div className="border border-[#E5E5E5] rounded-xl bg-white overflow-hidden shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <div className="p-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-lg font-semibold" style={{ fontFamily: "var(--font-archivo)" }}>
            {roundup.label}
          </p>
          <p className="text-sm text-[#5B5B5B] mt-0.5">
            Generated {formatDate(roundup.generated_at)}
            {roundup.generated_by ? ` by ${roundup.generated_by}` : ""} — {roundup.pub_count} publication{roundup.pub_count === 1 ? "" : "s"}
            {drift && (
              <span className="text-[#8A6A00]">
                {" "}
                (currently {roundup.live_stamped_count} still stamped — records may have been edited since finalize)
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setViewing((v) => !v)}
            className="border border-[#D8D8D8] text-sm px-3.5 py-1.5 rounded-md hover:border-[#B8B8B8] transition-colors"
          >
            {viewing ? "Hide HTML" : "View HTML"}
          </button>
          {!confirming && (
            <button
              type="button"
              onClick={beginUnstamp}
              className="border border-[#F3C6C2] text-[#7A2E26] text-sm px-3.5 py-1.5 rounded-md hover:bg-[#FDEDEC] transition-colors"
            >
              Un-stamp this edition…
            </button>
          )}
        </div>
      </div>

      {viewing && (
        <div className="border-t border-[#E5E5E5] p-5 flex flex-col gap-3">
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setTab("preview")}
              aria-pressed={tab === "preview"}
              className={`text-sm px-3.5 py-1.5 rounded-md border transition-colors ${
                tab === "preview" ? "bg-[#0A0A0A] border-[#0A0A0A] text-ucf-gold font-medium" : "border-[#D8D8D8] text-[#5B5B5B] hover:border-[#B8B8B8]"
              }`}
            >
              Preview
            </button>
            <button
              type="button"
              onClick={() => setTab("source")}
              aria-pressed={tab === "source"}
              className={`text-sm px-3.5 py-1.5 rounded-md border transition-colors ${
                tab === "source" ? "bg-[#0A0A0A] border-[#0A0A0A] text-ucf-gold font-medium" : "border-[#D8D8D8] text-[#5B5B5B] hover:border-[#B8B8B8]"
              }`}
            >
              HTML source
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="bg-ucf-gold text-[#0A0A0A] font-medium text-sm px-3.5 py-1.5 rounded-md ml-auto hover:bg-[#E5B500] transition-colors"
            >
              {copied ? "Copied" : "Copy HTML"}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="border border-[#D8D8D8] text-sm px-3.5 py-1.5 rounded-md hover:border-[#B8B8B8] transition-colors"
            >
              Download .html
            </button>
          </div>

          {tab === "preview" ? (
            <div className="roundup-preview border border-[#E5E5E5] rounded-md p-6 max-w-2xl" dangerouslySetInnerHTML={{ __html: roundup.html }} />
          ) : (
            <pre
              className="border border-[#E5E5E5] rounded-md p-4 bg-[#FAFAFA] text-xs overflow-x-auto whitespace-pre-wrap"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              {roundup.html}
            </pre>
          )}
        </div>
      )}

      {confirming && (
        <form action={formAction} className="border-t border-[#F3C6C2] bg-[#FDEDEC] p-5 flex flex-col gap-3">
          <input type="hidden" name="roundupId" value={roundup.id} />
          <input type="hidden" name="label" value={roundup.label} />

          <p className="text-sm font-medium text-[#7A2E26]">You are about to re-open edition &quot;{roundup.label}&quot;.</p>
          <p className="text-sm text-[#7A2E26]">
            {dryRunPending && "Checking what would change…"}
            {!dryRunPending && dryRun && !dryRun.noop && (
              <>
                <strong>{dryRun.publicationIds.length}</strong> publication{dryRun.publicationIds.length === 1 ? "" : "s"} will become eligible for a
                future roundup again: {dryRun.publicationIds.map((id) => `#${id}`).join(", ") || "(none)"}.
              </>
            )}
            {!dryRunPending && dryRun && dryRun.noop && "This edition no longer exists — it may already have been un-stamped elsewhere. Nothing to do."}
          </p>

          <label className="text-sm flex flex-col gap-1 max-w-sm">
            Type the edition label (&quot;{roundup.label}&quot;) to confirm
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
              disabled={confirmText !== roundup.label || pending || dryRunPending || !dryRun || dryRun.noop}
              className="bg-[#7A2E26] text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-[#5F241E] transition-colors disabled:opacity-40"
            >
              {pending ? "Un-stamping…" : "Un-stamp this edition"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setConfirmText("");
                setDryRun(null);
              }}
              className="border border-[#D8D8D8] text-sm px-4 py-2 rounded-md hover:border-[#B8B8B8] transition-colors"
            >
              Cancel
            </button>
          </div>

          {state.error && <p className="text-sm text-red-700">{state.error}</p>}
        </form>
      )}
    </div>
  );
}

export function ArchivePanel({ roundups, banner }: { roundups: RoundupListEntry[]; banner: UnstampBanner | null }) {
  return (
    <div className="flex flex-col gap-4">
      {banner && (
        <div className="border border-[#F5E2A3] bg-[#FFF8E1] text-[#7A5D00] text-sm px-3.5 py-2.5 rounded-lg">
          Reversed roundup #{banner.roundupId}
          {banner.label ? ` ("${banner.label}")` : ""} — {banner.count} publication{banner.count === 1 ? "" : "s"} re-opened.
        </div>
      )}

      {roundups.length === 0 && <p className="text-[#9A9A9A] text-sm px-1">No roundups have been finalized yet.</p>}

      {roundups.map((r) => (
        <EditionCard key={r.id} roundup={r} />
      ))}
    </div>
  );
}
