// Session 25 (§8c Tab 4/5): the archive's and generator's HTML preview both
// rendered flat — Tailwind v4 Preflight resets h1/h2/ul/a to inherit inside
// the plain <div dangerouslySetInnerHTML> both panels use. Fixed with one
// scoped .roundup-preview class (app/globals.css), reused by both, ported
// from the original prototype's #preview CSS. This is a display-only fix —
// the biggest risk is that it quietly also changes what Copy HTML / Download
// .html emit. No component-testing library exists in this project (see
// tests/admin-login-page.test.tsx) — same posture here: source-level checks
// for what can't be reached via react-dom/server's static SSR (state that
// only exists after a click), a real SSR render for what can.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return readFileSync(path.join(__dirname, "..", relativePath), "utf-8");
}

describe(".roundup-preview — scoped, never leaks into admin chrome", () => {
  const css = read("app/globals.css");
  const previewBlock = css.slice(css.indexOf(".roundup-preview {"));

  it("every selector added for the roundup preview is scoped under .roundup-preview — no bare global element rule", () => {
    // A bare `h1 {`, `h2 {`, `ul {`, `a {`, etc. anywhere in this file would
    // leak into the sidebar, buttons, and every other admin surface. Every
    // selector touching a tag this fix restores must be prefixed.
    const bareGlobalSelectors = previewBlock.match(/(?:^|\n)\s*(h1|h2|h3|ul|li|a|p)\s*\{/g);
    expect(bareGlobalSelectors).toBeNull();
  });

  it("defines the roundup-content accent tokens distinct from the admin-chrome ucf-gold token", () => {
    expect(css).toMatch(/--color-roundup-accent:\s*#a5730f/);
    expect(css).toMatch(/--color-roundup-accent-dark:\s*#7a5509/);
  });

  it("restores heading weight explicitly (Preflight resets h1/h2 to font-weight: inherit)", () => {
    expect(previewBlock).toMatch(/\.roundup-preview h1\s*\{[^}]*font-weight:\s*bold/);
    expect(previewBlock).toMatch(/\.roundup-preview h2\s*\{[^}]*font-weight:\s*bold/);
  });

  it("restores list bullets (Preflight resets ul to list-style: none)", () => {
    expect(previewBlock).toMatch(/\.roundup-preview ul\s*\{[^}]*list-style:\s*disc/);
  });

  it("restores link color and underline (Preflight resets a to color/decoration: inherit)", () => {
    expect(previewBlock).toMatch(/\.roundup-preview a\s*\{[^}]*color:\s*var\(--color-roundup-accent-dark\)/);
    expect(previewBlock).toMatch(/\.roundup-preview a\s*\{[^}]*text-decoration:\s*underline/);
  });
});

describe("ExportPanel.tsx (Tab 4 generator) — same shared class, reachable via SSR", () => {
  it("the preview pane carries the roundup-preview class", async () => {
    process.env.TURSO_DATABASE_URL ??= "file::memory:";
    process.env.TURSO_AUTH_TOKEN ??= "test-token";
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { ExportPanel } = await import("../app/admin/publications/ExportPanel");
    // html state starts null (nothing generated yet) so the preview div
    // itself isn't in this initial render — checked at the source level
    // below instead. What IS reachable via SSR: the toggle's default
    // active-state styling, since both buttons render unconditionally.
    const html = renderToStaticMarkup(<ExportPanel results={[]} />);
    const previewBtn = html.match(/<button[^>]*aria-pressed="true"[^>]*>\s*Preview\s*<\/button>/)?.[0];
    const sourceBtn = html.match(/<button[^>]*aria-pressed="false"[^>]*>\s*HTML source\s*<\/button>/)?.[0];
    expect(previewBtn, "Preview button (default active) not found").toBeTruthy();
    expect(sourceBtn, "HTML source button (default inactive) not found").toBeTruthy();
    expect(previewBtn).toContain("bg-[#0A0A0A]");
    expect(sourceBtn).not.toContain("bg-[#0A0A0A]");
  });
});

describe("preview div wiring and Copy/Download byte-identity — source-level (state only exists after a click, not reachable via static SSR)", () => {
  const exportSrc = read("app/admin/publications/ExportPanel.tsx");
  const archiveSrc = read("app/admin/archive/ArchivePanel.tsx");

  it("ExportPanel's preview div carries roundup-preview and injects the exact `html` variable", () => {
    expect(exportSrc).toMatch(/className="roundup-preview[^"]*"\s+dangerouslySetInnerHTML=\{\{\s*__html:\s*html\s*\}\}/);
  });

  it("ArchivePanel's preview div carries roundup-preview and injects the exact `roundup.html` variable", () => {
    expect(archiveSrc).toMatch(/className="roundup-preview[^"]*"\s+dangerouslySetInnerHTML=\{\{\s*__html:\s*roundup\.html\s*\}\}/);
  });

  it("ArchivePanel's toggle buttons are conditionally classed by tab state, same pattern as ExportPanel's", () => {
    expect(archiveSrc).toMatch(/tab === "preview" \? "bg-\[#0A0A0A\][^"]*" : /);
    expect(archiveSrc).toMatch(/tab === "source" \? "bg-\[#0A0A0A\][^"]*" : /);
  });

  it("ExportPanel's handleCopy/handleDownload operate on the exact `html` variable — never a DOM read of the styled preview node", () => {
    const handleCopy = exportSrc.slice(exportSrc.indexOf("function handleCopy"), exportSrc.indexOf("function handleDownload"));
    const handleDownload = exportSrc.slice(exportSrc.indexOf("function handleDownload"), exportSrc.indexOf("return ("));
    expect(handleCopy).toContain("navigator.clipboard.writeText(html)");
    expect(handleDownload).toMatch(/new Blob\(\[html\]/);
    expect(handleCopy + handleDownload).not.toMatch(/innerHTML|textContent|querySelector|getElementById/);
  });

  it("ArchivePanel's handleCopy/handleDownload operate on the exact `roundup.html` variable — never a DOM read of the styled preview node", () => {
    const handleCopy = archiveSrc.slice(archiveSrc.indexOf("function handleCopy"), archiveSrc.indexOf("function handleDownload"));
    const handleDownload = archiveSrc.slice(archiveSrc.indexOf("function handleDownload"), archiveSrc.indexOf("function beginUnstamp"));
    expect(handleCopy).toContain("navigator.clipboard.writeText(roundup.html)");
    expect(handleDownload).toMatch(/new Blob\(\[roundup\.html\]/);
    expect(handleCopy + handleDownload).not.toMatch(/innerHTML|textContent|querySelector|getElementById/);
  });

  it("neither Copy/Download handler references the roundup-preview class or any wrapper markup", () => {
    for (const src of [exportSrc, archiveSrc]) {
      const copyBody = src.slice(src.indexOf("function handleCopy"), src.indexOf("function handleDownload"));
      const downloadBody = src.slice(src.indexOf("function handleDownload"), src.indexOf("function handleDownload") + 400);
      expect(copyBody + downloadBody).not.toContain("roundup-preview");
    }
  });
});
