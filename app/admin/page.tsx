// §8c, build-order item 15: the door, not the room. Real admin screens
// (pending submissions, needs_metadata, review campaigns, the generator,
// the archive) land in later sessions, each behind requireAdminSession()
// called at the top, same as this page.
import { logoutAction } from "./actions";
import { requireAdminSession } from "./session";

export default async function AdminHomePage() {
  await requireAdminSession();

  return (
    <main className="max-w-2xl mx-auto py-16 px-6">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <p className="mt-2 text-zinc-600">You&apos;re logged in. Admin screens land in later sessions.</p>
      <form action={logoutAction} className="mt-6">
        <button type="submit" className="rounded border px-4 py-2">
          Log out
        </button>
      </form>
    </main>
  );
}
