// ops-notes.md §5/§6 step 6: re-run the shared confirmation gate
// (buildAuthorInputs) against every existing role='chps_faculty',
// role_set_by='ingest' row, regardless of publications.source — the real
// blast-radius number, not an extrapolation from the one manually-found
// case (publication 96, "Zhu, Y."). Reuses buildAuthorInputs directly so
// this can't drift from what the ingesters actually do.
import { describe, expect, it } from "vitest";
import { checkRoleConfirmation, type RoleConfirmationInput } from "../scripts/sweep-role-confirmations";
import type { Faculty } from "../lib/types";

function faculty(overrides: Partial<Faculty>): Faculty {
  return {
    id: 1, wp_id: "1", slug: "x", display_name: "Zhu, Y.", full_name: "Yong Zhu", email: null,
    unit: "Department of Health Sciences", research_profile_url: null, scholar_user_id: null,
    orcid: null, classification: null, active: 1, last_alert_seen_at: null, last_synced_at: null,
    ...overrides,
  };
}

function input(overrides: Partial<RoleConfirmationInput> = {}): RoleConfirmationInput {
  return {
    publicationId: 96, title: "Testing circuit-level theories of consciousness in humans",
    doi: "10.1016/j.tics.2025.08.012", source: "crossref", facultyId: 1, facultyDisplayName: "Zhu, Y.",
    ...overrides,
  };
}

const NOW = "2026-07-21T00:00:00.000Z";

describe("checkRoleConfirmation", () => {
  it("no DOI at all -> 'no_doi' (no affiliation source can ever be checked)", async () => {
    const roster = [faculty({})];
    const result = await checkRoleConfirmation(input({ doi: null }), roster, async () => null, NOW);
    expect(result.outcome).toBe("no_doi");
  });

  it("DOI present but Crossref returns null (not found) -> 'doi_unresolvable'", async () => {
    const roster = [faculty({})];
    const result = await checkRoleConfirmation(input(), roster, async () => null, NOW);
    expect(result.outcome).toBe("doi_unresolvable");
  });

  it("DOI resolves, matched faculty's CURRENT affiliation confirms UCF -> 'still_confirmed'", async () => {
    const roster = [faculty({ id: 1, display_name: "Zraick, R.I." })];
    const resolveByDoi = async () => ({
      doi: "10.1/x", title: "T", url: "https://doi.org/10.1/x", journal: null, year: 2026, volume: null, issue: null, pages: null, type: "journal-article",
      authors: [{ name: "Zraick, R.I.", position: 0, affiliation: "University of Central Florida" }],
    });
    const result = await checkRoleConfirmation(input({ facultyDisplayName: "Zraick, R.I." }), roster, resolveByDoi, NOW);
    expect(result.outcome).toBe("still_confirmed");
  });

  it("DOI resolves, the matched faculty's CURRENT affiliation doesn't confirm UCF -> 'now_unconfirmed' (the real Zhu, Y. case)", async () => {
    const roster = [faculty({ id: 1, display_name: "Zhu, Y." })];
    const resolveByDoi = async () => ({
      doi: "10.1016/j.tics.2025.08.012", title: "Testing circuit-level theories of consciousness in humans", url: "https://doi.org/x", journal: null, year: 2026,
      volume: null, issue: null, pages: null, type: "journal-article",
      authors: [{ name: "Zhu, Y.", position: 0, affiliation: "Department of Ophthalmology, University of Pennsylvania" }],
    });
    const result = await checkRoleConfirmation(input(), roster, resolveByDoi, NOW);
    expect(result.outcome).toBe("now_unconfirmed");
    expect(result.roleSetBy).toBe("ingest:unconfirmed_name_match_conflicting_affiliation");
  });

  it("DOI resolves but the faculty member no longer appears in the current author list at all -> 'no_longer_matched'", async () => {
    const roster = [faculty({ id: 1, display_name: "Zhu, Y." })];
    const resolveByDoi = async () => ({
      doi: "10.1/x", title: "T", url: "https://doi.org/10.1/x", journal: null, year: 2026, volume: null, issue: null, pages: null, type: "journal-article",
      authors: [{ name: "Somebody Else, X.", position: 0 }],
    });
    const result = await checkRoleConfirmation(input(), roster, resolveByDoi, NOW);
    expect(result.outcome).toBe("no_longer_matched");
  });

  it("never throws when resolveByDoi itself throws (network failure) -> 'doi_unresolvable'", async () => {
    const roster = [faculty({})];
    const result = await checkRoleConfirmation(
      input(),
      roster,
      async () => {
        throw new Error("network down");
      },
      NOW
    );
    expect(result.outcome).toBe("doi_unresolvable");
  });
});
