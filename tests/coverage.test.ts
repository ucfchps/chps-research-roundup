// Ground truth: amended master plan §11 and docs/wp-directory-notes.md §3.
import { describe, expect, it } from "vitest";
import { bucketForFaculty, classifyResearchProfile, emptyCanonicalUnits } from "../lib/coverage";
import { UNITS, type Faculty } from "../lib/types";

describe("classifyResearchProfile", () => {
  it("no URL at all -> no_profile", () => {
    expect(classifyResearchProfile(null)).toBe("no_profile");
    expect(classifyResearchProfile("")).toBe("no_profile");
    expect(classifyResearchProfile("   ")).toBe("no_profile");
  });

  it("a Scholar URL -> scholar", () => {
    expect(classifyResearchProfile("https://scholar.google.com/citations?user=abc123")).toBe("scholar");
  });

  it.each([
    ["ResearchGate profile", "https://www.researchgate.net/profile/Kim_Gryglewicz"],
    ["ResearchGate scientific-contributions", "https://www.researchgate.net/scientific-contributions/Erin-Leeming-2333782918"],
    ["MyNCBI bibliography", "https://www.ncbi.nlm.nih.gov/myncbi/1vG3CqHb_6cEik/bibliography/public/"],
  ])("%s -> known_non_scholar (a real fact, not a task — §11)", (_label, url) => {
    expect(classifyResearchProfile(url)).toBe("known_non_scholar");
  });

  it("a bare DOI pasted in by mistake -> unparseable (a bad directory link, §3 point 4)", () => {
    expect(classifyResearchProfile("https://doi.org/10.1210/me.2012-1101")).toBe("unparseable");
  });

  it("not a URL at all -> unparseable, never throws", () => {
    expect(() => classifyResearchProfile("not a url")).not.toThrow();
    expect(classifyResearchProfile("not a url")).toBe("unparseable");
  });
});

function makeFaculty(overrides: Partial<Faculty> = {}): Faculty {
  return {
    id: 0,
    wp_id: "1",
    slug: null,
    display_name: "Test, T.",
    full_name: null,
    email: null,
    unit: null,
    research_profile_url: null,
    scholar_user_id: null,
    orcid: null,
    classification: null,
    active: 1,
    last_alert_seen_at: null,
    last_synced_at: null,
    ...overrides,
  };
}

describe("bucketForFaculty — the amended §11 five buckets", () => {
  it("scholar_user_id present, last_alert_seen_at NULL -> alert_likely_not_created", () => {
    const f = makeFaculty({ scholar_user_id: "abc123", last_alert_seen_at: null });
    expect(bucketForFaculty(f)).toBe("alert_likely_not_created");
  });

  it("scholar_user_id present, last_alert_seen_at recent -> working", () => {
    const f = makeFaculty({ scholar_user_id: "abc123", last_alert_seen_at: "2026-07-01T00:00:00.000Z" });
    expect(bucketForFaculty(f)).toBe("working");
  });

  it("research_profile_url is ResearchGate -> not_google_scholar (a fact, not a task)", () => {
    const f = makeFaculty({ research_profile_url: "https://www.researchgate.net/profile/Kim_Gryglewicz" });
    expect(bucketForFaculty(f)).toBe("not_google_scholar");
  });

  it("research_profile_url is a bare DOI -> fix_directory_link", () => {
    const f = makeFaculty({ research_profile_url: "https://doi.org/10.1210/me.2012-1101" });
    expect(bucketForFaculty(f)).toBe("fix_directory_link");
  });

  it("no research_profile_url at all -> no_profile_at_all", () => {
    const f = makeFaculty({ research_profile_url: null });
    expect(bucketForFaculty(f)).toBe("no_profile_at_all");
  });
});

describe("emptyCanonicalUnits — surfaces a unit with zero roster members", () => {
  it("CARD has zero members while every other unit has at least one -> reports only CARD", () => {
    const faculty: Pick<Faculty, "unit">[] = [
      { unit: "School of Communication Sciences and Disorders" },
      { unit: "Department of Health Sciences" },
      { unit: "School of Kinesiology and Rehabilitation Sciences" },
      { unit: "School of Social Work" },
      { unit: null },
    ];

    expect(emptyCanonicalUnits(faculty)).toEqual(["Center for Autism and Related Disabilities"]);
  });

  it("every unit populated -> empty array", () => {
    const faculty: Pick<Faculty, "unit">[] = UNITS.map((unit) => ({ unit }));
    expect(emptyCanonicalUnits(faculty)).toEqual([]);
  });

  it("no faculty at all -> every unit reported", () => {
    expect(emptyCanonicalUnits([])).toEqual([...UNITS]);
  });
});
