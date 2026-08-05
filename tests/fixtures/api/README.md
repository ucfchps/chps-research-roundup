# Phase 5 hardening — fresh raw API captures

Captured 2026-08-05, real API responses, saved byte-for-byte as returned — no
`_note` wrapper, no trimming. This directory is additive: nothing in
`tests/fixtures/crossref/`, `orcid/`, `pubmed/`, or `scholar-alerts/` was
moved, consolidated, or overwritten; those remain load-bearing for their own
suites exactly as before.

Crossref requests used the polite pool (`User-Agent` with a `mailto:`).
PubMed E-utilities requests were spaced ≥1s apart, well under the 3 req/sec
ceiling.

| File | What it is | Verified edge case |
|---|---|---|
| `crossref-works-lopez-castillo-hiv-panama.json` | Real `/works/{doi}` for `10.3390/medsci14020200` | Compound surname — confirmed via `jq`: `family: "López Castillo"`, `given: "Humberto"` |
| `crossref-works-tarakci-vocal-capacity.json` | Real `/works/{doi}` for `10.1016/j.jvoice.2026.05.028` | Real Latin diacritics — confirmed via `jq`: `family: "Tarakçı"`, `given: "Göksu"` |
| `crossref-works-issn-antioxidants-position-stand.json` | Real `/works/{doi}` for `10.1080/15502783.2026.2629828` | Populated per-author affiliations — confirmed via `jq`: 18 authors, 19 non-empty `affiliation` entries total, each with institution name + place |
| `crossref-title-search-no-confident-match.json` | Real `query.bibliographic` title search for a genuine, currently-`needs_metadata` production record (`publications.id=41`, "Creatine for Healthy Aging: More Than Muscle" — a health-blog article, not an indexed academic paper) | Top result score 30.3, no title/author match — a real failed resolution, for Session 3E's "lands in `needs_metadata` without resetting `first_seen_at`" test |
| `pubmed-esearch-norte.json` + `pubmed-esummary-norte.json` | Real `esearch`/`esummary` pair for `Norte G[author]`, a real CHPS faculty surname — 20 of 34 total real hits | Untrimmed — whatever malformed/sparse fields PubMed actually returns for this surname are all still there |
| `orcid-works-bennett.json` | Real `/v3.0/{orcid}/works` pull for a real CHPS faculty ORCID (`0000-0003-3033-7184`) | Untrimmed real ORCID envelope (`group`/`last-modified-date`/`path`), unlike `tests/fixtures/orcid/sample-works.json` which its own header says was trimmed |

## A correction, found by verifying instead of assuming

The original ask was "capture a gray-lit title from the live post (the SSRN
or ResearchGate-only entry)." The live post
(`healthprofessions.ucf.edu/.../research-roundup-...-spring-and-summer-2025/`)
has exactly two such links:

- Slavych et al., *"Assessment of Online Resources and Education Materials
  Relating to Autism Spectrum Disorder"* (SSRN link)
- Wan et al., *"Characterizing Discourse Group Roles in Inquiry-based
  University Science Labs"* (ResearchGate link)

Both were live-tested against Crossref's title search before assuming either
was a genuine failure case. **Both resolve cleanly**, with clear top-score
winners and real DOIs (confirmed: the Slavych title exact-matches the first
item already in `tests/fixtures/crossref/03-slavych-online-resources-asd.json`;
the Wan title resolves to `10.1103/g4gf-w1yd` at score 51.4). The live post
linking to SSRN/ResearchGate instead of the DOI was a post-authoring choice,
not evidence either paper is a Crossref coverage gap — neither is a valid
`needs_metadata` example. Substituted a real, currently-`needs_metadata`
production record instead (see table above), verified failing before saving.
