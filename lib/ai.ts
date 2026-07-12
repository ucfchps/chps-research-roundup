// Single entry point for every AI call in this codebase. See §10 of the master plan.
// Deterministic parsing is the primary path elsewhere; this is the fallback/quality
// layer (§15.2), so failures here degrade the pipeline rather than crash it.
import { execute } from "./db";

export class AIUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AIUnavailableError";
  }
}

interface ProviderConfig {
  baseURL: string;
  apiKeyEnv: string;
}

// Adding a provider is adding a line here — call sites never change (§10, §15.5).
const PROVIDERS: Record<string, ProviderConfig> = {
  groq: { baseURL: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
};

const MAX_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CallAIOptions {
  appName: string;
  taskType: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
}

export interface CallAIResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

async function logUsage(row: {
  appName: string;
  provider: string;
  model: string;
  taskType: string;
  inputTokens: number | null;
  outputTokens: number | null;
  success: boolean;
}) {
  try {
    await execute(
      `INSERT INTO usage_log (app_name, provider, model, task_type, input_tokens, output_tokens, success, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.appName,
        row.provider,
        row.model,
        row.taskType,
        row.inputTokens,
        row.outputTokens,
        row.success ? 1 : 0,
        new Date().toISOString(),
      ]
    );
  } catch (err) {
    // Losing a log row is acceptable; losing the pipeline is not (§10).
    console.error("Failed to write usage_log row:", err);
  }
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

function backoffDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const base = 500 * 2 ** attempt;
  return base + Math.random() * base * 0.5;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type AttemptResult =
  | { ok: true; json: any }
  | { ok: false; retryable: boolean; error: Error; retryAfterMs?: number };

async function requestOnce(
  url: string,
  apiKey: string,
  body: Record<string, unknown>
): Promise<AttemptResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 429 || res.status >= 500) {
      return {
        ok: false,
        retryable: true,
        error: new Error(`AI provider returned ${res.status}`),
        retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
      };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        retryable: false,
        error: new Error(`AI provider returned ${res.status}: ${text}`),
      };
    }

    return { ok: true, json: await res.json() };
  } catch (err) {
    // Network errors and timeouts (AbortError) are transient — worth retrying.
    return { ok: false, retryable: true, error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

export async function callAI(opts: CallAIOptions): Promise<CallAIResult> {
  const provider = process.env.AI_PROVIDER ?? "";
  const model = process.env.AI_MODEL ?? "";
  const providerConfig = PROVIDERS[provider];
  const apiKey = providerConfig ? process.env[providerConfig.apiKeyEnv] : undefined;

  if (!providerConfig || !apiKey || !model) {
    const message = !providerConfig
      ? `Unknown or unset AI_PROVIDER "${provider}"`
      : !apiKey
        ? `${providerConfig.apiKeyEnv} is not set`
        : "AI_MODEL is not set";
    await logUsage({
      appName: opts.appName,
      provider: provider || "unknown",
      model: model || "unknown",
      taskType: opts.taskType,
      inputTokens: null,
      outputTokens: null,
      success: false,
    });
    throw new AIUnavailableError(message);
  }

  const systemParts = [
    ...(opts.system ? [opts.system] : []),
    ...(opts.json ? ["Respond with only valid JSON. No prose, no explanation, no markdown code fences."] : []),
  ];

  const messages = [
    ...(systemParts.length > 0 ? [{ role: "system" as const, content: systemParts.join("\n\n") }] : []),
    { role: "user" as const, content: opts.prompt },
  ];

  const body: Record<string, unknown> = {
    model,
    messages,
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  };

  const url = `${providerConfig.baseURL}/chat/completions`;
  let lastError: Error = new Error("AI request never attempted");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const result = await requestOnce(url, apiKey, body);

    if (result.ok) {
      const text = result.json?.choices?.[0]?.message?.content ?? "";
      const inputTokens = result.json?.usage?.prompt_tokens ?? 0;
      const outputTokens = result.json?.usage?.completion_tokens ?? 0;
      await logUsage({
        appName: opts.appName,
        provider,
        model,
        taskType: opts.taskType,
        inputTokens,
        outputTokens,
        success: true,
      });
      return { text, inputTokens, outputTokens };
    }

    lastError = result.error;
    const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
    if (!result.retryable || isLastAttempt) break;
    await sleep(backoffDelayMs(attempt, result.retryAfterMs));
  }

  await logUsage({
    appName: opts.appName,
    provider,
    model,
    taskType: opts.taskType,
    inputTokens: null,
    outputTokens: null,
    success: false,
  });
  throw new AIUnavailableError("AI provider unavailable after retries", { cause: lastError });
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : trimmed;
}

export async function callAIJson<T>(opts: Omit<CallAIOptions, "json">): Promise<T> {
  const result = await callAI({ ...opts, json: true });
  const stripped = stripCodeFences(result.text);
  try {
    return JSON.parse(stripped) as T;
  } catch {
    throw new Error(`callAIJson: failed to parse AI response as JSON. Raw text: ${result.text}`);
  }
}
