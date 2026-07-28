import type { Metadata } from "next";
import { client } from "@/lib/db";
import { requireAdminSession } from "../session";
import { listCampaignCycles, getCampaignStatus, listCampaignRequests } from "@/lib/campaigns";
import { Sidebar } from "../Sidebar";
import { CampaignsPanel, type SendBanner, type RevokeBanner } from "./CampaignsPanel";
import { archivo, inter, jetbrainsMono } from "../fonts";

export const metadata: Metadata = {
  title: "Review campaigns",
};

// §8c Tab 3: read-only by default — listCampaignCycles/getCampaignStatus/
// listCampaignRequests are all SELECTs. The only writes on this route are
// the explicit, confirmed send (campaign-actions.ts::sendCampaignAction)
// and revoke (revokeAction).
//
// Both banners are derived from search params rather than client state —
// same redirect-based pattern as archive's un-stamp banner, for the same
// reason: a completed send/revoke can change what's rendered below it, and
// client state owned by the component that triggered the mutation can race
// its own revalidatePath-driven unmount.
export default async function ReviewCampaignsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminSession();

  const sp = await searchParams;
  const cycleLabels = await listCampaignCycles(client);
  const cycles = await Promise.all(
    cycleLabels.map(async (cycleLabel) => ({
      cycleLabel,
      status: await getCampaignStatus(client, cycleLabel),
      requests: await listCampaignRequests(client, cycleLabel),
    }))
  );

  let sendBanner: SendBanner | null = null;
  if (typeof sp.sent === "string") {
    sendBanner = {
      cycleLabel: sp.sent,
      count: typeof sp.count === "string" ? Number(sp.count) : 0,
      failures: typeof sp.failures === "string" ? Number(sp.failures) : 0,
      disabled: sp.disabled === "true",
    };
  }

  let revokeBanner: RevokeBanner | null = null;
  if (typeof sp.revokedId === "string" && typeof sp.cycle === "string") {
    const reviewRequestId = Number(sp.revokedId);
    if (Number.isFinite(reviewRequestId)) revokeBanner = { reviewRequestId, cycleLabel: sp.cycle };
  }

  return (
    <div className={`flex min-h-screen ${inter.variable} ${archivo.variable} ${jetbrainsMono.variable}`} style={{ fontFamily: "var(--font-inter)" }}>
      <Sidebar active="review-campaigns" />
      <main className="flex-1 px-10 py-8 max-w-4xl">
        <p className="text-2xl font-semibold mb-1" style={{ fontFamily: "var(--font-archivo)" }}>
          Review campaigns
        </p>
        <p className="text-sm text-[#5B5B5B] mb-6">
          Invite faculty to review what&apos;s queued under their name. Sending a campaign emails real people — preview who&apos;s
          included and why before confirming.
        </p>

        <CampaignsPanel cycles={cycles} sendBanner={sendBanner} revokeBanner={revokeBanner} />
      </main>
    </div>
  );
}
