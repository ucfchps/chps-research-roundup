// Mirrors tsconfig.json's "@/*" -> "./*" path alias. Needed the moment a
// test transitively imports a file that uses it (app/admin/session.ts is
// the first) — Next.js resolves this alias itself, but vitest doesn't know
// about it without being told. Vite's own resolve.alias, no new dependency.
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  // JSX transform for .tsx test files (tests/admin-login-page.test.tsx,
  // Session 17.1). This Vite version transforms via oxc, not esbuild — an
  // `esbuild.jsx` option here is silently ignored in favor of oxc's own
  // config, hence `oxc` (not `esbuild`) below. Vite/oxc's own transform, not
  // @vitejs/plugin-react, since this is the only thing that needed it.
  oxc: {
    jsx: { runtime: "automatic" },
  },
});
