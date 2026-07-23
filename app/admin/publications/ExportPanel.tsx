"use client";

import { useState } from "react";
import { buildExportHtml } from "@/lib/roundup-export";
import type { PublicationWithUnits } from "@/lib/publications";

const DEFAULT_TITLE = "Research Roundup: Publications by CHPS Faculty";
const DEFAULT_INTRO =
  "Faculty in the College of Health Professions and Sciences continue to advance research across a broad range of health and wellness topics. Below is a roundup of peer-reviewed publications by CHPS faculty during this period.";
const DEFAULT_LEGEND = "Bold denotes CHPS faculty. ** denotes a graduate student co-author. * denotes an undergraduate student co-author.";

// Pure client-side computation — buildExportHtml has no I/O, and this
// component already has the exact filtered results the server rendered, so
// there's nothing for a Server Action to do here. Visual only (Session
// 18.2): none of the state/handlers below changed from Session 18.
export function ExportPanel({ results }: { results: PublicationWithUnits[] }) {
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [intro, setIntro] = useState(DEFAULT_INTRO);
  const [legend, setLegend] = useState(DEFAULT_LEGEND);
  const [html, setHtml] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);

  function handleGenerate() {
    setHtml(buildExportHtml({ title, intro, legend, publications: results }));
    setTab("preview");
  }

  function handleCopy() {
    if (!html) return;
    navigator.clipboard.writeText(html);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  function handleDownload() {
    if (!html) return;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "research-roundup.html";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="border border-[#E5E5E5] rounded-xl bg-white overflow-hidden shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <div className="border-b border-[#E5E5E5] bg-[#FAFAFA] px-5 py-2.5 text-[13px] text-[#5B5B5B] flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-ucf-gold shrink-0" />
        This does not mark any publication as posted. Nothing on this page writes to the database — these same publications
        remain eligible and will show up here again the next time this page is used, until a separate finalize step (not yet
        built) is run.
      </div>

      <div className="p-5 flex flex-col gap-4">
        <p className="text-lg font-semibold" style={{ fontFamily: "var(--font-archivo)" }}>
          Preview &amp; Export HTML
        </p>

        <div className="flex flex-col gap-3 max-w-xl">
          <label className="text-sm flex flex-col gap-1">
            Post title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
            />
          </label>
          <label className="text-sm flex flex-col gap-1">
            Intro paragraph
            <textarea
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              rows={3}
              className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
            />
          </label>
          <label className="text-sm flex flex-col gap-1">
            Legend line
            <input
              value={legend}
              onChange={(e) => setLegend(e.target.value)}
              className="border border-[#D8D8D8] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/25"
            />
          </label>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setTab("preview")}
            className="border border-[#D8D8D8] text-sm px-3.5 py-1.5 rounded-md hover:border-[#B8B8B8] transition-colors"
            aria-pressed={tab === "preview"}
          >
            Preview
          </button>
          <button
            type="button"
            onClick={() => setTab("source")}
            className="border border-[#D8D8D8] text-sm px-3.5 py-1.5 rounded-md hover:border-[#B8B8B8] transition-colors"
            aria-pressed={tab === "source"}
          >
            HTML source
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            className="bg-[#0A0A0A] text-white text-sm font-medium px-3.5 py-1.5 rounded-md hover:bg-[#1A1A1A] transition-colors"
          >
            Preview &amp; Export HTML
          </button>
          {html && (
            <>
              <button
                type="button"
                onClick={handleCopy}
                className="bg-ucf-gold text-[#0A0A0A] font-medium text-sm px-3.5 py-1.5 rounded-md ml-auto hover:bg-[#E5B500] transition-colors"
              >
                {copied ? "Copied" : "Copy HTML"}
              </button>
              <button
                type="button"
                onClick={handleDownload}
                className="border border-[#D8D8D8] text-sm px-3.5 py-1.5 rounded-md hover:border-[#B8B8B8] transition-colors"
              >
                Download .html
              </button>
            </>
          )}
        </div>

        {html &&
          (tab === "preview" ? (
            <div
              className="border border-[#E5E5E5] rounded-md p-6 max-w-2xl"
              style={{ fontFamily: "Georgia, serif" }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <pre
              className="border border-[#E5E5E5] rounded-md p-4 bg-[#FAFAFA] text-xs overflow-x-auto whitespace-pre-wrap"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              {html}
            </pre>
          ))}
      </div>
    </div>
  );
}
