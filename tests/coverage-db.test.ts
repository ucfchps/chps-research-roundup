import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";
import { getAlertCoverage } from "../lib/coverage";

describe("getAlertCoverage — real SQL against a migrated temp DB", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "coverage-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  async function insertFaculty(row: {
    wp_id: string;
    display_name: string;
    unit: string | null;
    research_profile_url: string | null;
    scholar_user_id: string | null;
    last_alert_seen_at: string | null;
    active?: number;
  }) {
    await client.execute({
      sql: `INSERT INTO faculty (wp_id, display_name, unit, research_profile_url, scholar_user_id, last_alert_seen_at, active)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.wp_id, row.display_name, row.unit, row.research_profile_url,
        row.scholar_user_id, row.last_alert_seen_at, row.active ?? 1,
      ],
    });
  }

  it("classifies real rows into the correct buckets and only counts active faculty", async () => {
    await insertFaculty({
      wp_id: "1", display_name: "Stock, M.", unit: "School of Communication Sciences and Disorders",
      research_profile_url: "https://scholar.google.com/citations?user=hs_VC0kAAAAJ",
      scholar_user_id: "hs_VC0kAAAAJ", last_alert_seen_at: null,
    });
    await insertFaculty({
      wp_id: "2", display_name: "Rovito, M.J.", unit: "Department of Health Sciences",
      research_profile_url: "https://scholar.google.com/citations?user=PhpZGb0AAAAJ",
      scholar_user_id: "PhpZGb0AAAAJ", last_alert_seen_at: "2026-07-01T00:00:00.000Z",
    });
    await insertFaculty({
      wp_id: "3", display_name: "Gryglewicz, K.", unit: "School of Social Work",
      research_profile_url: "https://www.researchgate.net/profile/Kim_Gryglewicz",
      scholar_user_id: null, last_alert_seen_at: null,
    });
    await insertFaculty({
      wp_id: "4", display_name: "Burroughs, S.", unit: "Department of Health Sciences",
      research_profile_url: "https://doi.org/10.1210/me.2012-1101",
      scholar_user_id: null, last_alert_seen_at: null,
    });
    await insertFaculty({
      wp_id: "5", display_name: "Mazany, S.", unit: "School of Social Work",
      research_profile_url: null, scholar_user_id: null, last_alert_seen_at: null,
    });
    // Deactivated — must not appear in any bucket.
    await insertFaculty({
      wp_id: "6", display_name: "Gone, G.", unit: "School of Social Work",
      research_profile_url: null, scholar_user_id: null, last_alert_seen_at: null, active: 0,
    });

    const report = await getAlertCoverage(client);

    expect(report.alert_likely_not_created.map((f) => f.wp_id)).toEqual(["1"]);
    expect(report.working.map((f) => f.wp_id)).toEqual(["2"]);
    expect(report.not_google_scholar.map((f) => f.wp_id)).toEqual(["3"]);
    expect(report.fix_directory_link.map((f) => f.wp_id)).toEqual(["4"]);
    expect(report.no_profile_at_all.map((f) => f.wp_id)).toEqual(["5"]);
    // Only CSD, Health Sciences, and Social Work have rows above -> KRS and
    // CARD are reported empty.
    expect(report.emptyUnits).toEqual([
      "Center for Autism and Related Disabilities",
      "School of Kinesiology and Rehabilitation Sciences",
    ]);
  });
});
