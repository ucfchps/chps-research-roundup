// Session 7: keeps Crossref-derived metadata from going stale or shipping
// permanently incomplete. See master plan §6b, §7 (mergeMetadata provenance),
// §8c Tab 4, §9, §15.1/§15.11. Mocks resolveByDoi (lib/crossref.ts, Session 6)
// — no real network calls. Runs against a real temp SQLite db (via
// runMigrations), same pattern as tests/coverage-db.test.ts, since the
// idempotency guarantees here are genuinely SQL (ON CONFLICT upserts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";

const resolveByDoiMock = vi.fn();
class MockCrossrefUnavailableError extends Error {}
vi.mock("../lib/crossref", () => ({
  resolveByDoi: (...args: unknown[]) => resolveByDoiMock(...args),
  CrossrefUnavailableError: MockCrossrefUnavailableError,
}));

const { refreshMetadata } = await import("../lib/refresh-metadata");
const { CrossrefUnavailableError } = await import("../lib/crossref");

interface SeedPublication {
  doi: string;
  title: string;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  roundup_id?: number | null;
}

async function seedPublication(client: Client, p: SeedPublication): Promise<number> {
  const now = new Date().toISOString();
  const result = await client.execute({
    sql: `INSERT INTO publications
            (doi, title, title_normalized, url, journal, year, volume, issue, pages,
             status, source, first_seen_at, date_added, roundup_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 'crossref', ?, ?, ?, ?)`,
    args: [
      p.doi,
      p.title,
      p.title.toLowerCase(),
      `https://doi.org/${p.doi}`,
      "Some Journal",
      2025,
      p.volume ?? null,
      p.issue ?? null,
      p.pages ?? null,
      now,
      now,
      p.roundup_id ?? null,
      now,
    ],
  });
  return Number(result.lastInsertRowid);
}

