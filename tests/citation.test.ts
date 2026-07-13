// Ground truth for these tests is tests/fixtures/live-post-citations.html — read
// its top comment block first. Expected strings below are OUR clean-HTML format
// (<strong>/<em>/<a>, bare "**"/"*"), never the source's Word-pasted <b>/<span
// data-contrast> markup. See that file's comment block for how each snippet maps
// to author name/role/position.
import { describe, expect, it } from "vitest";
import {
  formatAuthor,
  formatAuthorList,
  formatCitation,
  sortCitationsWithinUnit,
  unitsForPublication,
} from "../lib/citation";
import type { Faculty, Publication, PublicationAuthor } from "../lib/types";

function makeAuthor(
  overrides: Partial<PublicationAuthor> &
    Pick<PublicationAuthor, "name" | "role" | "position">
): PublicationAuthor {
  return {
    id: 0,
    publication_id: 0,
    faculty_id: null,
    role_set_by: null,
    role_set_at: null,
    ...overrides,
  };
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
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeFaculty(id: number, unit: Faculty["unit"]): Faculty {
  return {
    id,
    wp_id: null,
    slug: null,
    display_name: `Faculty ${id}`,
    full_name: null,
    email: null,
    unit,
    research_profile_url: null,
    scholar_user_id: null,
    orcid: null,
    classification: null,
    active: 1,
    last_alert_seen_at: null,
    last_synced_at: null,
  };
}

describe("formatCitation — fixture reconstructions", () => {
  it("reconstructs snippet 3 (Rovito/Brazendale testicular-cancer paper): undergrad asterisk + volume-only degrade", () => {
    // Positions/roles inferred from the fixture: <b>-wrapped = chps_faculty,
    // "Martinez, S.*" = undergrad_student (bare text, confirmed by fixture note 2),
    // everyone else unknown (ingest never assigns 'external' on its own — §6, §15.4).
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

    const html = formatCitation(pub, authors);

    expect(html).toBe(
      "<strong>Rovito, M.J.</strong>, <strong>Brazendale, K.</strong>, Gibson, S., Martinez, S.*, Fairman, C., Badolato, C., Lyon, T., Baird, B., Langan, J., & Leslie, M.K." +
        " (2025). " +
        '<a href="https://journals.sagepub.com/doi/10.1177/17562872251322658">Physical Activity and Testicular Cancer Survivorship Health-Related Quality of Life: A Scoping Review</a>. ' +
        "<em>Therapeutic Advances in Urology</em>, 17."
    );
    // No stray comma or empty parens with volume present but issue/pages absent.
    expect(html).not.toContain("()");
    expect(html).not.toContain(", .");
  });

  it("reconstructs snippet 4 (Lee, E.): grad + undergrad markers coexisting, bold author last after &", () => {
    const authors: PublicationAuthor[] = [
      makeAuthor({ name: "Lopez Torralba, L.", role: "undergrad_student", position: 0 }),
      makeAuthor({ name: "Sukhu, B.", role: "grad_student", position: 1 }),
      makeAuthor({ name: "de Azevedo Daruge, M. E.", role: "undergrad_student", position: 2 }),
      makeAuthor({ name: "Chung, J.", role: "unknown", position: 3 }),
      makeAuthor({ name: "Loerzel, V.", role: "unknown", position: 4 }),
      makeAuthor({ name: "Lee, E.", role: "chps_faculty", position: 5 }),
    ];
    const pub = makePublication({
      title: "Evaluating Fatalism Among Breast Cancer Survivors in a Heterogeneous Hispanic Population: A Cross-Sectional Study",
      url: "https://www.mdpi.com/1718-7729/32/8/461",
      journal: "Current Oncology",
      year: 2025,
      volume: "32",
      issue: "8",
      pages: "461",
    });

    const html = formatCitation(pub, authors);

    expect(html).toBe(
      "Lopez Torralba, L.*, Sukhu, B.**, de Azevedo Daruge, M. E.*, Chung, J., Loerzel, V., & <strong>Lee, E.</strong>" +
        " (2025). " +
        '<a href="https://www.mdpi.com/1718-7729/32/8/461">Evaluating Fatalism Among Breast Cancer Survivors in a Heterogeneous Hispanic Population: A Cross-Sectional Study</a>. ' +
        "<em>Current Oncology</em>, 32(8), 461."
    );
  });

  it("the Brazendale §6a pair: one authoritative author-role record renders identically under every unit it belongs to", () => {
    // Seeded from snippet 1 (Social Work copy)'s bolding — Brazendale, Jeune,
    // Lawrence, and Gurnukar are chps_faculty. Snippet 2 (Health Sciences copy)
    // bolds only Brazendale/Jeune and disagrees on Lawrence/Gurnukar — that
    // disagreement is exactly the §6a bug this test guards against. Our system
    // has one record, so it cannot reproduce it.
    //
    // Also note, for a later session (§7, matching engine — not this formatter's
    // job): the two live snippets spell the same surname two different ways
    // ("Gurnukar" vs "Gurnurkar") and abbreviate another author's first name
    // differently ("Hunt, E." vs "Hunt, E.T."). Real-world name-matching noise,
    // not something formatCitation needs to resolve.
    const authors: PublicationAuthor[] = [
      makeAuthor({ name: "Brazendale, K.", role: "chps_faculty", position: 0, faculty_id: 1 }),
      makeAuthor({ name: "Jeune, S.", role: "chps_faculty", position: 1, faculty_id: 2 }),
      makeAuthor({ name: "Garcia, J.", role: "unknown", position: 2 }),
      makeAuthor({ name: "Quelly, S.", role: "unknown", position: 3 }),
      makeAuthor({ name: "Lawrence, S.", role: "chps_faculty", position: 4, faculty_id: 3 }),
      makeAuthor({ name: "Gurnukar, S.", role: "chps_faculty", position: 5, faculty_id: 4 }),
      makeAuthor({ name: "Hunt, E.", role: "unknown", position: 6 }),
      makeAuthor({ name: "Mehta, J.", role: "unknown", position: 7 }),
      makeAuthor({ name: "Dervisevic, A.", role: "unknown", position: 8 }),
    ];
    const facultyById: Record<number, Faculty> = {
      1: makeFaculty(1, "Department of Health Sciences"),
      2: makeFaculty(2, "School of Social Work"),
      3: makeFaculty(3, "School of Social Work"),
      4: makeFaculty(4, "School of Social Work"),
    };
    const pub = makePublication({
      title:
        "Initial Evidence Comparing Beverage and Snack Dietary Patterns of Children with Autism Spectrum Disorders During School Versus Summer Months",
      url: "https://www.tandfonline.com/doi/full/10.1080/20473869.2025.2512909",
      journal: "International Journal of Developmental Disabilities",
      year: 2025,
      volume: null,
      issue: null,
      pages: "1-10",
    });

    const units = unitsForPublication(authors, facultyById);
    expect(units).toEqual(["Department of Health Sciences", "School of Social Work"]);

    // Render once per unit the paper belongs to — must be byte-identical every time.
    const rendered = units.map(() => formatCitation(pub, authors));
    expect(rendered[0]).toBe(rendered[1]);
    expect(rendered[0]).toContain("<strong>Lawrence, S.</strong>");
    expect(rendered[0]).toContain("<strong>Gurnukar, S.</strong>");
  });
});

describe("formatCitation — explicit edge cases", () => {
  it("renders unknown and external identically", () => {
    const unknown = makeAuthor({ name: "Smith, J.", role: "unknown", position: 0 });
    const external = makeAuthor({ name: "Smith, J.", role: "external", position: 0 });
    expect(formatAuthor(unknown)).toBe(formatAuthor(external));
    expect(formatAuthor(unknown)).toBe("Smith, J.");
  });

  it("orders authors by position, not by array order", () => {
    const shuffled: PublicationAuthor[] = [
      makeAuthor({ name: "Third, C.", role: "unknown", position: 2 }),
      makeAuthor({ name: "First, A.", role: "unknown", position: 0 }),
      makeAuthor({ name: "Second, B.", role: "unknown", position: 1 }),
    ];
    expect(formatAuthorList(shuffled)).toBe("First, A., Second, B., & Third, C.");
  });

  it("degrades a volume-only citation cleanly (no issue, no pages)", () => {
    const pub = makePublication({ journal: "Some Journal", volume: "9", issue: null, pages: null });
    const html = formatCitation(pub, [makeAuthor({ name: "Author, A.", role: "unknown", position: 0 })]);
    expect(html).toContain("<em>Some Journal</em>, 9.");
    expect(html).not.toContain("()");
    expect(html).not.toContain(", .");
  });

  it("escapes & and quotes exactly once, and does not double-escape pre-escaped upstream entities", () => {
    const pub = makePublication({
      title: 'A "Big" Study & Its Outcomes',
      journal: "Journal of A & B",
    });
    const authors = [makeAuthor({ name: "O'Brien & Smith, J.", role: "unknown", position: 0 })];

    const html = formatCitation(pub, authors);
    expect(html).toContain("A &quot;Big&quot; Study &amp; Its Outcomes");
    expect(html).toContain("Journal of A &amp; B");
    expect(html).toContain("O&#39;Brien &amp; Smith, J.");

    const preEscaped = makeAuthor({ name: "Smith &amp; Jones, R.", role: "unknown", position: 0 });
    expect(formatAuthor(preEscaped)).toBe("Smith &amp; Jones, R.");
  });

  it("sortCitationsWithinUnit sorts by first author's surname, handling names without a comma", () => {
    const withZ = { publication: makePublication({ id: 1 }), authors: [makeAuthor({ name: "Zraick, R.I.", role: "chps_faculty", position: 0 })] };
    const withA = { publication: makePublication({ id: 2 }), authors: [makeAuthor({ name: "Awan, S.N.", role: "chps_faculty", position: 0 })] };
    const noComma = { publication: makePublication({ id: 3 }), authors: [makeAuthor({ name: "NoComma", role: "unknown", position: 0 })] };

    const sorted = sortCitationsWithinUnit([withZ, withA, noComma]);

    expect(sorted.map((p) => p.publication.id)).toEqual([2, 3, 1]);
  });
});
