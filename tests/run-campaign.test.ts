// Session 16.1: --test-recipient is CLI-flag-only, never an env default —
// the whole point is that it takes a conscious choice on every invocation.
import { describe, expect, it } from "vitest";
import { parseArgs } from "../scripts/run-campaign";

describe("parseArgs", () => {
  it("parses --cycle-label, --dry-run, --faculty (repeatable), and --test-recipient together", () => {
    const result = parseArgs(["--cycle-label", "Fall 2026", "--dry-run", "--faculty", "42", "--faculty", "43", "--test-recipient", "tester@ucf.edu"]);

    expect(result).toEqual({
      cycleLabel: "Fall 2026",
      dryRun: true,
      facultyWpIds: ["42", "43"],
      testRecipient: "tester@ucf.edu",
    });
  });

  it("testRecipient defaults to null when the flag is absent — no env fallback", () => {
    const result = parseArgs(["--cycle-label", "Fall 2026"]);

    expect(result.testRecipient).toBeNull();
  });

  it("parses --test-recipient=<email> form", () => {
    const result = parseArgs(["--cycle-label", "Fall 2026", "--test-recipient=tester@ucf.edu"]);

    expect(result.testRecipient).toBe("tester@ucf.edu");
  });

  it("cycleLabel defaults to today's date (YYYY-MM-DD) when --cycle-label is omitted", () => {
    const result = parseArgs(["--faculty", "42"]);

    expect(result.cycleLabel).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
