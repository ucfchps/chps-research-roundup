// §13 item 10 diagnostic: which faculty does the full_name fix actually
// change PubMed query behavior for? Reuses the exact parsing logic
// scripts/ingest-pubmed-orcid.ts uses (buildPubmedAuthorQuery's two
// underlying functions), not a separate one-off count.
import { describe, expect, it } from "vitest";
import { auditFullnameCoverage } from "../scripts/audit-fullname-coverage";

describe("auditFullnameCoverage", () => {
  it("reports the confirmed real cases where full_name recovers a missing initial", () => {
    const rows = auditFullnameCoverage([
      { display_name: "Stock, M.", full_name: "Matt S. Stock" },
      { display_name: "Wells, A.", full_name: "Adam J. Wells" },
      { display_name: "Norte, G.", full_name: "Grant E. Norte" },
      { display_name: "Scheidell, J.", full_name: "Joy D. Scheidell" },
    ]);

    expect(rows.map((r) => r.displayName)).toEqual(["Stock, M.", "Wells, A.", "Norte, G.", "Scheidell, J."]);
    expect(rows[0]).toEqual({ displayName: "Stock, M.", fullName: "Matt S. Stock", oldQuery: "Stock M", newQuery: "Stock MS" });
  });

  it("correctly reports the compound-surname regression cases (surname anchored on display_name, not guessed from full_name shape)", () => {
    const rows = auditFullnameCoverage([
      { display_name: "Abarca Sasser, D.", full_name: "Diana Abarca Sasser" },
      { display_name: "Schwen Blackett, D.", full_name: "Deena Schwen Blackett" },
      { display_name: "Lopez Castillo, H.", full_name: "Humberto Lopez Castillo" },
    ]);

    // None of these actually change behavior — old and new both resolve to
    // the same, already-correct single-initial query once anchored on the
    // known surname (these people just never had a lost middle initial).
    expect(rows).toEqual([]);
  });

  it("does not report a faculty member whose display_name already has full initials (a different, unaffected Norte)", () => {
    const rows = auditFullnameCoverage([{ display_name: "Norte, S.", full_name: "Shari Norte" }]);
    expect(rows).toEqual([]);
  });

  it("skips a faculty member with no full_name at all", () => {
    const rows = auditFullnameCoverage([{ display_name: "Zraick, R.I.", full_name: null }]);
    expect(rows).toEqual([]);
  });

  it("skips a faculty member whose full_name doesn't parse (falls back silently here — the fallback warning is the ingest script's concern, not this audit's)", () => {
    const rows = auditFullnameCoverage([{ display_name: "Lee, E.M.", full_name: "Eunkyung “Muriel” Lee" }]);
    expect(rows).toEqual([]);
  });
});
