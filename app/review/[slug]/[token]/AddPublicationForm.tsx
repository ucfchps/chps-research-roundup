"use client";

import { useActionState } from "react";
import type { AddPublicationFormState } from "./actions";

export function AddPublicationForm({
  action,
}: {
  action: (state: AddPublicationFormState, formData: FormData) => Promise<AddPublicationFormState>;
}) {
  const [state, formAction, pending] = useActionState(action, { message: null });

  return (
    <form action={formAction} className="flex flex-col gap-2 max-w-md">
      <input name="title" placeholder="Title" required className="border rounded px-2 py-1" />
      <input name="doi" placeholder="DOI (optional)" className="border rounded px-2 py-1" />
      <input name="url" placeholder="Link" className="border rounded px-2 py-1" />
      <input name="journal" placeholder="Journal" className="border rounded px-2 py-1" />
      <div className="flex gap-2">
        <input name="volume" placeholder="Volume" className="border rounded px-2 py-1 w-1/3" />
        <input name="issue" placeholder="Issue" className="border rounded px-2 py-1 w-1/3" />
        <input name="pages" placeholder="Pages" className="border rounded px-2 py-1 w-1/3" />
      </div>
      <button type="submit" disabled={pending} className="rounded bg-black text-white px-3 py-1.5 disabled:opacity-50">
        {pending ? "Submitting…" : "Add this publication"}
      </button>
      {state.message && <p className="text-sm">{state.message}</p>}
    </form>
  );
}
