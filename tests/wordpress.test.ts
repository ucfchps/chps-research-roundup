// Ground truth: docs/wp-directory-notes.md §2 (field map), §5 (department term
// map), §7 (roster filter), §10 (named sample records). WpPerson fixtures below
// port each sample record's real field values into REST-shaped JSON.
import { describe, expect, it } from "vitest";
import { includeInRoster, mapPersonToFaculty, type WpPerson } from "../lib/wordpress";

// Real class-taxonomy term IDs are not given in the ground-truth doc (unlike
// departments) — the doc's own verification command (§11) fetches them live.
// 467 is the one real ID observed directly against the live endpoint (Fabiola
// Gomez, a CARD "Staff" record); Faculty/Leadership are illustrative IDs for
// this fixture map, standing in for whatever sync-roster resolves at runtime.
const CLASS_TERM_NAMES: Record<number, string> = {
  10: "Faculty",
  20: "Leadership",
  467: "Staff",
};

function person(overrides: Partial<WpPerson>): WpPerson {
  return {
    id: 0,
    slug: "",
    title: { rendered: "" },
    departments: [],
    class: [],
    acf: {
      profile_F_name: "",
      profile_L_name: "",
      email_address: "",
      google_scholar: "",
      orcid: "",
    },
    ...overrides,
  };
}

