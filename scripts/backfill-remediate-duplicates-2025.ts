// Session 21 (§13.24 operational backfill) — one-time remediation for the
// duplicate-author fallout from Task A's reconcile run. After the
// normalizeAuthorName whitespace fix (lib/matching.ts), a second reconcile
// pass still left 13 publications with more author rows than the fixture
// expects. Each case was hand-verified against production + the live post
// (see the Session 21 remediation plan) and falls into one of two shapes:
//
//   MERGE: production already had this person under a differently-formatted
//   name (compound surname split differently, diacritic variant, fuller/
//   sparser initials, a spelling variant). The fixture-derived row
//   ("manual:backfill-2025") is a duplicate of that same real person — delete
//   it, and copy its role (the only real information it carries) onto the
//   original, pre-existing row.
//
//   DELETE_ONLY: the fixture-derived row is a pure duplicate carrying no new
//   information (survivor already has the correct role/faculty_id) — just
//   remove it.
//
// Two of the thirteen publications (1695, 1696) turned out to be a
// different bug — Session 20 fixture parsing left in garbled multi-name
// strings ("R. L. & **Brevil, A.", "Cao" / "Y. & Ouimet, P.") — already
// fixed directly in ground-truth-2025.json; the corresponding production
// duplicate rows are remediated here the same way as any other MERGE.
//
// Two other apparent "excess" cases are NOT remediated here at all —
// Zhou, D.W. (pub 96) and Farrell, T.M. (pub 1398) are real co-authors
// present in production's Crossref/PubMed-sourced data but omitted from the
// live post's byline (confirmed via a direct fetch of the published post).
// Left untouched; documented as `expected_diffs` entries in the fixture.
//
// --dry-run is the DEFAULT (writes nothing) — pass --real to actually write.
// Idempotent: a second run finds the dup rows already gone and reports
// "already remediated" rather than erroring.
//
// Usage:
//   npx tsx scripts/backfill-remediate-duplicates-2025.ts             (dry run)
//   npx tsx scripts/backfill-remediate-duplicates-2025.ts --real      (writes)
import { config } from "dotenv";
import path from "node:path";
config({ path: path.join(__dirname, "..", ".env.local") });
import { createClient, type Client } from "@libsql/client";
import type { AuthorRole } from "../lib/types";

interface Action {
  pubId: number;
  survivorId: number;
  survivorName: string; // expected current name, sanity check only
  dupId: number;
  dupName: string; // expected current name, sanity check only
  newRole: AuthorRole;
  newFacultyId: number | null;
  deleteOnly?: boolean; // survivor already correct — just remove the dup
}

const ROLE_SET_BY = "manual:backfill-2025";

const ACTIONS: Action[] = [
  { pubId: 96, survivorId: 19755, survivorName: "Fernandez Pujol, C.", dupId: 19916, dupName: "Pujol, C.F.", newRole: "external", newFacultyId: null },
  { pubId: 129, survivorId: 19775, survivorName: "Çınar, B.", dupId: 19917, dupName: "Cinar, B.", newRole: "external", newFacultyId: null },
  { pubId: 1201, survivorId: 19793, survivorName: "Bandodkar, S.", dupId: 19920, dupName: "Bandokar S.", newRole: "undergrad_student", newFacultyId: null },
  { pubId: 1201, survivorId: 19795, survivorName: "Schwartz, A.", dupId: 19921, dupName: "Schwartz A.L.", newRole: "grad_student", newFacultyId: null },
  { pubId: 1201, survivorId: 19797, survivorName: "Norte, G.", dupId: 19922, dupName: "Norte, G. E.", newRole: "chps_faculty", newFacultyId: 41, deleteOnly: true },
  { pubId: 1203, survivorId: 19800, survivorName: "SHERMAN, D.A.", dupId: 19932, dupName: "Sherman, D.", newRole: "external", newFacultyId: null },
  { pubId: 1204, survivorId: 19803, survivorName: "Jacques, D.J.", dupId: 19925, dupName: "Jacques, D.", newRole: "grad_student", newFacultyId: null },
  { pubId: 1204, survivorId: 19805, survivorName: "Garcia, M.C.", dupId: 19926, dupName: "Garcia, M.", newRole: "external", newFacultyId: null },
  { pubId: 1204, survivorId: 19808, survivorName: "Batista, N.P.", dupId: 19927, dupName: "Batista, N.", newRole: "external", newFacultyId: null },
  { pubId: 1255, survivorId: 19820, survivorName: "Elliott, L.", dupId: 19919, dupName: "Elliott, L.C.", newRole: "external", newFacultyId: null },
  { pubId: 1402, survivorId: 19832, survivorName: "Oprea, E.M.", dupId: 19928, dupName: "Oprea, E.", newRole: "external", newFacultyId: null },
  { pubId: 1402, survivorId: 19833, survivorName: "Asencio, D.C.", dupId: 19929, dupName: "Asencio, D.", newRole: "external", newFacultyId: null },
  { pubId: 1402, survivorId: 19839, survivorName: "Bailey, M.", dupId: 19931, dupName: "Baily, M.", newRole: "external", newFacultyId: null },
  { pubId: 1464, survivorId: 19875, survivorName: "Colby Mangum, L.", dupId: 19923, dupName: "Mangum, L.C.", newRole: "chps_faculty", newFacultyId: 85 },
  { pubId: 1497, survivorId: 19882, survivorName: "Leme Gonçalves Panissa, V.", dupId: 19924, dupName: "Panissa, V. L. G.", newRole: "external", newFacultyId: null },
  { pubId: 1695, survivorId: 19892, survivorName: "Brevil, A.N.", dupId: 19935, dupName: "R. L. & **Brevil, A.", newRole: "grad_student", newFacultyId: null },
  { pubId: 1696, survivorId: 19896, survivorName: "Cao, Y.", dupId: 19933, dupName: "Cao", newRole: "external", newFacultyId: null },
  { pubId: 1696, survivorId: 19897, survivorName: "Ouimet, P.-P.A.", dupId: 19934, dupName: "Y. & Ouimet, P.", newRole: "external", newFacultyId: null },
  { pubId: 2061, survivorId: 19907, survivorName: "Guerra, R.S.", dupId: 19936, dupName: "Guerra, R.", newRole: "external", newFacultyId: null },
  { pubId: 2061, survivorId: 19911, survivorName: "Vasques, A.C.J.", dupId: 19937, dupName: "P.Vasques, A.C.J.", newRole: "external", newFacultyId: null },
];

