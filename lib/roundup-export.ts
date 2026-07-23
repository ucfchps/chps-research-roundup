// Session 18 (§8c Tab 4, partial): assembles the post-shaped HTML export for
// the publications browser. Pure — no I/O, no DB — built entirely on
// lib/citation.ts's already-tested formatCitation/sortCitationsWithinUnit,
// not a second citation formatter. See tests/roundup-export.test.ts's
// round-trip test, which reuses Session 3's exact fixture data to prove this.
import { formatCitation, sortCitationsWithinUnit, type PublicationWithAuthors } from "./citation";
import type { PublicationWithUnits } from "./publications";
import { UNITS, type Unit } from "./types";

function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface ExportInput {
  title: string;
  intro: string;
  legend: string;
  publications: PublicationWithUnits[];
}

// §8c Tab 4's exact structure: h1 title, intro p, legend p/em, a Quick jump
// h2+ul (anchors for units PRESENT in this result set only — never all five
// canonical units unconditionally), then per present unit a h2#{slug}
// followed by one <p> per citation, sorted within the unit and duplicated
// once per unit a multi-unit paper belongs to (§6a — this is a feature, not
// a bug, and this export must visibly demonstrate it, not hide it).
export function buildExportHtml(input: ExportInput): string {
  const byUnit = new Map<Unit, PublicationWithAuthors[]>();
  for (const entry of input.publications) {
    for (const unit of entry.units) {
      if (!byUnit.has(unit)) byUnit.set(unit, []);
      byUnit.get(unit)!.push({ publication: entry.publication, authors: entry.authors });
    }
  }

  const presentUnits = UNITS.filter((unit) => byUnit.has(unit));

  let html = "";
  html += `<h1>${escapeHtml(input.title)}</h1>\n`;
  html += `<p>${escapeHtml(input.intro)}</p>\n`;
  html += `<p><em>${escapeHtml(input.legend)}</em></p>\n`;
  html += `<h2>Quick jump</h2>\n<ul>\n`;
  for (const unit of presentUnits) {
    html += `  <li><a href="#${slugify(unit)}">${escapeHtml(unit)}</a></li>\n`;
  }
  html += `</ul>\n`;

  for (const unit of presentUnits) {
    html += `\n<h2 id="${slugify(unit)}">${escapeHtml(unit)}</h2>\n`;
    const sorted = sortCitationsWithinUnit(byUnit.get(unit)!);
    for (const item of sorted) {
      html += `<p>${formatCitation(item.publication, item.authors)}</p>\n`;
    }
  }

  return html;
}
