// Deterministic Scholar-alert HTML parser. Pure — no I/O in the primary
// (deterministic) path. See master plan §5a and docs/scholar-alert-notes.md.
// The AI fallback (session prompt point 2, last paragraph) lives in a
// separate async function below, kept apart from this pure core the same
// way lib/matching.ts (pure) and lib/matching-ai.ts (I/O) are split.
import * as cheerio from "cheerio";
import { scholarUserId, unwrapGoogleRedirect } from "./scholar";
import { AIUnavailableError, callAIJson } from "./ai";

export interface ParsedArticle {
  title: string;
  year: number | null;
  scholarUrl: string | null;
  snippet: string | null;
}

export type ParsedAlert =
  | { kind: "articles"; scholarUserId: string; displayName: string; articles: ParsedArticle[] }
  | { kind: "rejected"; reason: "citation_alert" | "no_footer" | "no_scholar_id" | "no_articles"; detail: string };

function extractYear(bylineText: string): number | null {
  const match = bylineText.match(/(\d{4})\s*$/);
  return match ? Number(match[1]) : null;
}

// One block per <h3><a class="gse_alrt_title">...</a></h3>. Using cheerio's
// selector engine (not a raw-HTML regex/grep) means the .gse_alrt_title CSS
// rule inside <style> is never miscounted as an article — cheerio only
// matches real DOM elements with class="gse_alrt_title" (§5a rule 5,
// docs/scholar-alert-notes.md §6).
function extractArticlesDeterministic($: cheerio.CheerioAPI): ParsedArticle[] {
  const articles: ParsedArticle[] = [];

  $("a.gse_alrt_title").each((_, el) => {
    const $a = $(el);
    const title = $a.text().trim();
    const scholarUrl = $a.attr("href") ?? null;
    if (!title) return;

    const $h3 = $a.closest("h3");
    const $byline = $h3.next();
    const year = extractYear($byline.text());

    const $afterByline = $byline.next();
    const snippet = $afterByline.hasClass("gse_alrt_sni") ? $afterByline.text().trim() : null;

    articles.push({ title, year, scholarUrl, snippet });
  });

  return articles;
}

function findFooter($: cheerio.CheerioAPI): ReturnType<cheerio.CheerioAPI> | null {
  const footer = $("p").filter((_, el) => $(el).text().includes("This message was sent by Google Scholar"));
  return footer.length > 0 ? footer.first() : null;
}

// The synchronous, deterministic core. This is the "pure, no I/O" contract
// from the session prompt — the AI escape hatch is a separate function below.
export function parseAlertEmail(html: string, _subject: string): ParsedAlert {
  const $ = cheerio.load(html);

  const $footer = findFooter($);
  if (!$footer) {
    return { kind: "rejected", reason: "no_footer", detail: "no paragraph containing the Google Scholar sender line was found" };
  }

  const footerText = $footer.text();
  // §5a rule 2 / §15.8: the Gmail query already excludes "new citations"
  // alerts server-side, and this inbox has never actually received one
  // (docs/scholar-alert-notes.md §9) — assert the exclusion again anyway.
  if (!footerText.includes("written by")) {
    return { kind: "rejected", reason: "citation_alert", detail: `footer does not contain "written by": "${footerText.trim()}"` };
  }

  const $footerLink = $footer.find("a").first();
  const href = $footerLink.attr("href");
  if (!href) {
    return { kind: "rejected", reason: "no_footer", detail: "footer contains no link to unwrap" };
  }

  // §5a.3 — never fall back to the subject line name as the join key.
  const id = scholarUserId(unwrapGoogleRedirect(href));
  if (!id) {
    return { kind: "rejected", reason: "no_scholar_id", detail: `footer link did not yield a Scholar user ID: ${href}` };
  }

  const displayName = $footerLink.text().trim();
  const articles = extractArticlesDeterministic($);

  if (articles.length === 0) {
    return { kind: "rejected", reason: "no_articles", detail: "footer was valid but zero article blocks were found deterministically" };
  }

  return { kind: "articles", scholarUserId: id, displayName, articles };
}

interface AiExtractedArticle {
  title: string;
  year: number | null;
}

// §15.2 — deterministic first, AI second. Only reached when
// parseAlertEmail returned rejected: 'no_articles' with an otherwise-valid
// footer. No real fixture in this inbox needs this path (every real and
// synthetic fixture is extracted deterministically — see tests/scholar-alert.test.ts).
export async function parseAlertEmailWithAiFallback(html: string, subject: string): Promise<ParsedAlert> {
  const deterministic = parseAlertEmail(html, subject);
  if (deterministic.kind !== "rejected" || deterministic.reason !== "no_articles") return deterministic;

  const $ = cheerio.load(html);
  const $footer = findFooter($)!;
  const $footerLink = $footer.find("a").first();
  const id = scholarUserId(unwrapGoogleRedirect($footerLink.attr("href") ?? ""));
  if (!id) return deterministic; // shouldn't happen (parseAlertEmail already validated this), fail closed anyway

  try {
    const extracted = await callAIJson<{ articles: AiExtractedArticle[] }>({
      appName: "research-roundup",
      taskType: "parse_scholar_alert",
      prompt: [
        "Extract every distinct article title and publication year from this Google Scholar alert email HTML.",
        "Return ONLY title and year for each — never authors, never journal name.",
        "",
        html,
      ].join("\n"),
    });

    const articles: ParsedArticle[] = (extracted.articles ?? [])
      .filter((a) => a.title)
      .map((a) => ({ title: a.title, year: a.year ?? null, scholarUrl: null, snippet: null }));

    if (articles.length === 0) return deterministic;

    return { kind: "articles", scholarUserId: id, displayName: $footerLink.text().trim(), articles };
  } catch (err) {
    if (err instanceof AIUnavailableError) return deterministic; // skip and report, never guess
    throw err;
  }
}