interface Row {
  id: number;
  name: string;
  role: string;
  role_set_by: string | null;
  faculty_id: number | null;
}

async function fetchRow(client: Client, id: number): Promise<Row | null> {
  const result = await client.execute({ sql: "SELECT id, name, role, role_set_by, faculty_id FROM publication_authors WHERE id = ?", args: [id] });
  return (result.rows[0] as unknown as Row) ?? null;
}

async function main() {
  const real = process.argv.includes("--real");
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");
  const client = createClient({ url, authToken });

  let applied = 0;
  let alreadyDone = 0;
  let aborted = 0;

  for (const action of ACTIONS) {
    const survivor = await fetchRow(client, action.survivorId);
    const dup = await fetchRow(client, action.dupId);

    if (!survivor) {
      console.log(`✗ pub ${action.pubId}: survivor row ${action.survivorId} not found — ABORTING this action`);
      aborted++;
      continue;
    }
    if (!dup) {
      console.log(`~ pub ${action.pubId}: dup row ${action.dupId} already gone (survivor ${survivor.id} "${survivor.name}" = ${survivor.role}) — already remediated`);
      alreadyDone++;
      continue;
    }
    if (survivor.name !== action.survivorName || dup.name !== action.dupName) {
      console.log(
        `✗ pub ${action.pubId}: name mismatch, expected survivor="${action.survivorName}" dup="${action.dupName}", ` +
          `found survivor="${survivor.name}" dup="${dup.name}" — ABORTING this action`
      );
      aborted++;
      continue;
    }

    const willUpdateSurvivor = !action.deleteOnly;
    console.log(
      `${real ? "APPLYING" : "would apply"} pub ${action.pubId}: ` +
        (willUpdateSurvivor
          ? `update survivor ${survivor.id} "${survivor.name}" role ${survivor.role} -> ${action.newRole}` +
            (action.newFacultyId !== null ? ` (faculty_id -> ${action.newFacultyId})` : "") + "; "
          : `survivor ${survivor.id} "${survivor.name}" already correct; `) +
        `delete dup ${dup.id} "${dup.name}"`
    );

    if (real) {
      if (willUpdateSurvivor) {
        await client.execute({
          sql: "UPDATE publication_authors SET role = ?, faculty_id = ?, role_set_by = ?, role_set_at = ? WHERE id = ?",
          args: [action.newRole, action.newFacultyId, ROLE_SET_BY, new Date().toISOString(), action.survivorId],
        });
      }
      await client.execute({ sql: "DELETE FROM publication_authors WHERE id = ?", args: [action.dupId] });
    }
    applied++;
  }

  console.log("─".repeat(72));
  console.log(`${real ? "Applied" : "Would apply"}: ${applied}, already remediated: ${alreadyDone}, aborted: ${aborted}`);
  if (aborted > 0) process.exitCode = 1;
  if (!real) console.log("This was a dry run — nothing was written. Re-run with --real to apply.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
