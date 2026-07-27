// Session 24 (§8c Tab 5): proves unstampAction and dryRunUnstampAction
// enforce requireAdminSession() themselves — same pattern as
// tests/finalize-actions.test.ts's coverage of finalizeRoundupAction. A live
// browser test can't cover a direct call bypassing the page's own gating.
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

process.env.SESSION_SECRET ??= "test-session-secret-for-archive-actions";
process.env.TURSO_DATABASE_URL ??= "file::memory:";
process.env.TURSO_AUTH_TOKEN ??= "test-token";

const { unstampAction, dryRunUnstampAction } = await import("../app/admin/archive/unstamp-actions");
const { initialUnstampFormState } = await import("../app/admin/archive/unstamp-shared");

function emptyFormData(): FormData {
  return new FormData();
}

describe("archive Server Actions — auth enforcement", () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    cookieStore.set.mockReset();
    cookieStore.delete.mockReset();
  });

  it("unstampAction redirects to /admin/login when there is no session — never reaches form parsing or the DB", async () => {
    cookieStore.get.mockReturnValue(undefined);
    await expect(unstampAction(initialUnstampFormState, emptyFormData())).rejects.toMatchObject({ url: "/admin/login" });
  });

  it("dryRunUnstampAction redirects to /admin/login when there is no session — never reaches the DB", async () => {
    cookieStore.get.mockReturnValue(undefined);
    await expect(dryRunUnstampAction(1)).rejects.toMatchObject({ url: "/admin/login" });
  });
});
