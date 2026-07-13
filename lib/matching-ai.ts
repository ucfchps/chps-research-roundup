// The fuzzy-match escape hatch for §7's matching ladder — only reached when
// findMatch() (lib/matching.ts) returns NEEDS_FUZZY. Never send the whole
// table: the caller pre-filters to publications inside the merge-buffer
// window plus a margin, and FUZZY_MATCH_SHORTLIST_CAP is a hard backstop
// against a bug that would otherwise ship the entire table to Groq (§7).
import { AIUnavailableError, callAI } from "./ai";

export const FUZZY_MATCH_SHORTLIST_CAP = 30;

export interface FuzzyMatchCandidate {
  id: number;
  title: string;
}

function buildPrompt(candidateTitle: string, shortlist: FuzzyMatchCandidate[]): string {
  const lines = shortlist.map((c) => `${c.id}: ${c.title}`).join("\n");
  return [
    "Does the candidate title refer to the same publication as one of the shortlisted titles below?",
    "Titles may differ in truncation, subtitle formatting, or minor OCR/transcription noise.",
    "",
    `Candidate: ${candidateTitle}`,
    "",
    "Shortlist:",
    lines,
    "",
    'Reply with ONLY the numeric id of the matching shortlist entry, or the single word "NEW" if none match. No other text.',
  ].join("\n");
}

export async function fuzzyMatch(
  candidateTitle: string,
  shortlist: FuzzyMatchCandidate[]
): Promise<number | null> {
  if (shortlist.length > FUZZY_MATCH_SHORTLIST_CAP) {
    throw new Error(
      `fuzzyMatch: shortlist of ${shortlist.length} exceeds the ${FUZZY_MATCH_SHORTLIST_CAP}-item cap — ` +
        "pre-filter to publications inside the merge-buffer window before calling AI (§7)"
    );
  }
  if (shortlist.length === 0) return null;

  let text: string;
  try {
    const result = await callAI({
      appName: "research-roundup",
      taskType: "fuzzy_title_match",
      prompt: buildPrompt(candidateTitle, shortlist),
    });
    text = result.text;
  } catch (err) {
    // Degrading to "no match" is better than crashing ingestion (§10). A
    // possible duplicate awaiting the merge buffer is recoverable; a broken
    // pipeline is not.
    if (err instanceof AIUnavailableError) return null;
    throw err;
  }

  const answer = text.trim();
  if (answer === "NEW") return null;

  const id = Number(answer);
  if (!Number.isFinite(id)) return null;

  return shortlist.some((c) => c.id === id) ? id : null;
}
