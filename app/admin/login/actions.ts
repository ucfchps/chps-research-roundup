"use server";

import { redirect } from "next/navigation";
import { client } from "@/lib/db";
import { comparePasswordConstantTime } from "@/lib/admin-session";
import { isLoginLocked, recordFailedLoginAttempt, recordSuccessfulLogin } from "@/lib/admin-auth";
import { setAdminSessionCookie } from "../session";

export interface LoginFormState {
  error: string | null;
}

export async function loginAction(_prevState: LoginFormState, formData: FormData): Promise<LoginFormState> {
  const lockStatus = await isLoginLocked(client);
  if (lockStatus.locked) {
    return { error: "Too many failed attempts. Try again later." };
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) throw new Error("ADMIN_PASSWORD must be set (see .env.example)");

  const password = String(formData.get("password") ?? "");

  if (!comparePasswordConstantTime(password, adminPassword)) {
    await recordFailedLoginAttempt(client);
    return { error: "Incorrect password." };
  }

  await recordSuccessfulLogin(client);
  await setAdminSessionCookie();
  redirect("/admin");
}
