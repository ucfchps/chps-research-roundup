// Session 17.1: a visual restyle must not silently disconnect the form from
// real auth. No component-testing library exists in this project — rather
// than add one, this uses react-dom/server (already a dependency) to render
// the actual page component and assert on the real HTML it produces, plus a
// source-level check that useActionState is still wired to the real
// loginAction import (not a copy, not a stub).
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// next/font/google only works inside Next's real build pipeline (it's a
// build-time macro) — calling it directly in a bare vitest render throws.
// Mocked with the minimal shape this page actually reads (.variable).
vi.mock("next/font/google", () => ({
  Archivo: () => ({ variable: "mock-archivo" }),
  Inter: () => ({ variable: "mock-inter" }),
  JetBrains_Mono: () => ({ variable: "mock-jetbrains-mono" }),
}));

// lib/db.ts throws at import time if these are unset — page.tsx transitively
// imports it via ./actions. Never actually queried in this test (the page
// is only rendered, never submitted), so dummy values are safe.
process.env.TURSO_DATABASE_URL ??= "file::memory:";
process.env.TURSO_AUTH_TOKEN ??= "test-token";

const { renderToStaticMarkup } = await import("react-dom/server");
const { default: AdminLoginPage } = await import("../app/admin/login/page");

describe("AdminLoginPage — render-level regression check", () => {
  it("renders a password input named 'password' and a submit button inside a form", () => {
    const html = renderToStaticMarkup(<AdminLoginPage />);

    expect(html).toContain('type="password"');
    expect(html).toContain('name="password"');
    expect(html).toMatch(/<form[^>]*>[\s\S]*<\/form>/);
    expect(html).toContain('type="submit"');
  });

  it("imports loginAction from ./actions and passes it to useActionState — the real Server Action, not a stub", () => {
    const source = readFileSync(path.join(__dirname, "..", "app", "admin", "login", "page.tsx"), "utf-8");

    expect(source).toMatch(/import\s*{\s*loginAction/);
    expect(source).toContain('from "./actions"');
    expect(source).toMatch(/useActionState\(\s*loginAction/);
  });
});
