"use server";

// Session 19 (§6b, §8c Tab 4): the Server Action behind the one permanent
// write in this system. Form parsing/validation lives in finalize-shared.ts
// (a "use server" file may only export async functions) and is fully
// unit-tested there; the actual write is fully covered by
// tests/roundup-finalize.test.ts against lib/roundup-finalize.ts. This file
// is just the auth-gated glue between the two — see admin/actions.ts's
// logoutAction for the same shape.
import { revalidatePath } from "next/cache";
import { client } from "@/lib/db";
import { requireAdminSession } from "../session";
import { finalizeRoundup } from "@/lib/roundup-finalize";
import { parseFinalizeFormData, type FinalizeFormState } from "./finalize-shared";

export async function finalizeRoundupAction(_prev: FinalizeFormState, formData: FormData): Promise<FinalizeFormState> {
  await requireAdminSession();

  const parsed = parseFinalizeFormData(formData);
  if ("error" in parsed) return { error: parsed.error, success: null };

  try {
    const result = await finalizeRoundup(client, parsed.params);
    revalidatePath("/admin/publications");
    return { error: null, success: result };
  } catch (err) {
    return { error: (err as Error).message, success: null };
  }
}
