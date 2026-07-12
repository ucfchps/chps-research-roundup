import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.fn();
vi.mock("../lib/db", () => ({
  execute: (...args: unknown[]) => executeMock(...args),
}));

import { callAI, callAIJson, AIUnavailableError } from "../lib/ai";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("callAI", () => {
  beforeEach(() => {
    process.env.AI_PROVIDER = "groq";
    process.env.AI_MODEL = "test-model";
    process.env.GROQ_API_KEY = "test-key";
    executeMock.mockReset();
    executeMock.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns text and token counts on the happy path", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    );

    const result = await callAI({ appName: "research-roundup", taskType: "test", prompt: "hi" });

    expect(result).toEqual({ text: "hello", inputTokens: 10, outputTokens: 5 });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [, args] = executeMock.mock.calls[0] as [string, unknown[]];
    expect(args).toEqual(["research-roundup", "groq", "test-model", "test", 10, 5, 1, expect.any(String)]);
  });

  it("retries once on a 429 and succeeds on the next attempt", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })
      );

    const result = await callAI({ appName: "a", taskType: "t", prompt: "p" });

    expect(result.text).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("throws AIUnavailableError after exhausting the retry budget on persistent 429s", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}, 429, { "retry-after": "0" }));

    await expect(callAI({ appName: "a", taskType: "t", prompt: "p" })).rejects.toBeInstanceOf(
      AIUnavailableError
    );
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("still writes a usage_log row with success = 0 when the call ultimately fails", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}, 429, { "retry-after": "0" }));

    await expect(callAI({ appName: "a", taskType: "t", prompt: "p" })).rejects.toThrow();

    expect(executeMock).toHaveBeenCalledTimes(1);
    const [, args] = executeMock.mock.calls[0] as [string, unknown[]];
    // app_name, provider, model, task_type, input_tokens, output_tokens, success, created_at
    expect(args[4]).toBeNull();
    expect(args[5]).toBeNull();
    expect(args[6]).toBe(0);
  });

  it("callAIJson parses a response wrapped in ```json fences", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: '```json\n{"a":1}\n```' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      })
    );

    const parsed = await callAIJson<{ a: number }>({ appName: "a", taskType: "t", prompt: "p" });

    expect(parsed).toEqual({ a: 1 });
  });
});
