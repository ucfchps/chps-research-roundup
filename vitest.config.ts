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
});
