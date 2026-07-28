"use server";

// §8c Tab 3: the Server Actions behind the campaign send and revoke. Both
// call lib/campaigns.ts / lib/review.ts directly — the same functions
// scripts/run-campaign.ts and scripts/campaign-status.ts call — never a
// second implementation of "who's eligible" or "how a token gets minted".
//
// ★ sendCampaignAction is this codebase's highest-stakes write: unlike
// finalize or un-stamp, it sends real email that cannot be unsent. Guarded
// by (1) a required type-the-cycle-label-back confirm, same shape as
// archive's un-stamp gate, and (2) resolveMockSendMessageFn, which is the
// ONLY thing standing between this action and a live Gmail send during a
// Playwright verification run — see lib/campaigns.ts for exactly how that
// resolves (MOCK_GMAIL_SEND=1, scratch-server-launch-only, never set in
// production).
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { client } from "@/lib/db";
import { requireAdminSession } from "../session";
import { buildCampaignPreview, runCampaign, resolveMockSendMessageFn, type CampaignPreview } from "@/lib/campaigns";
import { revokeReviewRequest } from "@/lib/review";
import {
  parseSendCampaignFormData,
  parseRevokeFormData,
  type SendCampaignFormState,
  type RevokeFormState,
} from "./campaign-shared";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set (see .env.example)`);
  return value;
}

// Called directly (not as a form action) when COMMS opens the preview, so
// the exact plan a real send would follow is on screen before anyone types
// the cycle label back — not a separately-computed count that could drift
// from it. Same shape as archive/unstamp-actions.ts::dryRunUnstampAction.
export async function previewCampaignAction(cycleLabel: string): Promise<CampaignPreview> {
  await requireAdminSession();
  return buildCampaignPreview(client, cycleLabel, requireEnv("APP_BASE_URL"));
}

export async function sendCampaignAction(_prev: SendCampaignFormState, formData: FormData): Promise<SendCampaignFormState> {
  await requireAdminSession();

  const parsed = parseSendCampaignFormData(formData);
  if ("error" in parsed) return { error: parsed.error };

  const result = await runCampaign(client, parsed.cycleLabel, {
    dryRun: false,
    ttlDays: Number(process.env.REVIEW_TOKEN_TTL_DAYS) || 90,
    appBaseUrl: requireEnv("APP_BASE_URL"),
    emailFrom: requireEnv("REVIEW_EMAIL_FROM"),
    emailReplyTo: requireEnv("REVIEW_EMAIL_REPLY_TO"),
    sendMessageFn: resolveMockSendMessageFn(),
  });

  revalidatePath("/admin/review-campaigns");
  const params = new URLSearchParams({
    sent: result.cycleLabel,
    count: String(result.sent.length),
    failures: String(result.sendFailures.length),
    disabled: String(result.notificationsDisabled),
  });
  redirect(`/admin/review-campaigns?${params.toString()}`);
}

export async function revokeAction(_prev: RevokeFormState, formData: FormData): Promise<RevokeFormState> {
  await requireAdminSession();

  const parsed = parseRevokeFormData(formData);
  if ("error" in parsed) return { error: parsed.error };

  await revokeReviewRequest(client, parsed.reviewRequestId);

  revalidatePath("/admin/review-campaigns");
  const params = new URLSearchParams({ revokedId: String(parsed.reviewRequestId), cycle: parsed.cycleLabel });
  redirect(`/admin/review-campaigns?${params.toString()}`);
}