describe("mapPersonToFaculty — named sample records from §10", () => {
  it("Michael J. Rovito (wp_id 1163): confident citation, Health Sciences, Scholar + ORCID", () => {
    const p = person({
      id: 1163,
      slug: "michael-rovito",
      title: { rendered: "Michael J. Rovito" },
      departments: [232],
      class: [10],
      acf: {
        profile_F_name: "Michael J.",
        profile_L_name: "Rovito",
        email_address: "michael.rovito@ucf.edu",
        google_scholar: "https://scholar.google.com/citations?user=PhpZGb0AAAAJ&hl=en&oi=sra",
        orcid: "https://orcid.org/0000-0001-8086-3460",
      },
    });

    expect(mapPersonToFaculty(p, CLASS_TERM_NAMES)).toEqual({
      wp_id: "1163",
      slug: "michael-rovito",
      full_name: "Michael J. Rovito",
      display_name: "Rovito, M.J.",
      display_name_confident: true,
      email: "michael.rovito@ucf.edu",
      unit: "Department of Health Sciences",
      unit_reason: "ok",
      research_profile_url: "https://scholar.google.com/citations?user=PhpZGb0AAAAJ&hl=en&oi=sra",
      scholar_user_id: "PhpZGb0AAAAJ",
      orcid: "0000-0001-8086-3460",
      classification: "Faculty",
    });
  });

  it("Nicole Dawson Loughran (wp_id 1153): ambiguous citation name, multi-department -> KRS", () => {
    const p = person({
      id: 1153,
      slug: "nicole-dawson",
      title: { rendered: "Nicole Dawson Loughran" },
      departments: [239, 442], // Physical Therapy + Exercise Physiology (not a unit)
      class: [10],
      acf: {
        profile_F_name: "Nicole Dawson",
        profile_L_name: "Loughran",
        email_address: "nicole.dawson@ucf.edu",
        google_scholar: "https://scholar.google.com/citations?hl=en&user=NJ_hCq0AAAAJ",
        orcid: "",
      },
    });

    const result = mapPersonToFaculty(p, CLASS_TERM_NAMES);
    expect(result.display_name_confident).toBe(false);
    expect(result.unit).toBe("School of Kinesiology and Rehabilitation Sciences");
    expect(result.unit_reason).toBe("ok");
    expect(result.scholar_user_id).toBe("NJ_hCq0AAAAJ");
    expect(result.orcid).toBeNull();
  });

  it("Xiaochuan (Sharon) Wang (wp_id 2617): no research profile -> scholar_user_id null, orcid null", () => {
    const p = person({
      id: 2617,
      slug: "xiaochuan-wang",
      title: { rendered: "Xiaochuan (Sharon) Wang" },
      departments: [83],
      class: [10],
      acf: {
        profile_F_name: "Xiaochuan (Sharon)",
        profile_L_name: "Wang",
        email_address: "xiaochuan.wang@ucf.edu",
        google_scholar: "",
        orcid: "",
      },
    });

    const result = mapPersonToFaculty(p, CLASS_TERM_NAMES);
    expect(result.display_name).toBe("Wang, X.");
    expect(result.display_name_confident).toBe(true);
    expect(result.unit).toBe("School of Social Work");
    expect(result.research_profile_url).toBeNull();
    expect(result.scholar_user_id).toBeNull();
    expect(result.orcid).toBeNull();
  });

  it("Kimberley Gryglewicz (wp_id 973): ResearchGate profile -> scholar_user_id null despite a URL being present", () => {
    const p = person({
      id: 973,
      slug: "kimberley-gryglewicz",
      title: { rendered: "Kimberley Gryglewicz" },
      departments: [83, 446], // Social Work + CBHRT (not a unit)
      class: [10],
      acf: {
        profile_F_name: "Kimberley",
        profile_L_name: "Gryglewicz",
        email_address: "kgryglew@ucf.edu",
        google_scholar: "https://www.researchgate.net/profile/Kim_Gryglewicz",
        orcid: "https://orcid.org/0000-0003-4395-2354",
      },
    });

    const result = mapPersonToFaculty(p, CLASS_TERM_NAMES);
    expect(result.research_profile_url).toBe("https://www.researchgate.net/profile/Kim_Gryglewicz");
    expect(result.scholar_user_id).toBeNull();
    expect(result.orcid).toBe("0000-0003-4395-2354");
    expect(result.unit).toBe("School of Social Work");
  });

  it("Steven Burroughs (wp_id 9763): a bare DOI in the profile field -> scholar_user_id null", () => {
    const p = person({
      id: 9763,
      slug: "steven-burroughs",
      title: { rendered: "Steven Burroughs" },
      departments: [232],
      class: [10],
      acf: {
        profile_F_name: "Steven",
        profile_L_name: "Burroughs",
        email_address: "Steven.Burroughs@ucf.edu",
        google_scholar: "https://doi.org/10.1210/me.2012-1101",
        orcid: "",
      },
    });

    expect(mapPersonToFaculty(p, CLASS_TERM_NAMES).scholar_user_id).toBeNull();
  });

  it("Deena Schwen Blackett (wp_id 21309): compound surname stays intact and confident (no hyphen/particle/suffix)", () => {
    const p = person({
      id: 21309,
      slug: "deena-schwen-blackett",
      title: { rendered: "Deena Schwen Blackett" },
      departments: [166],
      class: [10],
      acf: {
        profile_F_name: "Deena",
        profile_L_name: "Schwen Blackett",
        email_address: "deena.blackett@ucf.edu",
        google_scholar: "https://www.researchgate.net/profile/Deena-Schwen-Blackett",
        orcid: "",
      },
    });

    const result = mapPersonToFaculty(p, CLASS_TERM_NAMES);
    expect(result.display_name).toBe("Schwen Blackett, D.");
    expect(result.display_name_confident).toBe(true);
    expect(result.scholar_user_id).toBeNull();
  });

  it("Ann Eddins: Leadership-only classification, real Scholar profile, resolves to CSD", () => {
    // The §7 regression fixture: a class=Faculty-only filter would drop her.
    const p = person({
      id: 88001,
      slug: "ann-eddins",
      title: { rendered: "Ann Eddins" },
      departments: [166],
      class: [20], // Leadership
      acf: {
        profile_F_name: "Ann",
        profile_L_name: "Eddins",
        email_address: "",
        google_scholar: "https://scholar.google.com/citations?view_op=list_works&hl=en&user=mG0VWxkAAAAJ",
        orcid: "",
      },
    });

    const result = mapPersonToFaculty(p, CLASS_TERM_NAMES);
    expect(result.classification).toBe("Leadership");
    expect(result.scholar_user_id).toBe("mG0VWxkAAAAJ");
    expect(result.unit).toBe("School of Communication Sciences and Disorders");
    expect(includeInRoster(result.classification, result.research_profile_url)).toBe(true);
  });

  it("Andrea Velez: Dean's Office only -> unit null, reason 'no canonical unit', still importable", () => {
    const p = person({
      id: 88002,
      slug: "andrea-velez",
      title: { rendered: "Andrea Velez" },
      departments: [71], // Dean's Office — not a roundup unit
      class: [20], // Leadership
      acf: {
        profile_F_name: "Andrea",
        profile_L_name: "Velez",
        email_address: "",
        google_scholar: "",
        orcid: "",
      },
    });

    const result = mapPersonToFaculty(p, CLASS_TERM_NAMES);
    expect(result.unit).toBeNull();
    expect(result.unit_reason).toBe("no canonical unit");
    // Leadership classification still includes her in the roster (§7) even
    // though she maps to no canonical unit — two independent, orthogonal facts.
    expect(includeInRoster(result.classification, result.research_profile_url)).toBe(true);
  });

  it("Darla Olive Talley: multi-valued classification 'Leadership|Staff' is never a single enum", () => {
    const p = person({
      id: 88003,
      slug: "darla-olive-talley",
      title: { rendered: "Darla Olive Talley" },
      departments: [71],
      class: [20, 467], // Leadership + Staff
      acf: {
        profile_F_name: "Darla Olive",
        profile_L_name: "Talley",
        email_address: "",
        google_scholar: "",
        orcid: "",
      },
    });

    const result = mapPersonToFaculty(p, CLASS_TERM_NAMES);
    expect(result.classification).toBe("Leadership|Staff");
    expect(result.unit).toBeNull();
    expect(result.unit_reason).toBe("no canonical unit");
  });
});

describe("includeInRoster — §7 roster filter", () => {
  it("Faculty classification alone -> included", () => {
    expect(includeInRoster("Faculty", null)).toBe(true);
  });

  it("Leadership classification alone -> included (the Ann Eddins case)", () => {
    expect(includeInRoster("Leadership", null)).toBe(true);
  });

  it("Staff classification with a research profile URL -> included (the self-healing CARD case)", () => {
    expect(includeInRoster("Staff", "https://scholar.google.com/citations?user=abc")).toBe(true);
  });

  it("Staff classification with no research profile URL -> excluded (the standing CARD gap)", () => {
    expect(includeInRoster("Staff", null)).toBe(false);
  });

  it("null classification and no profile URL -> excluded", () => {
    expect(includeInRoster(null, null)).toBe(false);
  });

  it("empty-string profile URL counts as absent", () => {
    expect(includeInRoster("Staff", "")).toBe(false);
  });
});
