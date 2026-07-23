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
// there's nothing for a Server Action to do here.
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
    <section className="border-t pt-8 flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Preview &amp; Export HTML</h2>
      <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded p-3">
        This does not mark any publication as posted. Nothing on this page writes to the database — these same publications
        remain eligible and will show up here again the next time this page is used, until a separate finalize step (not yet
        built) is run.
      </p>

      <div className="flex flex-col gap-3 max-w-xl">
        <label className="text-sm flex flex-col gap-1">
          Post title
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="border rounded px-3 py-1.5" />
        </label>
        <label className="text-sm flex flex-col gap-1">
          Intro paragraph
          <textarea value={intro} onChange={(e) => setIntro(e.target.value)} rows={3} className="border rounded px-3 py-1.5" />
        </label>
        <label className="text-sm flex flex-col gap-1">
          Legend line
          <input value={legend} onChange={(e) => setLegend(e.target.value)} className="border rounded px-3 py-1.5" />
        </label>
      </div>

      <button type="button" onClick={handleGenerate} className="rounded bg-black text-white px-4 py-2 self-start">
        Preview &amp; Export HTML
      </button>

      {html && (
        <div>
          <div className="flex gap-2 mb-2">
            <button
              type="button"
              onClick={() => setTab("preview")}
              className={`px-3 py-1 rounded text-sm ${tab === "preview" ? "bg-black text-white" : "border"}`}
            >
              Preview
            </button>
            <button
              type="button"
              onClick={() => setTab("source")}
              className={`px-3 py-1 rounded text-sm ${tab === "source" ? "bg-black text-white" : "border"}`}
            >
              HTML source
            </button>
          </div>

          {tab === "preview" ? (
            <div className="border rounded p-6 max-w-2xl" style={{ fontFamily: "Georgia, serif" }} dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <>
              <div className="flex gap-2 mb-2">
                <button type="button" onClick={handleCopy} className="rounded border px-3 py-1.5 text-sm">
                  {copied ? "Copied" : "Copy HTML"}
                </button>
                <button type="button" onClick={handleDownload} className="rounded border px-3 py-1.5 text-sm">
                  Download .html
                </button>
              </div>
              <pre className="border rounded p-4 bg-zinc-50 text-xs overflow-x-auto whitespace-pre-wrap">{html}</pre>
            </>
          )}
        </div>
      )}
    </section>
  );
}
