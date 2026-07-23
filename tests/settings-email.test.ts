import { describe, expect, it } from "vitest";
import { parseArgs } from "../scripts/settings-email";

describe("parseArgs", () => {
  it("parses --status", () => {
    expect(parseArgs(["--status"]).mode).toBe("status");
  });

  it("parses --enable", () => {
    expect(parseArgs(["--enable"]).mode).toBe("enable");
  });

  it("parses --disable", () => {
    expect(parseArgs(["--disable"]).mode).toBe("disable");
  });

  it("mode is null when none of --status/--enable/--disable is given", () => {
    expect(parseArgs([]).mode).toBeNull();
  });

  it("parses --by <name>", () => {
    expect(parseArgs(["--enable", "--by", "David Janosik"]).by).toBe("David Janosik");
  });

  it("parses --by=<name>", () => {
    expect(parseArgs(["--enable", "--by=David Janosik"]).by).toBe("David Janosik");
  });

  it("defaults --by to an identifiable cli:$USER-shaped value when not passed", () => {
    const result = parseArgs(["--enable"]);
    expect(result.by).toMatch(/^cli:/);
  });
});
