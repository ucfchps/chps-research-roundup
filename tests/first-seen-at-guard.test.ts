// Phase 5 hardening (master plan §13 Phase 5). first_seen_at (§7) drives
// release-buffer's merge-window math — an UPDATE that quietly resets it lets
// a long-collected record skip its buffer, or holds a genuinely new one back
// forever if reset the wrong way. Crude, source-level, and deliberately so:
// this is the house rule most likely to be broken by a well-meaning future
// change (someone adding a new field to an existing UPDATE ... SET clause
// and copy-pasting first_seen_at along with it), and a regex over real
// files catches that class of mistake regardless of which script it lands in
// — a unit test against one job's behavior wouldn't.
//
// The one sanctioned exception: lib/needs-metadata.ts's manual completion
// out of needs_metadata (§6 documented exception) — a human-driven promotion,
// not an ingestion job's own re-run. Every ingestion job's own UPDATE (in
// scripts/ingest-scholar.ts, scripts/ingest-crossref.ts,
// scripts/ingest-pubmed-orcid.ts) DOES mention first_seen_at in its SET
// clause, but wrapped in `COALESCE(?, first_seen_at)` — a self-preserving
// assignment: the column only actually changes when a non-null value is
// explicitly passed (the needs_metadata-promotion-during-merge case, per
// lib/matching.ts::promoteFromNeedsMetadata), otherwise it's a no-op
// re-assignment to its own current value. That pattern is allowed anywhere;
// what this guard actually forbids is a BARE `first_seen_at = <something
// that isn't COALESCE(...)>` outside the one sanctioned file — an
// unconditional overwrite, the shape that actually breaks the buffer.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(__dirname, "..");
const SANCTIONED_FILES = new Set([path.join(REPO_ROOT, "lib", "needs-metadata.ts")]);

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => path.join(dir, name));
}

// Matches `first_seen_at` immediately followed by `=` (an assignment — this
// is what an UPDATE ... SET clause looks like; a plain INSERT column list
// never has an `=` sign at all, so this pattern structurally can't false-
// positive on an INSERT). Captures whether the very next non-whitespace
// token is `COALESCE(`.
const ASSIGNMENT_PATTERN = /first_seen_at\s*=\s*(COALESCE\()?/g;

function findUnguardedAssignments(source: string): number {
  let count = 0;
  for (const match of source.matchAll(ASSIGNMENT_PATTERN)) {
    if (!match[1]) count++; // no COALESCE( immediately following — a bare/unconditional overwrite
  }
  return count;
}

describe("first_seen_at guard — no unconditional overwrite outside the one sanctioned file", () => {
  const scannedFiles = [...tsFilesIn(path.join(REPO_ROOT, "scripts")), ...tsFilesIn(path.join(REPO_ROOT, "lib"))];

  it("sanity: the scan actually covers real files, and the sanctioned exception file genuinely exists and is included", () => {
    expect(scannedFiles.length).toBeGreaterThan(20); // scripts/ + lib/ combined — a real, non-trivial set
    expect(scannedFiles).toContain([...SANCTIONED_FILES][0]);
  });

  it("★ proves the guard can actually fail — a hand-built bare assignment IS flagged, a COALESCE-wrapped one is NOT", () => {
    expect(findUnguardedAssignments("UPDATE publications SET first_seen_at = ? WHERE id = ?")).toBe(1);
    expect(findUnguardedAssignments("UPDATE publications SET first_seen_at = COALESCE(?, first_seen_at) WHERE id = ?")).toBe(0);
    expect(findUnguardedAssignments("INSERT INTO publications (first_seen_at, title) VALUES (?, ?)")).toBe(0); // no `=` at all
  });

  for (const file of tsFilesIn(path.join(REPO_ROOT, "scripts"))) {
    it(`scripts/${path.basename(file)}: no unconditional first_seen_at overwrite on an UPDATE`, () => {
      const source = readFileSync(file, "utf-8");
      const unguarded = findUnguardedAssignments(source);
      expect(unguarded, `${file} has ${unguarded} bare (non-COALESCE) first_seen_at assignment(s) — scripts/ has no sanctioned exception`).toBe(0);
    });
  }

  for (const file of tsFilesIn(path.join(REPO_ROOT, "lib"))) {
    it(`lib/${path.basename(file)}: unconditional first_seen_at overwrite only allowed in the sanctioned needs-metadata.ts file`, () => {
      const source = readFileSync(file, "utf-8");
      const unguarded = findUnguardedAssignments(source);
      if (SANCTIONED_FILES.has(file)) {
        // The sanctioned file must actually contain the exception it's sanctioned
        // for — an empty allowlist entry (e.g. after a future refactor moved the
        // write elsewhere) would silently stop this test from meaning anything.
        expect(unguarded, `${file} is the sanctioned exception but no longer contains an unconditional first_seen_at assignment at all — is the promotion write still here?`).toBeGreaterThan(0);
      } else {
        expect(unguarded, `${file} has ${unguarded} bare (non-COALESCE) first_seen_at assignment(s) — only lib/needs-metadata.ts is sanctioned for this`).toBe(0);
      }
    });
  }
});
