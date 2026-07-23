"use server";

import { redirect } from "next/navigation";
import { clearAdminSessionCookie, requireAdminSession } from "./session";

export async function logoutAction(): Promise<void> {
  await requireAdminSession();
  await clearAdminSessionCookie();
  redirect("/admin/login");
}
