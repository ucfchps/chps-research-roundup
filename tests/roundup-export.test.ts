// Session 18: assembles the same post structure §8c Tab 4 specifies, built
// ENTIRELY on lib/citation.ts's already-tested formatters — not a
// reimplementation. The round-trip test below reuses the exact fixture data
// and expected string from tests/citation.test.ts (Session 3) to prove this
// calls the same formatCitation, not a close-enough copy.
import { describe, expect, it } from "vitest";
import { buildExportHtml } from "../lib/roundup-export";
import { formatCitation } from "../lib/citation";
import type { Publication, PublicationAuthor, Unit } from "../lib/types";
import type { PublicationWithUnits } from "../lib/publications";

function makeAuthor(overrides: Partial<PublicationAuthor> & Pick<PublicationAuthor, "name" | "role" | "position">): PublicationAuthor {
  return { id: 0, publication_id: 0, faculty_id: null, role_set_by: null, role_set_at: null, ...overrides };
}

function makePublication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: 0,
    doi: null,
    title: "Untitled",
    title_normalized: "untitled",
    url: "https://example.com",
    journal: null,
    year: 2025,
    volume: null,
    issue: null,
    pages: null,
    status: "published",
    source: "manual",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    date_added: "2026-01-01",
    released_at: null,
    roundup_id: null,
    discovered_by_faculty_id: null,
    scholar_alert_url: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEntry(publication: Publication, authors: PublicationAuthor[], units: Unit[]): PublicationWithUnits {
  // ready is irrelevant to export/citation formatting — buildExportHtml
  // never reads it. Defaulted here purely to satisfy the type.
  return { publication, authors, units, ready: false };
}

