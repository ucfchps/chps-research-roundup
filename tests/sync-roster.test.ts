import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { syncRoster } from "../scripts/sync-roster";
import type { WpPerson } from "../lib/wordpress";

const API_URL = "https://healthprofessions.ucf.edu/wp-json/wp/v2/person";
const CLASS_TAXONOMY_URL = "https://healthprofessions.ucf.edu/wp-json/wp/v2/class?per_page=100&_fields=id,name,slug";
const CLASS_TERMS = [
  { id: 10, name: "Faculty" },
  { id: 20, name: "Leadership" },
  { id: 467, name: "Staff" },
];

function person(overrides: Partial<WpPerson>): WpPerson {
  return {
    id: 0,
    slug: "",
    title: { rendered: "" },
    departments: [],
    class: [],
    acf: { profile_F_name: "", profile_L_name: "", email_address: "", google_scholar: "", orcid: "" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

// Dispatches on URL so call order (roster pagination vs. taxonomy lookup)
// never makes the test brittle.
function stubFetch(people: WpPerson[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(CLASS_TAXONOMY_URL)) return jsonResponse(CLASS_TERMS);
      if (url.startsWith(API_URL)) return jsonResponse(people, { "X-WP-TotalPages": "1" });
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
}

const ROVITO = person({
  id: 1163, slug: "michael-rovito", title: { rendered: "Michael J. Rovito" },
  departments: [232], class: [10],
  acf: {
    profile_F_name: "Michael J.", profile_L_name: "Rovito", email_address: "michael.rovito@ucf.edu",
    google_scholar: "https://scholar.google.com/citations?user=PhpZGb0AAAAJ&hl=en&oi=sra",
    orcid: "https://orcid.org/0000-0001-8086-3460",
  },
});

const EDDINS = person({
  id: 88001, slug: "ann-eddins", title: { rendered: "Ann Eddins" },
  departments: [166], class: [20], // Leadership-only — the §7 regression case
  acf: {
    profile_F_name: "Ann", profile_L_name: "Eddins", email_address: "",
    google_scholar: "https://scholar.google.com/citations?view_op=list_works&hl=en&user=mG0VWxkAAAAJ",
    orcid: "",
  },
});

// CARD, Staff-only, no research profile — must be excluded by the §7 filter.
const CARD_STAFF = person({
  id: 25163, slug: "fabiola-gomez", title: { rendered: "Fabiola Gomez" },
  departments: [439], class: [467],
  acf: { profile_F_name: "Fabiola", profile_L_name: "Gomez", email_address: "fabiola.gomez@ucf.edu", google_scholar: "", orcid: "" },
});

describe("syncRoster", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "sync-roster-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("inserts only roster-qualifying people (§7): Rovito and Eddins in, CARD Staff-only excluded", async () => {
    stubFetch([ROVITO, EDDINS, CARD_STAFF]);

    const summary = await syncRoster(client, API_URL);

    expect(summary.fetched).toBe(3);
    expect(summary.included).toBe(2);
    expect(summary.inserted).toBe(2);
    expect(summary.updated).toBe(0);
    expect(summary.deactivated).toBe(0);

    const rows = await client.execute("SELECT wp_id, display_name, unit FROM faculty ORDER BY wp_id");
    expect(rows.rows.map((r) => r.wp_id)).toEqual(["1163", "88001"]);

    const rovito = rows.rows.find((r) => r.wp_id === "1163")!;
    expect(rovito.display_name).toBe("Rovito, M.J.");
    expect(rovito.unit).toBe("Department of Health Sciences");
  });

  it("is idempotent: a second run with identical data inserts nothing new and deactivates nothing", async () => {
    stubFetch([ROVITO, EDDINS]);
    await syncRoster(client, API_URL);

    stubFetch([ROVITO, EDDINS]);
    const second = await syncRoster(client, API_URL);

    expect(second.inserted).toBe(0);
    expect(second.deactivated).toBe(0);

    const count = await client.execute("SELECT COUNT(*) as n FROM faculty");
    expect(count.rows[0].n).toBe(2);
  });

  it("deactivates (never deletes) someone who has vanished from the directory", async () => {
    stubFetch([ROVITO, EDDINS]);
    await syncRoster(client, API_URL);

    stubFetch([ROVITO]); // Eddins no longer present
    const second = await syncRoster(client, API_URL);

    expect(second.deactivated).toBe(1);

    const eddins = await client.execute("SELECT active FROM faculty WHERE wp_id = '88001'");
    expect(eddins.rows).toHaveLength(1); // row still exists — never deleted
    expect(eddins.rows[0].active).toBe(0);
  });

  it("reactivates someone who reappears in a later sync", async () => {
    stubFetch([ROVITO, EDDINS]);
    await syncRoster(client, API_URL);
    stubFetch([ROVITO]);
    await syncRoster(client, API_URL);

    stubFetch([ROVITO, EDDINS]); // Eddins is back
    await syncRoster(client, API_URL);

    const eddins = await client.execute("SELECT active FROM faculty WHERE wp_id = '88001'");
    expect(eddins.rows[0].active).toBe(1);
  });

  it("never touches last_alert_seen_at — only the Scholar ingester writes that (§5a.4)", async () => {
    stubFetch([ROVITO]);
    await syncRoster(client, API_URL);
    await client.execute({
      sql: "UPDATE faculty SET last_alert_seen_at = ? WHERE wp_id = '1163'",
      args: ["2026-06-15T00:00:00.000Z"],
    });

    stubFetch([ROVITO]);
    await syncRoster(client, API_URL);

    const row = await client.execute("SELECT last_alert_seen_at FROM faculty WHERE wp_id = '1163'");
    expect(row.rows[0].last_alert_seen_at).toBe("2026-06-15T00:00:00.000Z");
  });

  it("counts unit and citation-confidence gaps for human follow-up", async () => {
    const noUnit = person({
      id: 88002, slug: "andrea-velez", title: { rendered: "Andrea Velez" },
      departments: [71], class: [20],
      acf: { profile_F_name: "Andrea", profile_L_name: "Velez", email_address: "", google_scholar: "", orcid: "" },
    });
    const ambiguousUnit = person({
      id: 88004, slug: "dual-unit-person", title: { rendered: "Dual Unit" },
      departments: [232, 166], class: [10], // two DIFFERENT canonical units
      acf: { profile_F_name: "Dual", profile_L_name: "Unit", email_address: "", google_scholar: "", orcid: "" },
    });
    const lowConfidence = person({
      id: 1153, slug: "nicole-dawson", title: { rendered: "Nicole Dawson Loughran" },
      departments: [239], class: [10],
      acf: { profile_F_name: "Nicole Dawson", profile_L_name: "Loughran", email_address: "", google_scholar: "", orcid: "" },
    });
    const notScholar = person({
      id: 973, slug: "kimberley-gryglewicz", title: { rendered: "Kimberley Gryglewicz" },
      departments: [83], class: [10],
      acf: {
        profile_F_name: "Kimberley", profile_L_name: "Gryglewicz", email_address: "",
        google_scholar: "https://www.researchgate.net/profile/Kim_Gryglewicz", orcid: "",
      },
    });
    const badLink = person({
      id: 9763, slug: "steven-burroughs", title: { rendered: "Steven Burroughs" },
      departments: [232], class: [10],
      acf: {
        profile_F_name: "Steven", profile_L_name: "Burroughs", email_address: "",
        google_scholar: "https://doi.org/10.1210/me.2012-1101", orcid: "",
      },
    });

    stubFetch([noUnit, ambiguousUnit, lowConfidence, notScholar, badLink]);
    const summary = await syncRoster(client, API_URL);

    expect(summary.noCanonicalUnit).toBe(1);
    expect(summary.ambiguousUnit).toBe(1);
    expect(summary.lowConfidenceCitation).toBe(1);
    expect(summary.notGoogleScholar).toBe(1);
    expect(summary.unparseableProfile).toBe(1);
  });

  it("a scholar_user_id collision is caught, reported by name, and does not crash the run", async () => {
    const original = person({
      id: 1, slug: "original", title: { rendered: "Original Person" },
      departments: [232], class: [10],
      acf: {
        profile_F_name: "Original", profile_L_name: "Person", email_address: "",
        google_scholar: "https://scholar.google.com/citations?user=SHARED_ID_AAAAJ", orcid: "",
      },
    });
    const copyPaste = person({
      id: 2, slug: "copy-paste", title: { rendered: "Copy Paste" },
      departments: [232], class: [10],
      acf: {
        profile_F_name: "Copy", profile_L_name: "Paste", email_address: "",
        google_scholar: "https://scholar.google.com/citations?user=SHARED_ID_AAAAJ", orcid: "",
      },
    });

    stubFetch([original, copyPaste]);
    const summary = await syncRoster(client, API_URL);

    expect(summary.inserted).toBe(2); // both rows still get created
    expect(summary.scholarIdCollisions).toHaveLength(1);
    expect(summary.scholarIdCollisions[0]).toMatchObject({
      scholarUserId: "SHARED_ID_AAAAJ",
      keptWpId: "1",
      droppedWpId: "2",
    });

    const rows = await client.execute("SELECT wp_id, scholar_user_id FROM faculty ORDER BY wp_id");
    expect(rows.rows[0].scholar_user_id).toBe("SHARED_ID_AAAAJ");
    expect(rows.rows[1].scholar_user_id).toBeNull();
  });
});
