// Session 24 (§8c Tab 5): if the CLI (scripts/unstamp-roundup.ts) and the
// archive UI (app/admin/archive) ever diverge on the inverse of the
// double-post guarantee, that's the worst kind of bug this system could
// grow. This is a source-level guard, not a behavioral one (behavior is
// covered by tests/roundup-finalize.test.ts and tests/archive-actions.test.ts)
// — it just proves there is exactly one reversal implementation for both
// entry points to share, rather than a second copy quietly reappearing.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return readFileSync(path.join(__dirname, "..", relativePath), "utf-8");
}

describe("unstampRoundup — one implementation, two entry points", () => {
  it("the CLI script imports and calls unstampRoundup from lib/roundup-finalize.ts", () => {
    const source = read("scripts/unstamp-roundup.ts");
    expect(source).toMatch(/import\s*\{[^}]*unstampRoundup[^}]*\}\s*from\s*["']\.\.\/lib\/roundup-finalize["']/);
    expect(source).toMatch(/unstampRoundup\(/);
  });

  it("the archive UI's Server Action imports and calls unstampRoundup from lib/roundup-finalize.ts", () => {
    const source = read("app/admin/archive/unstamp-actions.ts");
    expect(source).toMatch(/import\s*\{[^}]*unstampRoundup[^}]*\}\s*from\s*["']@\/lib\/roundup-finalize["']/);
    expect(source).toMatch(/unstampRoundup\(/);
  });

  it("neither entry point contains its own DELETE FROM roundups — the only one lives in lib/roundup-finalize.ts", () => {
    expect(read("scripts/unstamp-roundup.ts")).not.toMatch(/DELETE FROM roundups/i);
    expect(read("app/admin/archive/unstamp-actions.ts")).not.toMatch(/DELETE FROM roundups/i);
    expect(read("lib/roundup-finalize.ts")).toMatch(/DELETE FROM roundups/i);
  });
});
