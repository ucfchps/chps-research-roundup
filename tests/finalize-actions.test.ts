// Session 19: proves finalizeRoundupAction enforces requireAdminSession()
// itself, same pattern as tests/admin-server-actions.test.ts's logoutAction
// coverage — a live browser test can't cover a direct call bypassing the
// page's own gating.
import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
};

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve(cookieStore)),
}));

class MockRedirectSignal extends Error {
  constructor(public url: string) {
    super(`REDIRECT:${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new MockRedirectSignal(url);
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

process.env.SESSION_SECRET ??= "test-session-secret-for-finalize-actions";
process.env.TURSO_DATABASE_URL ??= "file::memory:";
process.env.TURSO_AUTH_TOKEN ??= "test-token";

const { finalizeRoundupAction } = await import("../app/admin/publications/finalize-actions");
const { initialFinalizeFormState } = await import("../app/admin/publications/finalize-shared");

function emptyFormData(): FormData {
  return new FormData();
}

describe("finalizeRoundupAction — Server-Action-level auth enforcement", () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    cookieStore.set.mockReset();
    cookieStore.delete.mockReset();
  });

  it("redirects to /admin/login when there is no session — never reaches form parsing or the DB", async () => {
    cookieStore.get.mockReturnValue(undefined);

    await expect(finalizeRoundupAction(initialFinalizeFormState, emptyFormData())).rejects.toMatchObject({ url: "/admin/login" });
  });
});
