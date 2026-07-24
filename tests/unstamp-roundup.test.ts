import { describe, expect, it } from "vitest";
import { parseArgs } from "../scripts/unstamp-roundup";

describe("parseArgs", () => {
  it("parses --roundup-id <id>", () => {
    expect(parseArgs(["--roundup-id", "7"]).roundupId).toBe(7);
  });

  it("parses --roundup-id=<id>", () => {
    expect(parseArgs(["--roundup-id=7"]).roundupId).toBe(7);
  });

  it("roundupId is null when not given", () => {
    expect(parseArgs([]).roundupId).toBeNull();
  });

  it("dryRun is false by default, true with --dry-run", () => {
    expect(parseArgs(["--roundup-id", "7"]).dryRun).toBe(false);
    expect(parseArgs(["--roundup-id", "7", "--dry-run"]).dryRun).toBe(true);
  });
});
