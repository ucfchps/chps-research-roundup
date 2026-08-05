# Phase 5 surface inventory

Started ahead of Session 0 — this file will grow as Session 0 does its full
pass. For now it holds one entry that fell out of the pre-Session-0 fixture
work and shouldn't wait to be written down.

## Drift risk: suites tested against trimmed, not raw, fixtures

`tests/fixtures/orcid/sample-works.json` and
`tests/fixtures/pubmed/sample-summaries.json` are both explicitly **trimmed**
excerpts of real API pulls — each file's own `_note` field says so. That's a
deliberate earlier choice (readable test cases), but it means anything
tested directly against them is exercised against a shape a human already
cleaned up, not the real API's raw output — the exact failure class this
project has hit before (`buildAuthorInputs` silently dropping affiliation
data).

Checked which suites actually depend on the trimmed shape vs. which only
reference it loosely:

| Suite | Dependency | Risk |
|---|---|---|
| `tests/orcid.test.ts` | **Direct import** — `import sampleWorks from "./fixtures/orcid/sample-works.json"`, parsing logic (`getOrcidWorks`/`parseOrcidGroups`) tested straight against it | Real: this suite can stay green against a shape that doesn't occur in the wild |
| `tests/pubmed.test.ts` | **Direct import** — `import sampleSummaries from "./fixtures/pubmed/sample-summaries.json"` | Real, same shape as above |
| `tests/ingest-pubmed-orcid.test.ts` | **Indirect only** — uses its own small synthetic responses for the DB-integration surface; keeps one specific case (DOI `10.3390/jfmk11020200`) consistent with the trimmed fixtures by hand, not by importing them | Lower — synthetic data, deliberately cross-checked, not structurally coupled to the trimming |
| `tests/names.test.ts` | **Indirect only** — specific real-shaped cases (`"Stock MS"`, `"van Loon LJC"`, `"Ploutz-Snyder L"`) were copied in as literals, originally derived from the fixture | Lower — same reasoning |

Not a Phase 5 finding yet — no test has been shown to pass against a trimmed
shape and fail against the raw one. `tests/fixtures/api/orcid-works-bennett.json`
and `tests/fixtures/api/pubmed-esummary-norte.json` (both genuinely raw,
captured 2026-08-05) exist now specifically so a future session can run
`orcid.test.ts`'s and `pubmed.test.ts`'s parsing logic against real untrimmed
payloads and settle this one way or the other.
