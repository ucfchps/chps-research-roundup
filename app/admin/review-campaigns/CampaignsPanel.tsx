"use client";

// §8c Tab 3: preview-before-send, a type-the-cycle-label-back confirm gate
// (at least as strong as archive's un-stamp gate — see campaign-actions.ts
// for why this one needs to be, if anything, stronger), the dashboard of
// past campaigns, and per-recipient revoke.
import { useActionState, useState, useTransition } from "react";
import type { CampaignPreview, CampaignRequestEntry, CampaignStatus } from "@/lib/campaigns";
import { previewCampaignAction, sendCampaignAction, revokeAction } from "./campaign-actions";
import { initialSendCampaignFormState, initialRevokeFormState } from "./campaign-shared";

export interface SendBanner {
  cycleLabel: string;
  count: number;
  failures: number;
  disabled: boolean;
}

export interface RevokeBanner {
  reviewRequestId: number;
  cycleLabel: string;
}

export interface CycleSummary {
  cycleLabel: string;
  status: CampaignStatus;
  requests: CampaignRequestEntry[];
}

function todayLabel(): string {
  return new Date().toISOString().slice(0, 10);
}

function NewCampaignCard() {
  const [cycleLabel, setCycleLabel] = useState(todayLabel());
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [previewPending, startPreview] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [state, formAction, pending] = useActionState(sendCampaignAction, initialSendCampaignFormState);

  function beginPreview() {
    setConfirming(false);
    setConfirmText("");
    startPreview(async () => {
      const result = await previewCampaignAction(cycleLabel);
      setPreview(result);
    });
  }

  const previewCurrent = preview && preview.cycleLabel === cycleLabel;
  const canSend = previewCurrent && preview.willSend.length > 0;

  return (
    <div className="border border-[#E5E5E5] rounded-xl bg-white p-5 flex flex-col gap-4">
      <p className="text-lg font-semibold" style={{ fontFamily: "var(--font-archivo)" }}>
        Start a new campaign
      </p>

      <label className="text-sm flex flex-col gap-1 max-w-sm">
        Cycle label
        <input
          value={cycleLabel}
          onChange={(e) => {
            setCycleLabel(e.target.value);
            setPreview(null);
            setConfirming(false);
          }}
          className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
        />
      </label>

      <button
        type="button"
        onClick={beginPreview}
        disabled={!cycleLabel.trim() || previewPending}
        className="self-start border border-[#D8D8D8] text-sm px-3.5 py-1.5 rounded-md hover:border-[#B8B8B8] transition-colors disabled:opacity-40"
      >
        {previewPending ? "Building preview…" : "Preview campaign"}
      </button>

      {previewCurrent && (
        <div className="border-t border-[#E5E5E5] pt-4 flex flex-col gap-3">
          <p className="text-sm">
            <strong>{preview.willSend.length}</strong> will be emailed
            {preview.skippedAlreadyActive.length > 0 && (
              <>
                , <strong>{preview.skippedAlreadyActive.length}</strong> already have an active token for this cycle
              </>
            )}
            {preview.skippedNoEmail.length > 0 && (
              <>
                , <strong>{preview.skippedNoEmail.length}</strong> have no email on file
              </>
            )}
            {preview.excludedNothingToReview.length > 0 && (
              <>
                , <strong>{preview.excludedNothingToReview.length}</strong> have nothing to review
              </>
            )}
            .
          </p>

          {preview.willSend.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {preview.willSend.map((e) => (
                <div key={e.facultyId} className="text-sm border border-[#EDEDED] rounded-md p-2.5">
                  <button
                    type="button"
                    onClick={() => setExpandedRow(expandedRow === e.facultyId ? null : e.facultyId)}
                    className="text-left w-full"
                  >
                    {e.displayName} — {e.email} ({e.queuedPublicationCount} pub{e.queuedPublicationCount === 1 ? "" : "s"}
                    {e.unidentifiedCoAuthorCount > 0
                      ? `, ${e.unidentifiedCoAuthorCount} unidentified co-author${e.unidentifiedCoAuthorCount === 1 ? "" : "s"}`
                      : ""}
                    )
                  </button>
                  {expandedRow === e.facultyId && (
                    <pre
                      className="mt-2 text-xs whitespace-pre-wrap bg-[#FAFAFA] border border-[#EDEDED] rounded p-2"
                      style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                    >
                      {`Subject: ${e.emailPreview.subject}\n\n${e.emailPreview.body}`}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}

          {preview.willSend.length === 0 && <p className="text-sm text-[#9A9A9A]">Nothing to send for this cycle label.</p>}

          {canSend && !confirming && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="self-start border border-[#F3C6C2] text-[#7A2E26] text-sm px-3.5 py-1.5 rounded-md hover:bg-[#FDEDEC] transition-colors"
            >
              Send this campaign…
            </button>
          )}
        </div>
      )}

      {confirming && previewCurrent && (
        <form action={formAction} className="border-t border-[#F3C6C2] bg-[#FDEDEC] -mx-5 -mb-5 mt-1 p-5 flex flex-col gap-3 rounded-b-xl">
          <input type="hidden" name="cycleLabel" value={cycleLabel} />
          <p className="text-sm font-medium text-[#7A2E26]">
            You are about to send real email to <strong>{preview.willSend.length}</strong> recipient
            {preview.willSend.length === 1 ? "" : "s"}. This cannot be unsent.
          </p>

          <label className="text-sm flex flex-col gap-1 max-w-sm">
            Type the cycle label (&quot;{cycleLabel}&quot;) to confirm
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
              disabled={confirmText !== cycleLabel || pending}
              className="bg-[#7A2E26] text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-[#5F241E] transition-colors disabled:opacity-40"
            >
              {pending ? "Sending…" : "Send this campaign"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setConfirmText("");
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

function RevokeRow({ entry, cycleLabel }: { entry: CampaignRequestEntry; cycleLabel: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(revokeAction, initialRevokeFormState);
  const revocable = !entry.completedAt && !entry.revoked;

  return (
    <div className="flex items-center justify-between gap-3 text-sm py-1.5 border-b border-[#F2F2F2] last:border-0 flex-wrap">
      <span>
        {entry.displayName} ({entry.email ?? "no email on file"}) —{" "}
        {entry.revoked ? "revoked" : entry.completedAt ? "completed" : entry.openedAt ? "opened, not completed" : "not yet opened"}
      </span>

      {revocable && !confirming && (
        <button type="button" onClick={() => setConfirming(true)} className="text-[#7A2E26] text-xs hover:underline shrink-0">
          Revoke
        </button>
      )}

      {revocable && confirming && (
        <form action={formAction} className="flex items-center gap-1.5 shrink-0">
          <input type="hidden" name="reviewRequestId" value={entry.id} />
          <input type="hidden" name="cycleLabel" value={cycleLabel} />
          <span className="text-xs text-[#7A2E26]">Revoke this link?</span>
          <button type="submit" disabled={pending} className="text-xs bg-[#7A2E26] text-white px-2 py-1 rounded disabled:opacity-40">
            {pending ? "…" : "Confirm"}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="text-xs border border-[#D8D8D8] px-2 py-1 rounded">
            Cancel
          </button>
        </form>
      )}

      {state.error && <span className="text-xs text-red-700 basis-full">{state.error}</span>}
    </div>
  );
}

function CycleCard({ cycleLabel, status, requests }: CycleSummary) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-[#E5E5E5] rounded-xl bg-white overflow-hidden">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="w-full text-left p-4 flex items-center justify-between gap-3">
        <span className="font-medium">{cycleLabel}</span>
        <span className="text-sm text-[#5B5B5B] shrink-0">
          {status.totalSent} sent · {status.openedCount} opened · {status.completedCount} completed
        </span>
      </button>
      {expanded && (
        <div className="border-t border-[#E5E5E5] p-4">
          {requests.map((r) => (
            <RevokeRow key={r.id} entry={r} cycleLabel={cycleLabel} />
          ))}
        </div>
      )}
    </div>
  );
}

export function CampaignsPanel({
  cycles,
  sendBanner,
  revokeBanner,
}: {
  cycles: CycleSummary[];
  sendBanner: SendBanner | null;
  revokeBanner: RevokeBanner | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      {sendBanner && (
        <div className="border border-[#F5E2A3] bg-[#FFF8E1] text-[#7A5D00] text-sm px-3.5 py-2.5 rounded-lg">
          {sendBanner.disabled ? (
            <>
              Email notifications are disabled — nothing was sent for &quot;{sendBanner.cycleLabel}&quot;. Enable notifications before
              sending a campaign.
            </>
          ) : (
            <>
              Campaign &quot;{sendBanner.cycleLabel}&quot; sent — {sendBanner.count} email{sendBanner.count === 1 ? "" : "s"} sent
              {sendBanner.failures > 0 ? `, ${sendBanner.failures} failure${sendBanner.failures === 1 ? "" : "s"}` : ""}.
            </>
          )}
        </div>
      )}

      {revokeBanner && (
        <div className="border border-[#F5E2A3] bg-[#FFF8E1] text-[#7A5D00] text-sm px-3.5 py-2.5 rounded-lg">
          Revoked review request #{revokeBanner.reviewRequestId} for &quot;{revokeBanner.cycleLabel}&quot;.
        </div>
      )}

      <NewCampaignCard />

      {cycles.length === 0 && <p className="text-[#9A9A9A] text-sm px-1">No campaigns sent yet.</p>}

      {cycles.map((c) => (
        <CycleCard key={c.cycleLabel} {...c} />
      ))}
    </div>
  );
}