describe("refreshMetadata", () => {
  let dbDir: string;
  let client: Client;

  beforeEach(async () => {
    resolveByDoiMock.mockReset();
    dbDir = mkdtempSync(path.join(tmpdir(), "refresh-metadata-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("Problem A: fills null volume/issue/pages from a resolved ahead-of-print DOI (Stock fixture shape)", async () => {
    const doi = "10.1249/jes.0000000000000392";
    await seedPublication(client, { doi, title: "Limb Disuse Trials in Humans", volume: null, issue: null, pages: null });
    resolveByDoiMock.mockResolvedValue({
      doi,
      title: "Limb Disuse Trials in Humans",
      url: `https://doi.org/${doi}`,
      journal: "Exercise and Sport Sciences Reviews",
      year: 2026,
      volume: null,
      issue: null,
      pages: null,
      type: "journal-article",
      authors: [],
    });

    const result = await refreshMetadata(client);

    expect(result.checkedIncomplete).toBe(1);
    expect(result.updatedIncomplete).toBe(0); // resolved data is itself still null — nothing to fill
    expect(result.stillIncomplete).toEqual([{ id: expect.any(Number), title: "Limb Disuse Trials in Humans" }]);
  });

  it("Problem A: fills the gaps once Crossref actually has volume/issue/pages", async () => {
    const doi = "10.1002/lary.32469";
    await seedPublication(client, { doi, title: "Effects of Daily Electronic Cigarette Use", volume: null, issue: null, pages: null });
    resolveByDoiMock.mockResolvedValue({
      doi,
      title: "Effects of Daily Electronic Cigarette Use",
      url: `https://doi.org/${doi}`,
      journal: "The Laryngoscope",
      year: 2025,
      volume: "135",
      issue: "12",
      pages: "4830-4839",
      type: "journal-article",
      authors: [],
    });

    const result = await refreshMetadata(client);

    expect(result.updatedIncomplete).toBe(1);
    expect(result.stillIncomplete).toEqual([]);

    const row = await client.execute("SELECT volume, issue, pages FROM publications WHERE doi = ?", [doi]);
    expect(row.rows[0]).toMatchObject({ volume: "135", issue: "12", pages: "4830-4839" });
  });

  it("★ Problem B (Lee, case 5): a stored non-null pages value that differs from Crossref's current value is flagged, never overwritten", async () => {
    const doi = "10.1080/14659891.2025.2460803";
    const id = await seedPublication(client, {
      doi,
      title: "Racial and Ethnic Differences in How Mental Health...",
      volume: "31",
      issue: "1",
      pages: "1-9", // the live post's stale, provisional pagination
    });
    resolveByDoiMock.mockResolvedValue({
      doi,
      title: "Racial and Ethnic Differences in How Mental Health...",
      url: `https://doi.org/${doi}`,
      journal: "Journal of Substance Use",
      year: 2025,
      volume: "31",
      issue: "1",
      pages: "82-90", // Crossref's real, current pagination
      type: "journal-article",
      authors: [],
    });

    const result = await refreshMetadata(client);

    expect(result.flaggedMismatches).toEqual([{ id, title: "Racial and Ethnic Differences in How Mental Health..." }]);

    const row = await client.execute("SELECT volume, issue, pages FROM publications WHERE id = ?", [id]);
    expect(row.rows[0]).toMatchObject({ volume: "31", issue: "1", pages: "1-9" }); // unchanged

    const mismatch = await client.execute("SELECT * FROM metadata_mismatches WHERE publication_id = ?", [id]);
    expect(mismatch.rows).toHaveLength(1);
    expect(mismatch.rows[0]).toMatchObject({
      stored_pages: "1-9",
      crossref_pages: "82-90",
      stored_volume: "31",
      crossref_volume: "31",
    });
  });

  it("★ Problem B (Weerathunge, case 1): a stored issue value that differs from Crossref's current issue is flagged, never overwritten", async () => {
    const doi = "10.1044/2025_jslhr-24-00598";
    const id = await seedPublication(client, {
      doi,
      title: "Characterization of Vocal Motor Control Using Laryngeal Kinematics",
      volume: "68",
      issue: "8", // the live post's wrong issue number
      pages: "1743-1757",
    });
    resolveByDoiMock.mockResolvedValue({
      doi,
      title: "Characterization of Vocal Motor Control Using Laryngeal Kinematics",
      url: `https://doi.org/${doi}`,
      journal: "Journal of Speech, Language, and Hearing Research",
      year: 2025,
      volume: "68",
      issue: "4", // Crossref's real, current issue
      pages: "1743-1757",
      type: "journal-article",
      authors: [],
    });

    const result = await refreshMetadata(client);

    expect(result.flaggedMismatches).toEqual([
      { id, title: "Characterization of Vocal Motor Control Using Laryngeal Kinematics" },
    ]);

    const row = await client.execute("SELECT volume, issue, pages FROM publications WHERE id = ?", [id]);
    expect(row.rows[0]).toMatchObject({ volume: "68", issue: "8", pages: "1743-1757" }); // unchanged

    const mismatch = await client.execute("SELECT * FROM metadata_mismatches WHERE publication_id = ?", [id]);
    expect(mismatch.rows).toHaveLength(1);
    expect(mismatch.rows[0]).toMatchObject({
      stored_issue: "8",
      crossref_issue: "4",
      stored_volume: "68",
      crossref_volume: "68",
      stored_pages: "1743-1757",
      crossref_pages: "1743-1757",
    });
  });

  it("Problem B: a stored value that matches Crossref's current value is a clean no-op — no mismatch row, no update", async () => {
    const doi = "10.9999/matching-case";
    const id = await seedPublication(client, { doi, title: "A Perfectly Fine Citation", volume: "10", issue: "2", pages: "100-110" });
    resolveByDoiMock.mockResolvedValue({
      doi,
      title: "A Perfectly Fine Citation",
      url: `https://doi.org/${doi}`,
      journal: "Some Journal",
      year: 2025,
      volume: "10",
      issue: "2",
      pages: "100-110",
      type: "journal-article",
      authors: [],
    });

    const result = await refreshMetadata(client);

    expect(result.flaggedMismatches).toEqual([]);
    const mismatch = await client.execute("SELECT * FROM metadata_mismatches WHERE publication_id = ?", [id]);
    expect(mismatch.rows).toHaveLength(0);
  });

  it("a human-edited field survives the refresh even when Crossref disagrees with it", async () => {
    const doi = "10.9999/human-corrected";
    const id = await seedPublication(client, {
      doi,
      title: "Human-Corrected Citation",
      volume: "5",
      issue: "1",
      pages: "1-2", // a human fixed this via the review page (§8b)
    });
    resolveByDoiMock.mockResolvedValue({
      doi,
      title: "Human-Corrected Citation",
      url: `https://doi.org/${doi}`,
      journal: "Some Journal",
      year: 2025,
      volume: "5",
      issue: "1",
      pages: "999-999", // Crossref disagrees — must not win
      type: "journal-article",
      authors: [],
    });

    await refreshMetadata(client);

    const row = await client.execute("SELECT volume, issue, pages FROM publications WHERE id = ?", [id]);
    expect(row.rows[0]).toMatchObject({ volume: "5", issue: "1", pages: "1-2" });
  });

  it("a publication with roundup_id set is not selected by either query", async () => {
    // roundup_id references roundups(id) — insert the parent row first for the FK.
    await client.execute("INSERT INTO roundups (id, label, generated_at, pub_count, html) VALUES (1, 'Test Edition', ?, 1, '')", [
      new Date().toISOString(),
    ]);
    await seedPublication(client, {
      doi: "10.9999/already-published",
      title: "Already Published Somewhere",
      volume: null,
      pages: null,
      roundup_id: 1,
    });

    const result = await refreshMetadata(client);

    expect(result.checkedIncomplete).toBe(0);
    expect(result.checkedPopulated).toBe(0);
    expect(resolveByDoiMock).not.toHaveBeenCalled();
  });

  it("CrossrefUnavailableError on one record does not abort the run — the rest still process, and it's reported as errored", async () => {
    await seedPublication(client, { doi: "10.9999/will-error", title: "Will Error", volume: null, pages: null });
    const okDoi = "10.9999/will-succeed";
    await seedPublication(client, { doi: okDoi, title: "Will Succeed", volume: null, pages: null });

    resolveByDoiMock.mockImplementation(async (doi: string) => {
      if (doi === "10.9999/will-error") throw new CrossrefUnavailableError("simulated outage");
      return {
        doi: okDoi,
        title: "Will Succeed",
        url: `https://doi.org/${okDoi}`,
        journal: "Some Journal",
        year: 2025,
        volume: "1",
        issue: "1",
        pages: "1-10",
        type: "journal-article",
        authors: [],
      };
    });

    const result = await refreshMetadata(client);

    expect(result.errored).toEqual([{ id: expect.any(Number), title: "Will Error", error: "simulated outage" }]);
    expect(result.updatedIncomplete).toBe(1);
  });

  it("running twice changes nothing the second time, for both problems", async () => {
    const filledDoi = "10.9999/gets-filled";
    await seedPublication(client, { doi: filledDoi, title: "Gets Filled", volume: null, pages: null });
    const mismatchDoi = "10.9999/gets-flagged";
    await seedPublication(client, { doi: mismatchDoi, title: "Gets Flagged", volume: "1", issue: "1", pages: "1-9" });

    resolveByDoiMock.mockImplementation(async (doi: string) => {
      if (doi === filledDoi) {
        return { doi, title: "Gets Filled", url: `https://doi.org/${doi}`, journal: "J", year: 2025, volume: "9", issue: "9", pages: "9-99", type: "journal-article", authors: [] };
      }
      return { doi, title: "Gets Flagged", url: `https://doi.org/${doi}`, journal: "J", year: 2025, volume: "1", issue: "1", pages: "82-90", type: "journal-article", authors: [] };
    });

    const first = await refreshMetadata(client);
    expect(first.updatedIncomplete).toBe(1);
    expect(first.flaggedMismatches).toHaveLength(1);

    const second = await refreshMetadata(client);
    // the just-filled record now has non-null volume/pages, so it's checked
    // for staleness by query 2 the second time around — its freshly-filled
    // value matches what Crossref just returned, so it's a clean no-op.
    expect(second.updatedIncomplete).toBe(0);

    const mismatchRows = await client.execute("SELECT * FROM metadata_mismatches");
    expect(mismatchRows.rows).toHaveLength(1); // upserted, not duplicated

    const filledRow = await client.execute("SELECT volume, issue, pages FROM publications WHERE doi = ?", [filledDoi]);
    expect(filledRow.rows[0]).toMatchObject({ volume: "9", issue: "9", pages: "9-99" });
  });
});
