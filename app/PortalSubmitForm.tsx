"use client";

// §8a: "Don't see one of your papers? Add it." The one submission form in
// this codebase that's actually supposed to capture authors from the
// start — app/review/[slug]/[token]/AddPublicationForm.tsx's missing author
// list is a separately-tracked known gap (master plan §8a), not reproduced
// here.
import { useActionState, useState } from "react";
import { UNITS } from "@/lib/types";
import type { AuthorRole } from "@/lib/types";
import { submitPortalPublicationAction } from "./portal-actions";
import { initialPortalSubmitFormState } from "./portal-shared";

const ROLE_OPTIONS: Array<{ value: AuthorRole; label: string }> = [
  { value: "chps_faculty", label: "CHPS faculty" },
  { value: "grad_student", label: "Grad student" },
  { value: "undergrad_student", label: "Undergrad student" },
  { value: "external", label: "Other" },
];

interface DraftAuthor {
  name: string;
  role: AuthorRole;
}

export function PortalSubmitForm() {
  const [open, setOpen] = useState(false);
  const [authors, setAuthors] = useState<DraftAuthor[]>([{ name: "", role: "chps_faculty" }]);
  const [state, formAction, pending] = useActionState(submitPortalPublicationAction, initialPortalSubmitFormState);

  function updateAuthor(i: number, patch: Partial<DraftAuthor>) {
    setAuthors((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }
  function addAuthorRow() {
    setAuthors((prev) => [...prev, { name: "", role: "external" }]);
  }
  function removeAuthorRow(i: number) {
    setAuthors((prev) => prev.filter((_, idx) => idx !== i));
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-sm underline text-zinc-700 hover:text-zinc-950">
        Don&apos;t see one of your papers? Add it.
      </button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4 border border-zinc-200 rounded-lg p-5 max-w-xl">
      <p className="text-sm font-medium">Add a publication</p>
      <p className="text-xs text-zinc-500">Submissions are reviewed before appearing anywhere — nothing is published automatically.</p>

      {/* Honeypot — hidden from real visitors, left for a bot's autofill to trip. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute -left-[9999px] w-px h-px overflow-hidden"
      />

      <label className="text-sm flex flex-col gap-1">
        Your name (citation form, e.g. Stock, M.)
        <input name="submittedBy" required className="border border-zinc-300 rounded-md px-2.5 py-1.5 text-sm" />
      </label>

      <div>
        <p className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Co-authors</p>
        <div className="flex flex-col gap-2">
          {authors.map((a, i) => (
            <div key={i} className="flex items-center gap-2 flex-wrap">
              <input
                name="authorName"
                value={a.name}
                onChange={(e) => updateAuthor(i, { name: e.target.value })}
                placeholder="Name (citation form)"
                className="flex-1 min-w-[180px] border border-zinc-300 rounded-md px-2.5 py-1.5 text-sm"
              />
              <select name="authorRole" value={a.role} onChange={(e) => updateAuthor(i, { role: e.target.value as AuthorRole })} className="border border-zinc-300 rounded-md px-2.5 py-1.5 text-sm">
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              {authors.length > 1 && (
                <button type="button" onClick={() => removeAuthorRow(i)} className="text-xs text-red-700 border border-red-200 rounded px-2 py-1 hover:bg-red-50">
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
        <button type="button" onClick={addAuthorRow} className="mt-2 text-sm border border-zinc-300 rounded-md px-3 py-1.5 hover:border-zinc-400">
          + Add author
        </button>
      </div>

      <label className="text-sm flex flex-col gap-1">
        Title
        <input name="title" required className="border border-zinc-300 rounded-md px-2.5 py-1.5 text-sm" />
      </label>
      <label className="text-sm flex flex-col gap-1">
        Link (URL)
        <input name="url" required className="border border-zinc-300 rounded-md px-2.5 py-1.5 text-sm" />
      </label>
      <label className="text-sm flex flex-col gap-1">
        Journal
        <input name="journal" className="border border-zinc-300 rounded-md px-2.5 py-1.5 text-sm" />
      </label>
      <div className="flex gap-3">
        <label className="text-sm flex flex-col gap-1 flex-1">
          Year
          <input name="year" className="border border-zinc-300 rounded-md px-2.5 py-1.5 text-sm" />
        </label>
        <label className="text-sm flex flex-col gap-1 flex-1">
          Volume
          <input name="volume" className="border border-zinc-300 rounded-md px-2.5 py-1.5 text-sm" />
        </label>
        <label className="text-sm flex flex-col gap-1 flex-1">
          Issue
          <input name="issue" className="border border-zinc-300 rounded-md px-2.5 py-1.5 text-sm" />
        </label>
        <label className="text-sm flex flex-col gap-1 flex-1">
          Pages
          <input name="pages" className="border border-zinc-300 rounded-md px-2.5 py-1.5 text-sm" />
        </label>
      </div>
      <label className="text-sm flex flex-col gap-1">
        DOI (optional)
        <input name="doi" className="border border-zinc-300 rounded-md px-2.5 py-1.5 text-sm" />
      </label>
      <label className="text-sm flex flex-col gap-1">
        Unit (hint only — we determine this from the authors)
        <select name="unitHint" defaultValue="" className="border border-zinc-300 rounded-md px-2.5 py-1.5 text-sm">
          <option value="">Not sure</option>
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm flex flex-col gap-1">
        Note (optional)
        <textarea name="note" rows={2} className="border border-zinc-300 rounded-md px-2.5 py-1.5 text-sm" />
      </label>

      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="bg-zinc-950 text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-zinc-800 disabled:opacity-40">
          {pending ? "Submitting…" : "Submit for review"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-sm border border-zinc-300 rounded-md px-4 py-2 hover:border-zinc-400">
          Cancel
        </button>
      </div>

      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
    </form>
  );
}
