import { beforeEach, describe, expect, it, vi } from "vitest";

const callAIMock = vi.fn();
vi.mock("../lib/ai", () => ({
  callAI: (...args: unknown[]) => callAIMock(...args),
  AIUnavailableError: class AIUnavailableError extends Error {},
}));

import { fuzzyMatch, FUZZY_MATCH_SHORTLIST_CAP } from "../lib/matching-ai";
import { AIUnavailableError } from "../lib/ai";

describe("fuzzyMatch", () => {
  beforeEach(() => {
    callAIMock.mockReset();
  });

  it("sends the candidate title and shortlist, and returns the AI-chosen id", async () => {
    callAIMock.mockResolvedValue({ text: "42", inputTokens: 10, outputTokens: 1 });

    const result = await fuzzyMatch("Some Title", [
      { id: 42, title: "Some Titel (typo)" },
      { id: 99, title: "Unrelated" },
    ]);

    expect(result).toBe(42);
    expect(callAIMock).toHaveBeenCalledTimes(1);
    const call = callAIMock.mock.calls[0][0];
    expect(call.taskType).toBe("fuzzy_title_match");
    expect(call.prompt).toContain("Some Title");
    expect(call.prompt).toContain("Some Titel (typo)");
    expect(call.prompt).toContain("Unrelated");
  });

  it('returns null when the AI replies "NEW"', async () => {
    callAIMock.mockResolvedValue({ text: "NEW", inputTokens: 10, outputTokens: 1 });

    const result = await fuzzyMatch("Brand New Title", [{ id: 1, title: "Something Else" }]);

    expect(result).toBeNull();
  });

  it("returns null if the AI names an id that isn't actually in the shortlist", async () => {
    callAIMock.mockResolvedValue({ text: "999", inputTokens: 10, outputTokens: 1 });

    const result = await fuzzyMatch("Title", [{ id: 1, title: "Something" }]);

    expect(result).toBeNull();
  });

  it("an empty shortlist returns null without calling the AI", async () => {
    const result = await fuzzyMatch("Anything", []);

    expect(result).toBeNull();
    expect(callAIMock).not.toHaveBeenCalled();
  });

  it("degrades to null (not a crash) when AIUnavailableError is thrown — better a possible duplicate than a broken pipeline (§10)", async () => {
    callAIMock.mockRejectedValue(new AIUnavailableError("no provider configured"));

    const result = await fuzzyMatch("Title", [{ id: 1, title: "Something" }]);

    expect(result).toBeNull();
  });

  it("a non-AIUnavailableError still propagates — only the documented degrade path is swallowed", async () => {
    callAIMock.mockRejectedValue(new Error("something genuinely broke"));

    await expect(fuzzyMatch("Title", [{ id: 1, title: "Something" }])).rejects.toThrow(
      "something genuinely broke"
    );
  });

  it("a shortlist over the cap throws and never calls the AI — a bug that ships thousands of titles to Groq is exactly what §7 warns against", async () => {
    const overCap = Array.from({ length: FUZZY_MATCH_SHORTLIST_CAP + 1 }, (_, i) => ({
      id: i,
      title: `Title ${i}`,
    }));

    await expect(fuzzyMatch("Anything", overCap)).rejects.toThrow();
    expect(callAIMock).not.toHaveBeenCalled();
  });

  it("a shortlist exactly at the cap is allowed", async () => {
    callAIMock.mockResolvedValue({ text: "NEW", inputTokens: 1, outputTokens: 1 });
    const atCap = Array.from({ length: FUZZY_MATCH_SHORTLIST_CAP }, (_, i) => ({
      id: i,
      title: `Title ${i}`,
    }));

    await expect(fuzzyMatch("Anything", atCap)).resolves.toBeNull();
    expect(callAIMock).toHaveBeenCalledTimes(1);
  });
});
