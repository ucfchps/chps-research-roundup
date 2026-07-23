import type { Metadata } from "next";
import { client } from "@/lib/db";
import { getReviewablePublications, getReviewRequestByToken, markReviewRequestOpened, ownUnconfirmedRow, unidentifiedCoAuthors } from "@/lib/review";
import { formatAuthorList } from "@/lib/citation";
import {
  addPublicationAction,
  confirmOwnAttributionAction,
  editCitationAction,
  markReviewCompleteAction,
  rejectAttributionAction,
  setRoleAction,
} from "./actions";
import { AddPublicationForm } from "./AddPublicationForm";

// §8b security model item 5: this page is full of outbound links to DOIs and
// publisher sites. Without this, clicking one leaks the full URL — token
// included — to that publisher's server via the Referer header.
export const metadata: Metadata = {
  title: "Review your publications",
  referrer: "no-referrer",
};

const ROLE_OPTIONS: Array<{ value: "chps_faculty" | "grad_student" | "undergrad_student" | "external"; label: string }> = [
  { value: "chps_faculty", label: "CHPS faculty" },
  { value: "grad_student", label: "Grad student" },
  { value: "undergrad_student", label: "Undergrad student" },
  { value: "external", label: "Not CHPS" },
];

export default async function ReviewPage({
  params,
}: {
  // Next.js 15: dynamic route params are async in Server Components.
  params: Promise<{ slug: string; token: string }>;
}) {
  const { token } = await params;

  // The {slug} URL segment is cosmetic/display-only — every query below is
  // scoped to reviewRequest.faculty_id, derived solely from the token.
  const reviewRequest = await getReviewRequestByToken(client, token);

  if (!reviewRequest) {
    return (
      <main className="max-w-xl mx-auto py-16 px-6">
        <h1 className="text-xl font-semibold">This link is no longer valid.</h1>
        <p className="mt-2 text-zinc-600">If you still need to review your publications, please request a new link.</p>
      </main>
    );
  }

  await markReviewRequestOpened(client, reviewRequest.id);

  const publications = await getReviewablePublications(client, reviewRequest.faculty_id);
  const boundAddPublicationAction = addPublicationAction.bind(null, token, reviewRequest.slug);

  return (
    <main className="max-w-2xl mx-auto py-16 px-6 flex flex-col gap-10">
      <header>
        <h1 className="text-2xl font-semibold">Review your publications</h1>
        <p className="mt-2 text-zinc-600">
          These are your publications queued for the next CHPS Research Roundup. Please confirm before we post.
        </p>
      </header>

      {publications.length === 0 && <p className="text-zinc-600">Nothing queued for review right now — thank you!</p>}

      {publications.map((pub) => {
        const ownRow = ownUnconfirmedRow(pub, reviewRequest.faculty_id);
        const coAuthorsNeedingRole = unidentifiedCoAuthors(pub, reviewRequest.faculty_id);

        return (
          <article key={pub.id} className="border rounded-lg p-4 flex flex-col gap-4">
            <div>
              <span dangerouslySetInnerHTML={{ __html: formatAuthorList(pub.authors) }} /> ({pub.year ?? "n.d."}).{" "}
              <a href={pub.url} target="_blank" rel="noopener noreferrer" className="underline">
                {pub.title}
              </a>
              {pub.journal && <>. {pub.journal}</>}
              {pub.volume && <>, {pub.volume}</>}
              {pub.pages && <>, {pub.pages}</>}.
            </div>

            {ownRow && (
              <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded p-3">
                <p className="text-sm flex-1">Is this your paper?</p>
                <form action={confirmOwnAttributionAction.bind(null, token, reviewRequest.slug, ownRow.id)}>
                  <button type="submit" className="rounded bg-black text-white px-3 py-1.5 text-sm">
                    Yes, this is mine
                  </button>
                </form>
                <form action={rejectAttributionAction.bind(null, token, reviewRequest.slug, ownRow.id)}>
                  <button type="submit" className="rounded border px-3 py-1.5 text-sm">
                    This isn&apos;t my paper
                  </button>
                </form>
              </div>
            )}

            {coAuthorsNeedingRole.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-zinc-600">We don&apos;t know who these co-authors are:</p>
                {coAuthorsNeedingRole.map((author) => (
                  <form
                    key={author.id}
                    action={setRoleAction.bind(null, token, reviewRequest.slug, author.id)}
                    className="flex flex-wrap items-center gap-3 text-sm"
                  >
                    <span className="font-medium">{author.name}</span>
                    {ROLE_OPTIONS.map((opt) => (
                      <label key={opt.value} className="flex items-center gap-1">
                        <input type="radio" name="role" value={opt.value} required /> {opt.label}
                      </label>
                    ))}
                    <button type="submit" className="rounded border px-2 py-1">
                      Save
                    </button>
                  </form>
                ))}
              </div>
            )}

            <details>
              <summary className="text-sm cursor-pointer text-zinc-600">Fix citation details</summary>
              <form action={editCitationAction.bind(null, token, reviewRequest.slug, pub.id)} className="flex flex-col gap-2 mt-2 max-w-md">
                <input name="title" defaultValue={pub.title} placeholder="Title" className="border rounded px-2 py-1" />
                <input name="journal" defaultValue={pub.journal ?? ""} placeholder="Journal" className="border rounded px-2 py-1" />
                <div className="flex gap-2">
                  <input name="volume" defaultValue={pub.volume ?? ""} placeholder="Volume" className="border rounded px-2 py-1 w-1/3" />
                  <input name="issue" defaultValue={pub.issue ?? ""} placeholder="Issue" className="border rounded px-2 py-1 w-1/3" />
                  <input name="pages" defaultValue={pub.pages ?? ""} placeholder="Pages" className="border rounded px-2 py-1 w-1/3" />
                </div>
                <button type="submit" className="rounded border px-3 py-1.5 self-start">
                  Save citation
                </button>
              </form>
            </details>
          </article>
        );
      })}

      <section className="border-t pt-8">
        <h2 className="text-lg font-semibold mb-3">Add a missing publication</h2>
        <AddPublicationForm action={boundAddPublicationAction} />
      </section>

      <section className="border-t pt-8">
        {reviewRequest.completed_at ? (
          <p className="text-zinc-600">Thanks — you told us you&apos;re done reviewing.</p>
        ) : (
          <form action={markReviewCompleteAction.bind(null, token, reviewRequest.slug)}>
            <button type="submit" className="rounded bg-black text-white px-4 py-2">
              I&apos;m done reviewing
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
