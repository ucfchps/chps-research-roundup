// One-shot smoke test against the live AI provider. Run with: npm run check:ai
import { config } from "dotenv";
import path from "node:path";

config({ path: path.join(__dirname, "..", ".env.local") });

async function main() {
  // Dynamic import: lib/ai.ts pulls in lib/db.ts, which reads env vars at
  // import time. A static import here would be hoisted above config() above.
  const { callAI } = await import("../lib/ai");
  const result = await callAI({
    appName: "research-roundup",
    taskType: "check_ai",
    prompt: "Reply with the single word OK.",
  });

  console.log("text:", result.text);
  console.log("inputTokens:", result.inputTokens);
  console.log("outputTokens:", result.outputTokens);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
