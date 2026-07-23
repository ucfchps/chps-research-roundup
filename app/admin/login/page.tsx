"use client";

import { useActionState } from "react";
import { loginAction, type LoginFormState } from "./actions";

const initialState: LoginFormState = { error: null };

export default function AdminLoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <main className="max-w-sm mx-auto py-24 px-6">
      <h1 className="text-xl font-semibold mb-4">Admin login</h1>
      <form action={formAction} className="flex flex-col gap-3">
        <input type="password" name="password" placeholder="Password" required autoFocus className="border rounded px-3 py-2" />
        <button type="submit" disabled={pending} className="rounded bg-black text-white px-4 py-2 disabled:opacity-50">
          {pending ? "Signing in…" : "Sign in"}
        </button>
        {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      </form>
    </main>
  );
}