describe("buildExportHtml", () => {
  it("assembles h1 title, intro p, legend p/em, quick-jump ul, and per-unit h2+citations", () => {
    const authors = [makeAuthor({ name: "Stock, M.", role: "chps_faculty", position: 0 })];
    const pub = makePublication({ title: "A Paper", journal: "A Journal", year: 2026 });
    const entries = [makeEntry(pub, authors, ["Department of Health Sciences"])];

    const html = buildExportHtml({ title: "Research Roundup", intro: "Intro text.", legend: "Legend text.", publications: entries });

    expect(html).toContain("<h1>Research Roundup</h1>");
    expect(html).toContain("<p>Intro text.</p>");
    expect(html).toContain("<p><em>Legend text.</em></p>");
    expect(html).toContain("<h2>Quick jump</h2>");
    expect(html).toContain('<li><a href="#department-of-health-sciences">Department of Health Sciences</a></li>');
    expect(html).toContain('<h2 id="department-of-health-sciences">Department of Health Sciences</h2>');
    expect(html).toContain(`<p>${formatCitation(pub, authors)}</p>`);
  });

  it("★ round-trip: reuses the exact Session 3 fixture and produces the byte-identical formatCitation output, not a reimplementation", () => {
    // Reconstructed from tests/citation.test.ts's "snippet 3" test verbatim.
    const authors: PublicationAuthor[] = [
      makeAuthor({ name: "Rovito, M.J.", role: "chps_faculty", position: 0 }),
      makeAuthor({ name: "Brazendale, K.", role: "chps_faculty", position: 1 }),
      makeAuthor({ name: "Gibson, S.", role: "unknown", position: 2 }),
      makeAuthor({ name: "Martinez, S.", role: "undergrad_student", position: 3 }),
      makeAuthor({ name: "Fairman, C.", role: "unknown", position: 4 }),
      makeAuthor({ name: "Badolato, C.", role: "unknown", position: 5 }),
      makeAuthor({ name: "Lyon, T.", role: "unknown", position: 6 }),
      makeAuthor({ name: "Baird, B.", role: "unknown", position: 7 }),
      makeAuthor({ name: "Langan, J.", role: "unknown", position: 8 }),
      makeAuthor({ name: "Leslie, M.K.", role: "unknown", position: 9 }),
    ];
    const pub = makePublication({
      title: "Physical Activity and Testicular Cancer Survivorship Health-Related Quality of Life: A Scoping Review",
      url: "https://journals.sagepub.com/doi/10.1177/17562872251322658",
      journal: "Therapeutic Advances in Urology",
      year: 2025,
      volume: "17",
      issue: null,
      pages: null,
    });

    const expectedCitationHtml =
      "<strong>Rovito, M.J.</strong>, <strong>Brazendale, K.</strong>, Gibson, S., Martinez, S.*, Fairman, C., Badolato, C., Lyon, T., Baird, B., Langan, J., & Leslie, M.K." +
      " (2025). " +
      '<a href="https://journals.sagepub.com/doi/10.1177/17562872251322658">Physical Activity and Testicular Cancer Survivorship Health-Related Quality of Life: A Scoping Review</a>. ' +
      "<em>Therapeutic Advances in Urology</em>, 17.";

    const html = buildExportHtml({
      title: "t",
      intro: "i",
      legend: "l",
      publications: [makeEntry(pub, authors, ["Department of Health Sciences"])],
    });

    expect(html).toContain(`<p>${expectedCitationHtml}</p>`);
  });

  it("a multi-unit publication (the Brazendale §6a shape) renders once per unit, byte-identical, both anchors present", () => {
    const authors: PublicationAuthor[] = [
      makeAuthor({ name: "Brazendale, K.", role: "chps_faculty", position: 0, faculty_id: 1 }),
      makeAuthor({ name: "Jeune, S.", role: "chps_faculty", position: 1, faculty_id: 2 }),
      makeAuthor({ name: "Lawrence, S.", role: "chps_faculty", position: 2, faculty_id: 3 }),
      makeAuthor({ name: "Gurnukar, S.", role: "chps_faculty", position: 3, faculty_id: 4 }),
    ];
    const pub = makePublication({ title: "Two-Unit Paper", journal: "A Journal" });
    const entries = [makeEntry(pub, authors, ["Department of Health Sciences", "School of Social Work"])];

    const html = buildExportHtml({ title: "t", intro: "i", legend: "l", publications: entries });

    const citationHtml = `<p>${formatCitation(pub, authors)}</p>`;
    const occurrences = html.split(citationHtml).length - 1;
    expect(occurrences).toBe(2);
    expect(html).toContain('<h2 id="department-of-health-sciences">Department of Health Sciences</h2>');
    expect(html).toContain('<h2 id="school-of-social-work">School of Social Work</h2>');
    expect(html).toContain('<li><a href="#department-of-health-sciences">Department of Health Sciences</a></li>');
    expect(html).toContain('<li><a href="#school-of-social-work">School of Social Work</a></li>');
  });

  it("the quick-jump list and unit sections include only units actually present in the filtered results, not all five canonical units", () => {
    const authors = [makeAuthor({ name: "Stock, M.", role: "chps_faculty", position: 0 })];
    const pub = makePublication({ title: "Solo Unit Paper" });
    const entries = [makeEntry(pub, authors, ["School of Social Work"])];

    const html = buildExportHtml({ title: "t", intro: "i", legend: "l", publications: entries });

    expect(html).not.toContain("Department of Health Sciences");
    expect(html).not.toContain("Center for Autism");
    expect(html).not.toContain("Kinesiology");
    expect(html).not.toContain("Communication Sciences");
  });

  it("multiple present units are ordered by the canonical UNITS order, not insertion order", () => {
    const authorA = [makeAuthor({ name: "A, A.", role: "chps_faculty", position: 0 })];
    const authorB = [makeAuthor({ name: "B, B.", role: "chps_faculty", position: 0 })];
    // Insert School of Social Work (canonically last) before Center for
    // Autism (canonically second) — output order must still be canonical.
    const entries = [
      makeEntry(makePublication({ title: "Social Work Paper" }), authorA, ["School of Social Work"]),
      makeEntry(makePublication({ title: "Autism Center Paper" }), authorB, ["Center for Autism and Related Disabilities"]),
    ];

    const html = buildExportHtml({ title: "t", intro: "i", legend: "l", publications: entries });

    const autismIndex = html.indexOf("Center for Autism and Related Disabilities");
    const socialWorkIndex = html.indexOf("School of Social Work");
    expect(autismIndex).toBeGreaterThan(-1);
    expect(socialWorkIndex).toBeGreaterThan(-1);
    expect(autismIndex).toBeLessThan(socialWorkIndex);
  });

  it("sorts citations within a unit by first author surname via sortCitationsWithinUnit", () => {
    const zAuthor = [makeAuthor({ name: "Zraick, R.", role: "chps_faculty", position: 0 })];
    const aAuthor = [makeAuthor({ name: "Anderson, A.", role: "chps_faculty", position: 0 })];
    const entries = [
      makeEntry(makePublication({ title: "Z Paper" }), zAuthor, ["Department of Health Sciences"]),
      makeEntry(makePublication({ title: "A Paper" }), aAuthor, ["Department of Health Sciences"]),
    ];

    const html = buildExportHtml({ title: "t", intro: "i", legend: "l", publications: entries });

    const aIndex = html.indexOf("Anderson, A.");
    const zIndex = html.indexOf("Zraick, R.");
    expect(aIndex).toBeLessThan(zIndex);
  });

  it("escapes title/intro/legend", () => {
    const html = buildExportHtml({ title: "A & B", intro: "<script>", legend: "1 < 2", publications: [] });

    expect(html).toContain("A &amp; B");
    expect(html).not.toContain("<script>");
    expect(html).toContain("1 &lt; 2");
  });

  it("an empty publications list still produces a valid header with an empty quick-jump list", () => {
    const html = buildExportHtml({ title: "t", intro: "i", legend: "l", publications: [] });

    expect(html).toContain("<h1>t</h1>");
    expect(html).toContain("<h2>Quick jump</h2>");
    expect(html).toContain("<ul>\n</ul>");
  });
});
