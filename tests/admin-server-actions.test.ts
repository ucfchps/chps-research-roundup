// §8c admin auth: proves requireAdminSession() is enforced by the Server
// Action itself, not just by whatever the page happens to let you click.
// Calling logoutAction() directly, in isolation, with next/headers'
// cookies() mocked to return no session — a live browser test can't cover
// this specific gap, since httpOnly correctly prevents tampering with the
// real cookie from JS, and the normal UI never even renders the logout
// button while logged out. This is the plain unit-level call that does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

process.env.SESSION_SECRET ??= "test-session-secret-for-admin-server-actions";

const { requireAdminSession } = await import("../app/admin/session");
const { logoutAction } = await import("../app/admin/actions");
const { createSessionToken } = await import("../lib/admin-session");

function validSessionCookie() {
  return { value: createSessionToken(process.env.SESSION_SECRET!, new Date(Date.now() + 3600000)) };
}

describe("requireAdminSession — called directly, no page involved", () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    cookieStore.set.mockReset();
    cookieStore.delete.mockReset();
  });

  it("redirects to /admin/login when there is no session cookie at all", async () => {
    cookieStore.get.mockReturnValue(undefined);

    await expect(requireAdminSession()).rejects.toMatchObject({ url: "/admin/login" });
  });

  it("redirects to /admin/login when the cookie fails signature verification", async () => {
    cookieStore.get.mockReturnValue({ value: "garbage.notavalidsignature" });

    await expect(requireAdminSession()).rejects.toMatchObject({ url: "/admin/login" });
  });

  it("does not redirect when a valid, unexpired session cookie is present", async () => {
    cookieStore.get.mockReturnValue(validSessionCookie());

    await expect(requireAdminSession()).resolves.toBeUndefined();
  });
});

describe("logoutAction — Server-Action-level enforcement, independent of any page", () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    cookieStore.set.mockReset();
    cookieStore.delete.mockReset();
  });

  it("calling logoutAction directly with NO session cookie redirects to login WITHOUT clearing any cookie — proves the action enforces its own check rather than trusting the page that normally renders its button", async () => {
    cookieStore.get.mockReturnValue(undefined);

    await expect(logoutAction()).rejects.toMatchObject({ url: "/admin/login" });

    // If requireAdminSession() weren't called inside logoutAction itself,
    // this would proceed to clear a cookie on behalf of an unauthenticated
    // caller. It must not.
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });

  it("calling logoutAction with a valid session clears the cookie, then redirects to login", async () => {
    cookieStore.get.mockReturnValue(validSessionCookie());

    await expect(logoutAction()).rejects.toMatchObject({ url: "/admin/login" });

    expect(cookieStore.delete).toHaveBeenCalledWith("admin_session");
  });
});
