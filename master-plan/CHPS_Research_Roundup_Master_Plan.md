# CHPS Research Roundup — Master Plan

**Status:** Source of truth. Read this before writing any code.
**Owner:** Web Developer, UCF College of Health Professions and Sciences (CHPS)
**Last updated:** July 2026 — amended post-WordPress-verification (ahead of Session 4),
again post-Crossref-recon (ahead of Session 6), again after confirming two live Crossref
fixture pulls, and a final time after confirming all ten fixture cases against the live
reference post. See §5a.3, §6, §6a, §9, §11 for the WordPress-verification changes; §5
(Layer 2), §8c Tab 4, §9, §12 for the first round of Crossref additions (`CROSSREF_MAILTO`,
affiliation-as-tiebreaker, the `refresh-metadata` job); §5 (Layer 2) again for the
preprint-supersession finding; and §9, §8c Tab 4, §15.8 for the final round — widening
`refresh-metadata`'s detection to catch non-null pagination mismatches (flag only, never
overwrite) and clarifying that a title-drifted query correctly landing in `needs_metadata`
is accepted behavior, not a bug to engineer around. Sessions 1–3 are unaffected; a
corrective migration (Session 3.5) brings the already-applied schema in line with the
WordPress-verification amendments.

---

## 1. What this is

A system that automatically collects CHPS faculty peer-reviewed publications, stores them in a database, lets faculty verify and self-submit missing entries, and lets the COMMS team generate a semester "Research Roundup" post as ready-to-paste HTML.

**The problem it replaces:** The Research Roundup post is currently assembled by hand. Someone chases down publications across many sources, manually formats every citation, manually groups them by unit, and manually applies bold/asterisk conventions. It takes weeks and it is error-prone. (Evidence of the manual process: several citations on the live post link through `nam02.safelinks.protection.outlook.com` redirects — an artifact of citations being copy-pasted out of forwarded Outlook emails.)

**Reference output — the thing we are automating:**
`https://healthprofessions.ucf.edu/news/research-roundup-publications-by-chps-faculty-spring-and-summer-2025/`

**Scope note:** Social media posting and image/graphic generation are explicitly **out of scope** for v1. Do not build Canva, Slides, or LinkedIn integrations. The deliverable is HTML for a WordPress post.

---

## 2. Success criteria

The project is a success when:

1. A COMMS staffer can open the admin page, set a **cutoff date**, click one button, and get correctly-formatted HTML for the roundup post. *(Note: a cutoff, not a date range — see §6b for why a start date is the wrong control.)*
2. That HTML requires only light human review — not reconstruction.
3. **No publication is ever posted in two roundups.** This is guaranteed structurally (§6b), not by a human remembering.
4. **A paper co-authored across units appears in each of those units' sections**, with consistent author formatting in every one (§6a).
5. **Student co-authors get their asterisks.** Faculty are asked — via a personal review link (§8b) — the one question only they can answer, and the system reports how many publications still have unreviewed co-authors before anything is published.
6. Faculty can find their own publications, correct wrong attributions, and submit anything the automation missed.
7. Everything runs on free tiers at current volume.
8. Every AI call is logged with token counts so future paid-provider cost can be projected from real data rather than guesses.

---

## 3. Core architecture

Four moving parts:

```
        ┌─────────────────────────────────────────────────────┐
        │  INGESTION  (GitHub Actions on cron — NOT Vercel)    │
        │  Layer 1: Scholar alerts via Gmail  → DISCOVERY      │
        │  Layer 2: Crossref                  → RESOLUTION     │
        │  Layer 3: PubMed / ORCID            → ENRICHMENT     │
        └────────────────────────┬────────────────────────────┘
                                 │  normalize → match → merge
                                 │  (never duplicate — §7)
                                 ▼
        ┌─────────────────────────────────────────────────────┐
        │  TURSO (libSQL)                                      │
        │  faculty · publications · publication_authors        │
        │  pending_submissions · review_requests               │
        │  roundups · usage_log                                │
        │                                                      │
        │  NOTE: no `unit` column on publications. Units are    │
        │  DERIVED from author→faculty links, and MULTI-VALUED. │
        └───┬──────────────────┬───────────────────┬───────────┘
            │                  │                   │
            ▼                  ▼                   ▼
  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────────┐
  │ PUBLIC PORTAL    │ │ REVIEW PAGE      │ │ COMMS ADMIN          │
  │ (§8a, no login)  │ │ (§8b, tokenized) │ │ (§8c, login req'd)   │
  │                  │ │ /review/{slug}/  │ │                      │
  │ · search by name │ │        {token}   │ │ · review campaigns   │
  │ · search by title│ │                  │ │ · pending queue      │
  │ · submit missing │ │ · tag co-author  │ │ · needs_metadata     │
  │                  │ │   roles  ★       │ │ · unlinked authors   │
  │                  │ │ · "not my paper" │ │ · generator → HTML   │
  │                  │ │ · fix citations  │ │ · roundup archive    │
  │                  │ │ · add missing    │ │                      │
  └──────────────────┘ └────────▲─────────┘ └──────────┬───────────┘
                                │                      │
                                │   personalized link  │  mints tokens;
                                └──────────────────────┘  sends email via
                                                          Gmail API (send scope)
```

**The one-sentence version:** Scholar tells us a paper *exists*; Crossref tells us what it *is*; the faculty member tells us who the *students* were; COMMS presses publish.

---

## 4. Tech stack

| Concern | Tool | Why |
|---|---|---|
| Database | **Turso** (libSQL/SQLite) | Already in use on other CHPS apps. Real SQL = indexed search on name/title, proper relational author records. |
| Hosting / portal / API | **Vercel** (Next.js App Router) | Already in use on other CHPS apps. |
| Scheduling | **GitHub Actions** (cron) | Already used by the Faculty News Mentions app. **Do not use Vercel Cron** — the free Hobby plan caps cron at once per day with ±1hr imprecision. |
| AI (parsing, fuzzy matching) | **Groq — `openai/gpt-oss-120b`** | Free tier, no card. OpenAI-compatible endpoint. |
| Faculty roster source | **WordPress REST API** (CHPS directory) | Already available. ACF fields (including the research-profile URL and, as of July 2026, a dedicated `orcid` field) are already exposed via `show_in_rest` — verified directly against the live endpoint. ★ **The field named `google_scholar` is not Scholar-specific** — it is a generic research-profile URL field. See amended §5a.3. |
| Email source (read) | **Gmail API + stored OAuth refresh token** | Reads the Scholar alert emails. |
| Email sending | **Gmail API (same credentials, send scope)** | ★ Required by the review-link emails (§8b). **Deliberately not a new platform** — the same Google Workspace account that receives Scholar alerts also sends the review invitations. Google Workspace allows ~2,000 sends/day, far above the ~100 faculty in a review cycle. Requires adding `gmail.send` to the OAuth scopes alongside `gmail.readonly`. If deliverability or reply-handling ever becomes an issue, a transactional provider (Resend, Postmark) is a drop-in replacement — but do not add one preemptively. |
| Bibliographic APIs | Crossref, PubMed E-utilities, ORCID | All free, no key required. |

### Cost posture
Everything above is free at CHPS volume (dozens of publications per semester, not thousands). **Groq is explicitly a short-term choice** — the plan is to migrate to a paid AI provider later. See §10 (AI Abstraction Layer) — this is a hard requirement, not a nice-to-have.

---

## 5. The three ingestion layers (and why all three exist)

A single source does not close the gap. This was verified by auditing the actual `href` values on the live Spring/Summer 2025 roundup post. The links resolve to a wide spread: PubMed/PMC, bare `doi.org` resolvers, and a dozen-plus publisher domains (ScienceDirect, Wiley, Taylor & Francis, Springer, SAGE, MDPI, Frontiers, IEEE Xplore, ASHA, LWW, BioMed Central, Human Kinetics, Ovid) — **plus** a tail of gray literature: an SSRN preprint, a ResearchGate-only posting, an ERIC record, and a professional-society position-statement PDF.

**Critical insight:** Link domain ≠ index coverage. Most publisher-hosted health-sciences work *is* in PubMed regardless of which URL the citation happens to use. The real gap is the gray-literature tail, concentrated in **School of Social Work** and parts of **Health Sciences / Kinesiology** — content that is outside PubMed's subject scope and sometimes has no registered DOI at all.

Therefore:

### Layer 1 — Google Scholar alerts (via Gmail) — THE DISCOVERY TRIGGER
- Scholar has **no API**, and scraping it is against ToS and breaks constantly. Do not attempt to scrape Scholar.
- Instead: a Google Scholar **alert** is created per faculty member, delivering to a monitored Google Workspace inbox. When a new publication appears on that person's Scholar profile, Google emails us.
- The GitHub Action reads those emails via the **Gmail API using a stored OAuth refresh token**.
- **This is the only layer that can catch gray literature** (ResearchGate-only postings, SSRN preprints, society PDFs), because Scholar crawls the open web rather than a curated, DOI-gated index. It is not a backstop. It is essential.

> ### ⚠️ CRITICAL: Scholar alerts are a DISCOVERY signal, not a metadata source.
> The alert email **does not contain a usable citation**. It gives a clean title, a year, and the identity of the faculty member — and everything else is truncated or malformed (see §5a). It cannot produce a roundup citation on its own.
>
> **The correct flow is: Scholar discovers → Crossref resolves.**
> Scholar tells us *"the faculty member with Scholar ID `X` has a new paper titled `Y`."* We then perform a **Crossref title search** to obtain the DOI, the complete author list, the full journal name, volume, issue, and pages. Only then do we have a citation.

- **Known limitation to design around:** Scholar alerts fire per-author. When multiple CHPS faculty co-author the same paper, we receive multiple separate alerts for the same publication. See §7 (Dedup & Merge).

### Layer 2 — Crossref — THE UNIVERSAL BACKBONE
- Free, keyless, discipline-agnostic. Anything with a registered DOI appears here regardless of field.
- This covers the large "publisher sites" bucket (SAGE, T&F, MDPI, Springer, IEEE, physiology journals, etc.) without needing biomedical subject indexing.
- Query by author name + affiliation, and/or resolve DOIs discovered by other layers into clean, complete citation metadata.
- **Crossref is the preferred source of truth for citation metadata** (journal, volume, issue, pages, year) whenever a DOI is available, because it is structured and reliable. Prefer Crossref metadata over Scholar-parsed metadata when both exist for the same paper.

> **★ Affiliation is a tiebreaker, never a requirement.** Crossref records frequently carry an `affiliation` on each author (e.g. `"University of Central Florida, Orlando, FL, USA"`). Where present, a UCF affiliation is useful corroboration when two title-search candidates otherwise clear the resolver's acceptance gate (§5a rule 7) — it is the cheapest available defense against a common-surname false positive (§8b). **But it is inconsistently populated: many legitimate Crossref records carry an empty `affiliation` array.** Use it to break ties between candidates that both already pass the title/year/surname gate. **Never require it, and never reject a candidate for lacking it** — doing so would silently drop real papers whose publisher didn't submit affiliation data.

> **★ A preprint must never shadow its own published version.** Crossref indexes preprints (`type: posted-content` — SSRN, arXiv, etc.) as fully separate records from the eventual peer-reviewed publication. A preprint's title is normally the exact wording originally submitted, while the published version's title is often edited by the journal during peer review — so the preprint frequently scores **higher** in a Crossref title search than the actual journal article, and can clear the resolver's exact-normalized-title gate when the edited, published title cannot. Left unhandled, the resolver silently accepts a preprint DOI (no journal name, no volume/issue/pages, `type: posted-content`) while the real, fully-populated journal-article record sits one slot lower in the exact same API response.
> Verified against a live case: a Slavych et al. paper on the reference roundup post is cited as appearing in *Health Education Journal*. Crossref's top-ranked hit for that title is the SSRN preprint (`10.2139/ssrn.4930891`, exact title match, no journal). The second-ranked hit is the actual *Health Education Journal* article (`10.1177/00178969251328913`, full volume/issue/pages) — but its Crossref title was edited during review, so it fails the exact-match gate that the preprint passes.
> **The fix:** before finalizing on any `posted-content` candidate, scan the *full* candidate list returned by the search — not just the ones that already cleared the exact-title gate — for a candidate whose author surnames match, in the same order, regardless of whether its title clears the exact-match threshold. If one exists, prefer that non-preprint candidate's metadata over the preprint. Only accept the preprint if no such candidate appears among the returned results.

### Layer 3 — PubMed / ORCID — ENRICHMENT
- **PubMed (NCBI E-utilities):** free, no key. Strong for the clinical/health-sciences half of the college. Use for enrichment (abstracts, MeSH terms) and as a coverage cross-check — **not** as the primary gate.
- **ORCID public API:** if a faculty member has an ORCID iD, it yields a verified, authoritative works list. Highest-quality signal available, but only for faculty who have one. Encourage adoption; don't depend on it.

### Layer priority when the same paper appears in multiple layers
1. **ORCID** (author-verified) — highest trust
2. **Crossref** (structured, DOI-anchored) — best metadata
3. **PubMed** — good metadata, biomedical only
4. **Scholar** — **discovery only**; never trust its metadata if any other source has the paper

Merge, don't duplicate. Use the best available metadata per field.

---

## 5a. Scholar alert email — anatomy and parsing spec

A real alert email, transcribed:

```
Subject:  Matt S. Stock - new articles
From:     Google Scholar Alerts <scholaralerts-noreply@google.com>
To:       contact+scholar@…

  [LINK] Limb Disuse Trials in Humans: Key Insights on Study Design,
         Ethics, and Project Execution
  MS Stock, KK Harmon, JW Andrushko, JP Farthing… - Exercise and Sport …, 2026
  This review provides guidance for designing and conducting safe, rigorous limb
  disuse studies, highlighting ethical considerations, challenges, and future …

  ─────────────────────────────────────────────
  This message was sent by Google Scholar because you're following new articles
  written by [Matt S. Stock](https://scholar.google.com/citations?hl=en&user=hs_VC0kAAAAJ).
                                                                        ▲
                                                    THE JOIN KEY ───────┘
  CANCEL ALERT
```

### What we can and cannot extract

| Field | Available? | Notes |
|---|---|---|
| **Faculty identity** | ✅ **Rock solid** | The footer link on the name contains the **Scholar user ID** (`…citations?hl=en&user=hs_VC0kAAAAJ`). Unique, stable, and it matches the Scholar URL on the WordPress directory profile. **This is the join key** — see rule 3. |
| **Title** | ✅ Reliable | The linked heading. The one clean citation field. |
| **Year** | ✅ Reliable | End of the green byline. |
| **Authors** | ❌ **TRUNCATED** | `MS Stock, KK Harmon, JW Andrushko, JP Farthing…` — ends in an ellipsis. Also initials-first (`MS Stock`), not citation form (`Stock, M.S.`). **Unusable for role tagging** — the hidden authors may include CHPS faculty or students. |
| **Journal** | ❌ **TRUNCATED** | `Exercise and Sport …` |
| **Volume / issue / pages** | ❌ Absent | |
| **DOI** | ❌ Absent | Link is a Scholar redirect, not a DOI. |
| **Snippet** | ✅ Present | Abstract fragment. Not used in the roundup; may aid fuzzy matching. |

### Parsing rules

1. **Gmail query (proven in production).** Use exactly:
   ```
   from:scholaralerts-noreply@google.com subject:"new articles"
   ```
   This is the query already validated in the previous Zapier implementation. Store as `GMAIL_ALERT_QUERY`.

2. **The query is what excludes citation alerts.** Google Scholar sends several alert types. Author-follow alerts (what we want) have subject `{Name} - new articles`. **Citation alerts** — papers written by *other people* that merely cite our faculty — have subject `{Name} - new citations`. Ingesting those would inject non-CHPS publications into the roundup.
   The `subject:"new articles"` filter excludes them at the Gmail level, before any code runs. **As a secondary assertion**, the parser should still verify the footer contains `written by`; if it doesn't, skip the email and log it for human review rather than ingesting it. Fail closed on anything unexpected.

3. **★ Map the alert to a faculty member by SCHOLAR USER ID — not by name.**

   The footer contains a link on the faculty member's name:
   ```
   This message was sent by Google Scholar because you're following new articles
   written by <a href="https://scholar.google.com/citations?hl=en&user=hs_VC0kAAAAJ">Matt S. Stock</a>.
   ```

   That `user` parameter — `hs_VC0kAAAAJ` — is a **unique, stable, machine-readable identifier** for the Scholar profile. The same ID appears in the `research_profile_url` on the faculty member's WordPress directory profile — **when that profile happens to be a Google Scholar profile.** **This is the join key.** Match `alert.scholar_user_id` → `faculty.scholar_user_id`. Exact, unambiguous, no name matching anywhere.

   > ### ⚠️ The directory field is NOT Scholar-specific — it is a generic research-profile field
   > Verified against the live directory: the ACF field faculty populate (`google_scholar`) accepts **any** research-profile URL. Of the populated records, most are Google Scholar, but a real minority are ResearchGate profiles, an NCBI/MyNCBI public bibliography, and — in one case — a bare DOI entered by mistake. **A hostname guard is therefore required, not optional:**
   > ```ts
   > function scholarUserId(url: string | null): string | null {
   >   if (!url) return null;
   >   try {
   >     const u = new URL(url.trim());
   >     if (u.hostname !== 'scholar.google.com') return null;   // ★ the field is generic — see above
   >     return u.searchParams.get('user');
   >   } catch { return null; }
   > }
   > ```
   > Without the hostname check, a ResearchGate or NCBI URL happens to return `null` anyway (no `user` param) — but that is accidental correctness, not a guarantee, and the `doi.org` entry could in principle collide. Check the host explicitly.
   >
   > **Consequence for the data model (§6):** the column is `research_profile_url`, not `scholar_url` — the old name implies a guarantee the field does not make. `scholar_user_id` is nullable and populated **only** when the profile is actually a Google Scholar URL. Faculty whose profile is ResearchGate/NCBI/other are **legitimately and permanently outside Layer 1** — see the amended §11 coverage table, which gives this its own bucket rather than treating it as an unfinished to-do.

   **Normalization is required on both sides.** Do not compare full URL strings — directory-entered URLs vary (`hl=en` present or absent, `&view_op=list_works` appended, `http` vs `https`, trailing `&`, mobile `citations?user=` forms). Verified against the live directory: every real Scholar URL currently on file parses cleanly under the function above — no malformed entries were found in practice — but the parser must still fail closed (return `null`, never throw) since a bad entry could appear at any time.

   **Treat the ID as case-sensitive** — Scholar IDs mix case meaningfully and use both `_` and `-` (`hs_VC0kAAAAJ`, `l_2K_NgAAAAJ`, `W-E8_LwAAAAJ`). Never lowercase, never strip to alphanumerics.

   **If the alert's Scholar ID matches no faculty row:** the alert belongs to someone outside the roster (a departed faculty member, or a non-CHPS collaborator someone followed). **Skip it and surface it for human review. Never ingest a publication for an unknown author.**

   *(The subject line still carries the display name — `{Name} - new articles` — but use it only for human-readable logging, never as the join key.)*

4. **Record the sighting.** On a successful ID match, set `faculty.last_alert_seen_at = now`. This is what makes alert-coverage detection automatic (§11) — no human has to tick a box saying "alert created."

5. **One email may contain multiple articles.** Iterate over every result block; do not assume one article per email.

6. **Extract only:** `scholar_user_id` (footer link), `title`, `year`, `scholar_url` (article link), `snippet`. **Do not attempt to parse the author list or journal from the alert** — they are truncated and will produce wrong citations.

7. **Then resolve via Crossref.** Query Crossref by title (+ year, + the known faculty surname as a signal) to retrieve DOI, complete author list, full journal title, volume, issue, pages. Take the citation metadata from Crossref, not from the alert.

8. **If Crossref resolution fails** (likely gray literature — SSRN, ResearchGate-only, society PDFs, ERIC records, some education journals):
   - Insert the publication with `status = 'needs_metadata'`.
   - It must **not** flow into a generated roundup in that state.
   - Surface it in the COMMS admin as an incomplete record for manual completion (a human fills in the author list, journal, and pages).
   - This is expected and acceptable — these are the papers PubMed and Crossref structurally cannot reach, and having a flagged stub is far better than missing the paper entirely or publishing a citation with half its authors.

9. **Mark processed.** Apply a Gmail label (or mark read) so re-runs don't reprocess the same email. Jobs must be idempotent regardless (§9).

---

## 6. Data model (Turso / SQLite)

```sql
-- Faculty roster. Synced from the WordPress directory.
CREATE TABLE faculty (
  id                   INTEGER PRIMARY KEY,
  wp_id                TEXT UNIQUE,       -- WordPress post ID for this profile
  slug                 TEXT,              -- WP slug ("matt-stock") — cosmetic part of
                                          -- /review/{slug}/{token} (§8b). NOT a credential.
  display_name         TEXT NOT NULL,     -- "Zraick, R.I."  (citation form)
  full_name            TEXT,              -- "Richard I. Zraick"
  email                TEXT,              -- ★ required by §8b review emails. (Omitted from
                                          -- an earlier draft of this plan; §8b cannot function
                                          -- without it.)
  unit                 TEXT,              -- ★ NULLABLE. See UNITS below and §6a. A person may
                                          -- map to zero canonical units (e.g. Dean's Office-only
                                          -- staff) — that is a real state to report, not an
                                          -- error to paper over with a guessed default (§15.11).
  research_profile_url TEXT,              -- ★ RENAMED from scholar_url. The WordPress ACF field
                                          -- (`google_scholar`) is GENERIC — verified against the
                                          -- live directory to also hold ResearchGate profiles,
                                          -- an NCBI bibliography, and (once) a bare DOI entered
                                          -- in error. Do not assume this is a Scholar URL. See
                                          -- §5a.3.
  scholar_user_id      TEXT UNIQUE,       -- ★ THE JOIN KEY. Parsed from research_profile_url,
                                          -- and NULL unless that URL's host is
                                          -- scholar.google.com. e.g. "hs_VC0kAAAAJ" from
                                          -- scholar.google.com/citations?hl=en&user=hs_VC0kAAAAJ
                                          -- Case-sensitive. See §5a.3 for normalization + the
                                          -- required hostname guard.
  orcid                TEXT,              -- bare ORCID iD (e.g. "0000-0002-1825-0097"), parsed
                                          -- from the directory's `orcid` ACF field, which stores
                                          -- a full https://orcid.org/{id} URL. Extract the path
                                          -- segment; do not store the URL. The final character
                                          -- of a real ORCID iD can be the checksum digit "X" —
                                          -- a parser that assumes four trailing digits will
                                          -- silently drop those people.
  classification       TEXT,              -- e.g. "Faculty", "Faculty|Leadership", "Leadership",
                                          -- "Leadership|Staff" — pipe-separated, multi-valued.
                                          -- Metadata only. NEVER used alone to decide roster
                                          -- membership — see the amended §9 roster-inclusion rule.
  active                INTEGER DEFAULT 1, -- still employed / still in directory
  last_alert_seen_at    TEXT,              -- last time an alert arrived for this scholar_user_id.
                                          -- NULL + scholar_user_id present ⇒ alert likely not
                                          -- created yet. Drives the to-do list in §11.
  last_synced_at        TEXT
);
-- REMOVED: researchgate_url. It has no independent source — ResearchGate links live inside
-- research_profile_url, the same generic field as Scholar links. See §5a.3.

-- One row per unique publication.
CREATE TABLE publications (
  id                INTEGER PRIMARY KEY,
  doi               TEXT UNIQUE,          -- nullable! gray lit may have none
  title             TEXT NOT NULL,
  title_normalized  TEXT NOT NULL,        -- lowercase, punctuation stripped — for matching
  url               TEXT NOT NULL,
  journal           TEXT,
  year              INTEGER,
  volume            TEXT,
  issue             TEXT,
  pages             TEXT,
  -- NOTE: there is deliberately NO `unit` column. A publication's unit(s) are DERIVED
  -- from the units of its CHPS faculty authors, and a publication can belong to
  -- MORE THAN ONE unit. See §6a.
  status            TEXT NOT NULL,        -- 'pending_merge' | 'needs_metadata' | 'published' | 'rejected'
                                          -- 'needs_metadata' = discovered via Scholar but Crossref
                                          -- resolution failed (gray lit). Incomplete citation.
                                          -- MUST NOT appear in a generated roundup. See §5a.8.
  source            TEXT NOT NULL,        -- 'scholar' | 'crossref' | 'pubmed' | 'orcid' | 'manual'
  first_seen_at     TEXT NOT NULL,        -- when we first detected it (drives the merge buffer)
  date_added        TEXT NOT NULL,        -- ★ "the day we collected this." Drives edition
                                          -- eligibility (§6b). DEFINED AS:
                                          --   · ingested  → date(first_seen_at)
                                          --   · faculty submission → date approved by COMMS
                                          --   · backfill  → publish date of the roundup post
                                          --                 it came from
                                          -- It is NOT the publication date. A 2024 paper found
                                          -- in 2025 has date_added in 2025 — that is correct
                                          -- and intended (§6b).
                                          -- NEVER back-date this to the publication year.
  released_at       TEXT,                 -- when it left the merge buffer
  roundup_id        INTEGER REFERENCES roundups(id),  -- ★ which roundup edition published this.
                                          -- NULL = not yet published in any roundup = eligible.
                                          -- NON-NULL = already went out. NEVER include again. §6b.
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_pub_title_norm ON publications(title_normalized);
CREATE INDEX idx_pub_date_added ON publications(date_added);
CREATE INDEX idx_pub_status ON publications(status);
CREATE INDEX idx_pub_roundup ON publications(roundup_id);

-- Authors on a publication, IN CITATION ORDER. Author order is significant.
CREATE TABLE publication_authors (
  id             INTEGER PRIMARY KEY,
  publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  faculty_id     INTEGER REFERENCES faculty(id),   -- NULL if not matched to a CHPS faculty row
  name           TEXT NOT NULL,                    -- "Awan, S.N."
  role           TEXT NOT NULL DEFAULT 'unknown',  -- see ROLES. Ingest sets ONLY
                                                   -- 'chps_faculty' or 'unknown'.
  role_set_by    TEXT,                             -- who confirmed the role: 'ingest' |
                                                   -- 'faculty:{faculty_id}' | 'comms:{user}'
  role_set_at    TEXT,
  position       INTEGER NOT NULL,                 -- 0-indexed author order
  UNIQUE(publication_id, position)
);
CREATE INDEX idx_pa_role ON publication_authors(role);   -- for counting 'unknown'

-- Self-submissions awaiting COMMS review.
CREATE TABLE pending_submissions (
  id              INTEGER PRIMARY KEY,
  faculty_id      INTEGER REFERENCES faculty(id),  -- ★ NOT NULL when submitted via the review
                                                   -- page (§8b) — we know exactly who they are.
                                                   -- NULL only for anonymous public-portal (§8a)
                                                   -- submissions. A known submitter should be
                                                   -- auto-linked as a chps_faculty author on
                                                   -- approval; an anonymous one must be matched
                                                   -- to the roster by the reviewer.
  submitted_via   TEXT NOT NULL,        -- 'review_page' | 'public_portal'
  submitted_by    TEXT NOT NULL,        -- name as entered
  payload         TEXT NOT NULL,        -- JSON blob of the full proposed publication + authors
  note            TEXT,                 -- optional free-text note to COMMS
  status          TEXT NOT NULL,        -- 'pending' | 'approved' | 'rejected'
  submitted_at    TEXT NOT NULL,
  reviewed_at     TEXT,
  reviewed_by     TEXT
);

-- Tokenized, per-faculty review invitations. See §8b.
CREATE TABLE review_requests (
  id            INTEGER PRIMARY KEY,
  faculty_id    INTEGER NOT NULL REFERENCES faculty(id),
  token_hash    TEXT NOT NULL UNIQUE,   -- ★ SHA-256 of the token. NEVER store the raw token.
  slug          TEXT NOT NULL,          -- "matt-stock" — cosmetic only, NOT a credential
  cycle_label   TEXT,                   -- "Fall 2026 review" — groups a campaign
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  opened_at     TEXT,                   -- first time the link was loaded
  completed_at  TEXT,                   -- faculty clicked "I'm done"
  revoked       INTEGER DEFAULT 0
);
CREATE INDEX idx_rr_faculty ON review_requests(faculty_id);

-- Roundup editions. One row per published Research Roundup post. See §6b.
CREATE TABLE roundups (
  id            INTEGER PRIMARY KEY,
  label         TEXT NOT NULL,      -- "Spring and Summer 2025"
  generated_at  TEXT NOT NULL,
  generated_by  TEXT,
  pub_count     INTEGER NOT NULL,
  html          TEXT NOT NULL       -- the exact HTML that was published. Archive + audit trail.
);

-- Every AI call, for cost projection. See §10.
CREATE TABLE usage_log (
  id             INTEGER PRIMARY KEY,
  app_name       TEXT NOT NULL,        -- 'research-roundup'
  provider       TEXT NOT NULL,        -- 'groq'
  model          TEXT NOT NULL,        -- 'openai/gpt-oss-120b'
  task_type      TEXT NOT NULL,        -- 'parse_scholar_alert' | 'fuzzy_title_match' | ...
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  success        INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);

-- Records where a stored, already-populated volume/issue/pages disagrees with
-- Crossref's current record for that DOI. Written by the `refresh-metadata`
-- job (§9) — flag-only: that job never overwrites the publications row
-- itself, it only logs the disagreement here for a human to review via the
-- §8c Tab 4 pre-flight warnings. One row per publication; a second run
-- upserts on `publication_id` rather than duplicating.
CREATE TABLE metadata_mismatches (
  id              INTEGER PRIMARY KEY,
  publication_id  INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  stored_volume   TEXT,       -- what's currently in publications.volume
  crossref_volume TEXT,       -- what Crossref's current record says
  stored_issue    TEXT,
  crossref_issue  TEXT,
  stored_pages    TEXT,
  crossref_pages  TEXT,
  detected_at     TEXT NOT NULL,
  UNIQUE(publication_id) -- upsert target, so re-running refresh-metadata doesn't duplicate
);

-- Records a possible-duplicate judgment call made at ingest time (§7), so it survives
-- past the run's console output. One row per (publication, candidate) pair. Written by
-- ingest-scholar whenever an outcome's possibleDuplicateOf is non-empty, on either the
-- insert_needs_metadata or insert_resolved path. Read by release-buffer (§9) to hold a
-- record out of promotion until a human resolves it. No admin UI reads/writes
-- resolved_at/resolution yet — until one exists, resolution is a manual UPDATE.
CREATE TABLE possible_duplicates (
  id                       INTEGER PRIMARY KEY,
  publication_id           INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  candidate_publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  reason                   TEXT,       -- e.g. 'title_drift', 'near_duplicate_title'
  detected_at              TEXT NOT NULL,
  resolved_at              TEXT,       -- NULL = still open
  resolution               TEXT,       -- 'merged' | 'not_duplicate' | NULL while open
  UNIQUE(publication_id, candidate_publication_id)
);

-- §8b item 7: faculty can fix journal/volume/pages/title on their own reviewable
-- publications directly (no COMMS approval gate — they're the author), but the
-- change must be logged so COMMS can spot-check provenance. One row per field
-- changed per edit call. Written by lib/review-actions.ts::editCitation.
CREATE TABLE citation_edits (
  id             INTEGER PRIMARY KEY,
  publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  faculty_id     INTEGER NOT NULL REFERENCES faculty(id),
  field          TEXT NOT NULL,      -- 'journal' | 'volume' | 'issue' | 'pages' | 'title'
  old_value      TEXT,
  new_value      TEXT,
  edited_at      TEXT NOT NULL
);
```

### UNITS (exact strings — these become the `<h2>` headings and anchor slugs)
```
School of Communication Sciences and Disorders
Center for Autism and Related Disabilities
Department of Health Sciences
School of Kinesiology and Rehabilitation Sciences
School of Social Work
```

### ★ Deriving `faculty.unit` from the WordPress directory

The directory does **not** store a faculty member's unit as a clean string. It uses a
`departments` taxonomy, and the taxonomy is **multi-valued per person** (e.g. a faculty member
can carry both `Physical Therapy` and `Exercise Physiology & Rehabilitation Science`) and its
term names do **not** match the five canonical strings above. `sync-roster` must map explicitly,
**keyed on the taxonomy term ID** — term names carry HTML entities (`&amp;`) and inconsistent
smart-quote encoding, so name-matching is not reliable:

```
DEPARTMENT TERM ID → CANONICAL UNIT

  166  communication-sciences-and-disorders  → School of Communication Sciences and Disorders
  232  health-sciences                       → Department of Health Sciences
   83  social-work                           → School of Social Work
  204  kinesiology                           → School of Kinesiology and Rehabilitation Sciences
  239  physical-therapy                      → School of Kinesiology and Rehabilitation Sciences
  253  athletic-training                     → School of Kinesiology and Rehabilitation Sciences
  439  center-for-autism-and-related-...     → Center for Autism and Related Disabilities

NOT roundup units — ignore, never guess a mapping for these:
   71  deans-office
  442  exercise-physiology-rehabilitation-science   (a research area, not a home department)
  311  communication-disorders-clinic
  446  center-for-behavioral-health-research-and-training
  332  faast-assistive-technology-center
 1208  tats
  519  ucf-it
```

**The resolution rule:**
- **Exactly one** canonical unit matched → that is `faculty.unit`.
- **Zero** matched (e.g. a Dean's-Office-only person) → `faculty.unit = NULL`. Import the
  person; report them. Do not invent a default (§15.11).
- **Two or more** matched → this should not happen under the current map, but if it does,
  `faculty.unit = NULL` and report it. **Never take the first term** — taxonomy array order is
  not meaningful and must never be treated as "primary."

### ROLES (drives the bold/asterisk formatting)
| Role value | Renders as | Meaning |
|---|---|---|
| `chps_faculty` | **Bold** | CHPS faculty member. Auto-assigned when the author name matches a `faculty` row. |
| `grad_student` | Name`**` | Graduate student co-author. **Only a human can assign this.** |
| `undergrad_student` | Name`*` | Undergraduate student co-author. **Only a human can assign this.** |
| `external` | Plain | A human has **confirmed** this person is not CHPS faculty or a CHPS student. |
| `unknown` | Plain | ★ **Ingested but never reviewed.** Nobody has yet said whether this is a student. |

> ### ⚠️ Why `unknown` exists separately from `external`
> Every author who arrives via Crossref/PubMed/ORCID and doesn't match a faculty row is, at ingest time, simply *unclassified*. If we default those to `external`, the record becomes indistinguishable from one a human actually reviewed — and the publication renders with **no student asterisks at all**, silently.
>
> **This is an invisible failure.** A missing *publication* generates a complaint from the faculty member. A missing *asterisk* generates nothing — it just quietly under-credits a student in a public post, and no one notices. Given that the roundup explains the asterisk convention in its own legend line and student co-authors appear throughout the existing post, the college plainly cares about this.
>
> Keeping `unknown` distinct makes the gap **countable and surfaceable**: the system can report "38 publications have unreviewed co-authors" instead of quietly shipping them unmarked.
>
> **`unknown` still renders as plain text** (same as `external`) — it does not block publication. It is a data-quality signal, not a gate. But COMMS must see the count before finalizing an edition (§8c), and the personal review page (§8b) exists specifically to drive it toward zero.

> **Role is the single most important field in the system.** It cannot be derived from Crossref/PubMed/Scholar — none of them know who is CHPS faculty or who is a student. `chps_faculty` is auto-assigned by roster match; **student status has no machine-readable source anywhere and must come from a human — specifically, from the faculty member who supervised them.** See §8b.
>
> **Never guess a student role.** Ingest assigns `chps_faculty` or `unknown`. It never assigns `grad_student`, `undergrad_student`, or `external` on its own.

---

## 6a. ★ Units are DERIVED and MULTI-VALUED

**A publication does not have "a unit." It has units — plural — determined by which CHPS faculty are on it.**

This is not a design preference; it's how the existing roundup already works. In the Spring/Summer 2025 post, this paper appears **twice** — once under Department of Health Sciences, once under School of Social Work:

> Brazendale, K., Jeune, S., Garcia, J., Quelly, S., … *Initial Evidence Comparing Beverage and Snack Dietary Patterns of Children with Autism Spectrum Disorders During School Versus Summer Months*

Same for the Pasarica / Yalim / Neely papers (School of Kinesiology and Rehabilitation Sciences **and** School of Social Work). When co-authors span units, each unit claims the paper in its own section. That is correct and intended.

### The rule
```
units(publication) = DISTINCT( faculty.unit
                               FOR each publication_author
                               WHERE role = 'chps_faculty'
                                 AND faculty_id IS NOT NULL )
```
The generator renders the publication **once per distinct unit** in that set.

### Why this matters beyond correctness
The manual process produces inconsistencies precisely because each unit's section is formatted by hand, separately. In the live post, the Health Sciences copy of the Brazendale paper leaves `Lawrence` and `Gurnukar` unbolded, while the Social Work copy of the *same paper* bolds them. Deriving units from one author-role source of truth makes that class of bug structurally impossible — a name is bolded in every section or none, because it's the same record.

### Consequences for implementation
- **Do not** store `unit` on `publications`.
- Author→faculty linkage (`publication_authors.faculty_id`) becomes load-bearing: an unlinked CHPS author means the paper silently drops out of that unit's section.
- A publication with **zero** linked CHPS faculty authors belongs to no unit and **cannot appear in the roundup**. Surface these in the admin as "no CHPS author linked" — it usually means a name-matching miss, not a paper that doesn't belong.
- The `unit` field on a faculty self-submission is a *hint* for the reviewer, not the source of truth. The reviewer's real job is confirming the author roles and linkages; units follow from those automatically.

---

## 6b. ★ Roundup editions: the no-double-post rule

**The roundup is not "papers published between date X and date Y." It is "everything we've collected since the last roundup that hasn't gone out yet."**

Evidence: the Spring/Summer 2025 post — nominally covering "January through June 2025" — contains multiple **2024** publications (Binger 2024, Scheidell 2024, Frank 2024). Papers surface late. A paper published in late 2024 but discovered in 2025 belongs in the 2025 roundup, because it has never been posted.

### Why pure date-range filtering fails
- **Overlapping ranges → double-posting.** The same paper appears in two consecutive roundups. This is exactly the failure that broke the original manual workflow.
- **Gapped ranges → silent omission.** A paper discovered between two roundup windows never appears at all, and nobody notices.
- **Late discoveries have nowhere to go.** A 2024 paper found in March 2025 fits no clean "publication date" window.

### The rule
A publication is eligible for a new roundup if and only if:
```sql
status = 'published'          -- complete, reviewed, out of the merge buffer
AND roundup_id IS NULL        -- has never been included in any roundup edition
AND date_added <= :end_date   -- collected on or before the cutoff
```
Note there is **no start date** in the eligibility rule. `roundup_id IS NULL` *is* the start boundary — it means "everything not yet posted." The end date exists only to let COMMS draw a line ("include everything through June 30").

### On publish
When COMMS finalizes a roundup:
1. Insert a `roundups` row (label, timestamp, count, and the exact HTML).
2. Stamp `roundup_id` on every publication included.
3. Those publications are now permanently ineligible for future roundups.

This makes double-posting **structurally impossible** rather than a thing a human has to remember to check.

### UI implications
- The generator's primary control is an **end date**, not a range. Optionally show the start boundary as read-only context: *"Includes everything collected since the last roundup (Oct 17, 2025)."*
- Show the eligible count before generating: *"142 publications ready for this roundup."*
- Provide a way to **exclude** a specific publication from this edition without marking it posted (leave `roundup_id` NULL) — e.g. it's a duplicate, or COMMS wants to hold it.
- Provide an **archive view** of past roundups (from the `roundups` table), since the exact published HTML is stored. Useful for "what did we say last time?" and for un-stamping if something needs to be pulled back.

---

## 7. Dedup & merge (the hard part)

### The problem
When two CHPS faculty co-author the same paper, Scholar sends **two separate alerts**. Naively, that creates two database rows and would produce a duplicate citation in the roundup. (In the earlier manual/Zapier workflow, this same collision caused the same paper to be posted twice — it is the original problem this system exists to solve.) The same paper may *also* arrive independently via Crossref and via PubMed.

### The solution: a merge buffer
```
New publication detected (any layer)
        │
        ▼
Does it match an existing record?           ← see MATCHING below
        │
   ┌────┴────┐
   │         │
  NO        YES
   │         │
   │         └─→ MERGE into existing record:
   │              · add any new authors (dedupe by name)
   │              · upgrade metadata using layer priority (§5)
   │              · do NOT create a new row
   │
   └─→ INSERT new row, status = 'pending_merge', first_seen_at = now
        │
        ▼
   Held for MERGE_BUFFER_HOURS (default: 60)
        │
        ▼
   A separate scheduled job releases matured records:
   status → 'published', released_at = now
```

**Why the buffer exists:** if we published immediately on the first alert, a co-author's alert arriving two days later would have nothing to merge into. The buffer gives all co-author alerts for the same paper time to land in the same window and merge into one record with full author credit.

### MATCHING — how to decide if two records are the same paper
Apply in order; stop at first confident answer:
1. **DOI exact match** → same paper. Cheapest and most reliable. Always try this first.
2. **Normalized title exact match** (`title_normalized`) → same paper.
3. **Fuzzy title match via AI** → only if 1 and 2 fail. Scholar-parsed titles vary across authors' profiles (truncation, subtitle differences, OCR quirks). Send the candidate title + a shortlist of recent pending titles to Groq and ask for an exact match or `NEW`.

**Do not run step 3 against the entire table.** Pre-filter to publications with `first_seen_at` within the buffer window (plus a small margin) before calling AI. This keeps token usage negligible.

### Author merge rules
- Match authors by normalized name.
- If a merge adds a `chps_faculty` author to a record whose author list came from a different source, **preserve original citation author order** (`position`) — do not append CHPS faculty to the end. Author order is meaningful in academic citations and getting it wrong is a visible error.
- When author lists conflict between sources, prefer the more complete list from the higher-priority source (§5).

### Possible-duplicate flags persist
`findPossibleDuplicates`'s deterministic near-title check (lib/scholar-ingest.ts) is non-blocking — it never stops an insert. Every flagged pair is written to `possible_duplicates` (§6) so the judgment survives past the run's console output. Release-buffer (§9) reads it and holds a flagged publication out of promotion until a human resolves the pair (`lib/duplicates.ts::resolveDuplicate`).

---

## 8. The three front-ends (Vercel, Next.js)

| | Route | Auth | Purpose |
|---|---|---|---|
| **8a** | `/` | None | Public search + generic submission. Passive discovery. |
| **8b** | `/review/{slug}/{token}` | Token (capability URL) | ★ Personal review. **Where student status and wrong attributions actually get fixed.** |
| **8c** | `/admin` | Server-side session | COMMS: campaigns, queues, generator, archive. |

### 8a. Public portal — no login
**Route:** `/`

- **Search box** — matches against publication title OR any author name. Server-side query against Turso (indexed). Returns formatted citations grouped or listed with their unit shown.
- **Purpose:** faculty are directed here and asked to confirm their publications are present.
- **"Don't see one of your papers? Add it" form:**
  - Fields: your name (citation form), co-authors (repeatable rows: name + role dropdown), title, journal, year, volume, issue, pages, link, unit, optional note.
  - **Faculty must not be asked to understand the bold/asterisk convention.** They pick roles from a plain-language dropdown ("CHPS faculty" / "Grad student" / "Undergrad student" / "Other"); the system applies formatting.
  - Submits to `pending_submissions` with status `pending`. **Never writes directly to `publications`.**
  - Confirmation message on success.

### 8b. ★ The personal review page — where faculty verify their own work

**Route:** `/review/{slug}/{token}` — e.g. `/review/matt-stock/f8Kd9Lm2QpX7vNzR4hT1sYbW`

This is the **primary mechanism** by which student status, wrong attributions, and missing papers get corrected. The public portal (§8a) is passive discovery; this is an active, targeted ask sent to one person about their own publications.

**The problem it solves.** Student status (`grad_student` / `undergrad_student`) exists in no machine-readable source — not Crossref, not PubMed, not the directory. The only reliable source is **the faculty member who supervised the student**. Similarly, only the author can tell us that a Crossref name-match grabbed the wrong "Lee, E." Waiting for faculty to voluntarily visit a search portal will not produce this data. A personal link, sent only when they actually have something to review, will.

---

#### What the page shows

Only publications that are:
- linked to **this** faculty member, and
- **not yet published in any roundup** (`roundup_id IS NULL`), and
- not rejected.

Framed as: *"These are your publications queued for the next CHPS Research Roundup. Please confirm before we post."*

Papers already posted in a past roundup are **not** shown — they're settled, and surfacing them invites edits to something already public.

---

#### What faculty can do (a deliberate gradient of trust)

| Action | Applies | Why |
|---|---|---|
| **Tag co-author roles** — "was this person your grad student?" | **Immediately** | They are the authority. Nobody else knows. Sets `role`, `role_set_by = 'faculty:{id}'`. |
| **"This isn't my paper"** | **Immediately** (unlinks them, flags for COMMS) | Crossref name-matching *will* produce false positives on common surnames. Without an exit, wrong attributions are permanent. |
| **Fix citation details** (journal, volume, pages, title) | **Immediately**, but logged | They're the author. Log provenance so COMMS can spot-check. |
| **Add a missing publication** | → `pending_submissions` (COMMS review) | Net-new content going out under the college's name. Same gate as §8a. |

Role tagging asks the one question only they can answer, in plain language — never "grad_student," never asterisks, never the bolding convention:

> **Your paper:** *Evaluating Fatalism Among Breast Cancer Survivors…*
> We don't know who these co-authors are:
>
> | Lopez Torralba, L. | ( ) Grad student ( ) Undergrad student ( ) Not CHPS |
> | Sukhu, B. | ( ) Grad student ( ) Undergrad student ( ) Not CHPS |

**Narrow the ask.** Show only authors currently marked `unknown`. Never make them re-confirm roster-matched faculty, never show other people's papers. Typically 2–3 names per paper — a ten-second task.

---

#### ★ Duplicate handling on "add a missing publication"

When a faculty member submits a paper, match it (DOI → normalized title → fuzzy, per §7) against **all** publications. **Four outcomes — and one of them is a feature, not an error:**

| Match | Response |
|---|---|
| Matches a paper **already posted** (`roundup_id` NOT NULL) | *"Good news — we already shared this one in the **Spring and Summer 2025** roundup."* + link to the post. Create nothing. |
| Matches a paper **already in their queue** | *"This one's already in your list below."* Scroll to it. Create nothing. |
| ★ Matches a paper **in the database that they are not listed on** | **This is a name-matching miss, not a duplicate.** Add them to the existing record as an author (`chps_faculty`, linked to their `faculty_id`). **Do not create a second record.** Tell them: *"Found it — we had this paper but hadn't connected it to you. Fixed."* |
| No match | Genuine new submission → `pending_submissions`. |

> **Why the third case matters.** A publication with no linked CHPS faculty author belongs to no unit and is invisible in the roundup (§6a). This flow lets the affected faculty member fix that themselves, on the paper they care most about, without COMMS ever touching it. It is the highest-value thing this page does beyond role tagging.

---

#### Security model — sized honestly

**The token is the authentication.** This is a capability URL (the same pattern as an unsubscribe link). That is appropriate here, and it should not be over-engineered:

- The data behind the link is **public-facing publication records**. Nothing private.
- The worst realistic abuse is mislabeling a co-author's role or unlinking a paper — visible to COMMS, and reversible.
- A login wall would collapse participation, and participation *is* the entire point of the feature.

**Do all of these, though — every one is cheap:**
1. **Cryptographically random token**, ≥128 bits, from a CSPRNG. Never sequential, never derived from the name or ID.
2. **Store only `sha256(token)`.** A database leak must not yield working links.
3. **Expire it** — 90 days, or on publication of the next roundup, whichever comes first (`expires_at`).
4. **Scope every query to the token's `faculty_id`.** The `{slug}` is cosmetic and human-readable — **never** authenticate or authorize on it. A mismatched slug is ignored or redirected, never trusted.
5. **⚠️ `<meta name="referrer" content="no-referrer">` on this page.** It is full of outbound links to DOIs and publisher sites. Without this, clicking one sends a `Referer` header containing **the full URL, token included**, to that publisher's server. Also `rel="noopener noreferrer"` on every outbound link.
6. **No destructive actions.** Nothing that deletes another person's records or touches an already-posted roundup.
7. **Revocable** (`revoked` flag), in case a link gets forwarded somewhere it shouldn't.

---

#### The email

Generated per faculty member, and **only sent if they actually have something to review** — either queued publications or `unknown`-role co-authors. Sending "you have 0 items to review" trains people to ignore the email.

Tailor it:
> *Dr. Stock — you have **3 publications** queued for the next CHPS Research Roundup, and **2 co-authors** we couldn't identify.*
> *[Review your publications]*

**Lead with the student framing.** "Help us check our database" is a chore with no payoff for them. *"Make sure your students get credit in the college's research post"* is something faculty actually care about — and it happens to be exactly the task only they can do.

Track `opened_at` and `completed_at` so COMMS can see who has and hasn't responded, and send **one** targeted reminder rather than blanket-nagging the whole college.

---

### 8c. COMMS admin — login required
**Route:** `/admin`

**Auth:** Standalone login for this Vercel app. Server-side session (e.g. an httpOnly cookie signed with a secret; credentials in env vars). **Do not ship a client-side password check** — it is trivially bypassed by viewing source. All admin API routes must verify the session server-side, not just the UI.

**Tab 1 — Pending submissions**
- Lists every `pending` submission, each **rendered as it would actually appear in the roundup** so the reviewer can spot a wrong journal name, a misspelled co-author, or a miscategorized role before it goes public.
- Approve → creates a `publications` row (+ `publication_authors`), status `published`, source `manual`.
- Reject → marks the submission rejected; nothing enters `publications`.
- Reviewer can edit fields before approving.

**Rationale for the review gate:** self-reported data should not go out under the college's name unreviewed. Faculty may submit a preprint they believe is published, misspell a co-author, or misjudge a student's status.

**Tab 2 — Incomplete records (`needs_metadata`)**
- Publications discovered via Scholar whose Crossref resolution failed (gray literature — see §5a.6).
- Shows what we have (title, year, discovering faculty member, Scholar link) and what's missing (authors, journal, volume/pages).
- A human completes the record — most importantly the **full author list with roles**, which the Scholar alert truncated away.
- On save → `status = 'pending_merge'` (re-enters the normal flow) or straight to `published`.
- **These records must never leak into a generated roundup while incomplete.** The generator filters on `status = 'published'` only.

**Tab 3 — Review campaigns (§8b)**
- **Generate review links** for a cycle: for every faculty member who has something to review (queued publications, or `unknown`-role co-authors), mint a token, store its hash, and produce the personalized link + email copy.
- **Explicitly skip faculty with nothing to review.** Do not email them.
- **Response dashboard:** who's been sent a link, who opened it, who completed it. Drives a single targeted reminder rather than blanket-nagging the college.
- Revoke a link if needed.

**★ Email notifications on/off switch (Session 16.2).** A generic key-value `settings` table (`key`, `value`, `updated_at`, `updated_by`) backs a global kill switch for all outbound email — `email_notifications_enabled`, defaulting to `'false'` on a fresh migration. `lib/settings.ts::isEmailNotificationsEnabled` fails safe: a missing row, an unrecognized value, anything other than the literal string `'true'` all read as disabled. Enforced at `lib/gmail.ts::sendMessage` itself (the actual choke point — throws `EmailNotificationsDisabledError`, makes zero Gmail API calls when off) and, redundantly and deliberately, at the top of `lib/campaigns.ts::runCampaign`'s real-run path (a clean abort before any faculty selection or `review_requests` writes). `--dry-run` is never gated by it — dry-run already sends and writes nothing. Controlled today via `scripts/settings-email.ts` (`npm run settings:email -- --status|--enable|--disable [--by "<name>"]`), the same CLI-before-UI pattern as `sync-roster`/`coverage-report`/`campaign-status`; meant to grow into a proper settings tab once this admin page's login wall (above) exists, at which point Tab 3 gets an actual on/off toggle wired to the same table instead of a terminal command.

**Tab 4 — Roundup generator**
- **★ Refresh before you generate.** Before computing eligibility, run `refresh-metadata` (§9) over the eligible set. Ahead-of-print articles resolve from Crossref with a DOI, a full author list, and a full journal name — but with **no volume, issue, or pages**, because the publisher hasn't assigned them yet. Such a record passes the resolver's acceptance gate, reaches `status = 'published'`, and is roundup-eligible while still structurally incomplete. Because this tab's finalize step stamps `roundup_id` **permanently** (§6b), publishing one in that state freezes the incomplete citation forever — the paper can never appear in a later edition, even after the publisher assigns full pagination a month later. This is not a hypothetical: the first title resolved during the Crossref-resolver build (Stock et al., *Exercise and Sport Sciences Reviews*, 2026) was exactly this shape. The refresh is a handful of Crossref calls per edition, it's idempotent, and it should report what it changed alongside the other pre-flight warnings below.
- Inputs: post title, intro paragraph, legend line, **end date (cutoff)**, and an edition label (e.g. "Spring and Summer 2025").
- **Eligibility (§6b):** `status = 'published'` AND `roundup_id IS NULL` AND `date_added <= end_date`. **There is no start date** — "not yet posted" is the start boundary.
- Shows the eligible count and the implicit start boundary before generating: *"142 publications collected since the last roundup (Oct 17, 2025)."*
- Lets COMMS **exclude** individual publications from this edition without marking them posted (leaves `roundup_id` NULL so they roll into the next one).
- **Unit grouping is derived (§6a):** for each publication, compute the distinct set of units from its linked `chps_faculty` authors, and render the publication **once per unit** it belongs to. A paper co-authored across two units appears in both sections. A paper with no linked CHPS faculty author appears nowhere — flag those, don't silently drop them.
- Renders:
  - `<h1>` title
  - intro `<p>`
  - legend `<p><em>`
  - `<h2>Quick jump</h2>` + `<ul>` of anchor links, one per unit **present in this edition**
  - per unit: `<h2 id="{slug}">Unit Name</h2>` followed by one `<p>` per citation
- **Ordering:** units in the canonical order from §6. Within a unit, sort citations alphabetically by first author's surname (matching the existing post's convention).
- Citation format (matches the live post exactly):
  `Authors (Year). <a href="{url}">Title</a>. <em>Journal</em>, Volume(Issue), Pages.`
  - Authors joined with commas, `&` before the last, **in original citation order**.
  - `chps_faculty` → `<strong>`; `grad_student` → suffix `**`; `undergrad_student` → suffix `*`.
  - **Verified against the live post (Phase 1, item 3):** one long-author-list citation
    in the live post — the Rovito/Brazendale testicular-cancer paper, 10 authors — omits
    the `&` before the final author (`..., Langan, J., Leslie, M.K.` — no `&`). Every
    other multi-author citation in the same post includes it. This is almost certainly
    a copy/paste or Word-export artifact on that one entry, not an intentional rule tied
    to list length. The generator always inserts `&` before the final author regardless
    of how many authors precede it — confirmed against
    `tests/fixtures/live-post-citations.html` (snippet 3) in `tests/citation.test.ts`.
- Outputs: **live preview** + **raw HTML source** with copy-to-clipboard and download buttons.
- **Pre-flight warnings (do not block publishing — but never fail silently, §15.11):**
  > ⚠️ *14 publications have unreviewed co-authors (`unknown`). They will publish with no student asterisks.*
  > ⚠️ *3 publications have no linked CHPS faculty author and will not appear in any unit section.*
  > ⚠️ *6 faculty were sent review links and haven't responded.*
  > ⚠️ *2 publications have a volume, issue, or pages value that no longer matches Crossref's current record for that DOI (`refresh-metadata` found a mismatch on an already-populated field and did not overwrite it — confirmed real cases: a citation stored with pages "1–9" whose DOI now resolves to "82-90" in Crossref (provisional early-view pagination superseded by the final print version), and a citation stored with issue "8" whose DOI now resolves to issue "4"). Review and update manually if the citation should reflect Crossref's current value.*

  Each links to the affected records so COMMS can chase them or knowingly accept.
- **On finalize:** insert a `roundups` row (label, timestamp, count, exact HTML) and stamp `roundup_id` on every included publication. They become permanently ineligible for future editions (§6b). Expire any outstanding review tokens for this cycle.

**Tab 5 — Roundup archive**
- Lists past `roundups` rows with their stored HTML.
- Allows un-stamping an edition (clearing `roundup_id` on its publications) if something needs to be pulled back and regenerated. Rare, but the alternative is hand-editing the database.

**Note:** A working front-end prototype of the generator + portal already exists (built in an earlier session) demonstrating the layout, citation formatter, and submit→review→publish flow. Use it as a visual/behavioral reference; the logic is correct, but the storage layer and auth are placeholders that must be replaced with Turso and real server-side auth.

---

## 9. Scheduled jobs (GitHub Actions)

All ingestion runs in GitHub Actions, not Vercel Cron.

| Job | Cadence | What it does |
|---|---|---|
| `sync-roster` | Daily | Pulls people from the WordPress REST API → upserts `faculty`. **Parses `scholar_user_id` out of each profile's research-profile URL, guarding on hostname** (§5a.3). Resolves `unit` from the `departments` taxonomy term IDs (§6a). Parses `orcid` from the ORCID URL field. Derives the Scholar-alert coverage picture (§11). |
| `ingest-scholar` | Every 6h | Gmail API → fetch unprocessed Scholar alert emails → **reject citation alerts (§5a.2)** → extract faculty/title/year → **resolve full metadata via Crossref title search** → match/merge → insert with `status='pending_merge'`, or `status='needs_metadata'` if Crossref resolution failed. Mark emails processed. |
| `ingest-crossref` | Daily | For each active faculty member, query Crossref by author name + UCF affiliation for recent works → match/merge. |
| `ingest-pubmed-orcid` | Daily | ORCID works list (where `orcid` present) + PubMed author search → match/merge/enrich. |
| `release-buffer` | Every 6h | Promotes `pending_merge` records older than `MERGE_BUFFER_HOURS` → `status='published'`, sets `released_at`. |
| `refresh-metadata` | Daily | ★ For every publication with a DOI, `roundup_id IS NULL`, and a null `volume` or `pages`, re-resolve via `resolveByDoi` and fill the gaps. Catches ahead-of-print records ingested before the publisher assigned volume/issue/pages (see the amended §8c Tab 4). Never overwrites a non-null field, and never overwrites a field a human set via the review page (§8b) — same provenance check as `mergeMetadata` (§7). Never touches a publication with `roundup_id` already set — that edition is archived and settled (§6b). **★ Detection is wider than the fix:** the job also re-resolves publications whose `volume`/`pages` are already non-null, to check whether Crossref's current record disagrees with what's stored on **volume, issue, or pages** (confirmed real cases: a live-post citation showed pages "1–9" while Crossref's authoritative record showed "82-90" — provisional early-view pagination that was later superseded — and a live-post citation showed issue "8" while Crossref's authoritative record showed issue "4"). When a mismatch is found on an already-populated field, the job does **not** overwrite it — that would risk clobbering a value a human corrected — it only logs the discrepancy (in `metadata_mismatches`, §6) for the §8c Tab 4 pre-flight warnings, so a person decides whether to update it. |

**Idempotency is required.** Every job must be safe to re-run. A re-run must never create duplicate publications or duplicate author rows. Guard with the matching logic in §7 and `UNIQUE` constraints.

### ★ `sync-roster`'s inclusion rule — a correctness issue, not a style choice

`sync-roster` must not decide who is "faculty" using the directory's `class`/`classification`
taxonomy alone. Verified against the live directory, two failures follow from doing so:

1. At least one active, publishing faculty member is classified **`Leadership`** only —
   not `Faculty`. A `classification = Faculty` filter silently drops her.
2. **The entire Center for Autism and Related Disabilities roster is classified `Staff`**,
   not `Faculty` — yet CARD is one of the five canonical roundup units and has publications in
   the live reference post. A classification-based filter erases an entire unit from the system.

**The rule:**

```
Include a person in the roster IF:
      classification contains 'Faculty' OR 'Leadership'
   OR research_profile_url is non-empty
```

This is self-healing: the moment anyone — regardless of classification — adds a research
profile link to their directory entry, they enter the roster automatically. No hardcoded
per-person exception list to maintain.

> CARD may sync to zero roster members under this rule, until someone in that unit adds a
> profile link or its classification changes. **That must be surfaced loudly** in the coverage
> report (§11) as "canonical unit with zero roster members" — not discovered later as an empty
> section in a published post (§15.11).

---

## 10. AI abstraction layer (required, not optional)

**Groq is temporary.** The college will eventually move to a paid AI provider with purchased credits. If each app calls the Groq SDK directly, migrating means touching multiple codebases.

**Requirement:** all AI calls go through a single function:

```ts
callAI({
  appName: 'research-roundup',
  taskType: 'fuzzy_title_match',   // or 'parse_scholar_alert', etc.
  prompt: string,
  // ...
}): Promise<{ text: string; inputTokens: number; outputTokens: number }>
```

- Internally selects provider + model from config/env (`AI_PROVIDER`, `AI_MODEL`). Swapping providers = changing env vars, not rewriting call sites.
- Uses the OpenAI-compatible endpoint shape (Groq supports this at `https://api.groq.com/openai/v1`), which makes a later swap to most providers close to a one-line change.
- **Writes one row to `usage_log` on every call**, capturing token counts (Groq returns these in the response). This is what makes real cost projection possible later — multiply logged token volume against current provider rates instead of guessing.
- Handles 429s with exponential backoff.

**Resilience requirement:** deterministic parsing (regex / structured field extraction) is the **primary** path. AI is the **fallback / quality layer** for messy inputs and fuzzy matching. Free-tier terms change without notice — if the AI layer degrades or hits limits, the pipeline should thin out, not break.

---

## 11. Known limitation: Scholar alert subscription

Creating a Google Scholar alert for an author is a **manual click** on a logged-in user's account. Scholar exposes no API for it. There is no supported way to auto-subscribe.

**The good news: coverage detection is fully automatic.** Because `sync-roster` parses `scholar_user_id` out of each directory profile's research-profile URL, and because every incoming alert carries that same ID in its footer link, the system can derive alert coverage without a human maintaining a checklist:

| Condition | Meaning | Admin surfaces it as |
|---|---|---|
| `scholar_user_id` present, `last_alert_seen_at` NULL | Directory has a Scholar profile, but we've never received an alert from it | **"Alert likely not created yet"** — someone should create it |
| `scholar_user_id` present, `last_alert_seen_at` recent | Working as intended | — |
| ★ `research_profile_url` present, but its host is **not** `scholar.google.com` | Faculty uses ResearchGate, an NCBI bibliography, or similar — verified to be real and non-trivial in the current directory | **"No Scholar coverage — profile is not Google Scholar."** ★ **Not actionable. This is a permanent fact, not a to-do.** There is no Google Scholar alert to create for someone who has no Google Scholar profile. This person is Crossref/PubMed/ORCID-only, and that is fine — do not prompt anyone to "fix" it. |
| `research_profile_url` present but unparseable as any known profile type | The URL in the directory is broken (typo, wrong link type, shortened URL, or — an actual case found in the live directory — a bare journal-article DOI pasted into the profile field by mistake) | **"Fix this directory link"** |
| No `research_profile_url` at all | Nobody has a profile linked in the directory | **"No Scholar coverage"** — this person's work will only be found via Crossref/PubMed/ORCID |

The COMMS admin renders this as a coverage picture. A human clicks Follow on Scholar for anyone in the first bucket; nothing else needs recording, because the next alert that arrives will self-identify by ID and set `last_alert_seen_at` automatically.

> ### ⚠️ Do not collapse the middle bucket into "alert not created"
> The single most important change to this table: a faculty member whose research profile is
> ResearchGate or an NCBI bibliography is **not** in the same state as someone who simply
> forgot to create a Scholar alert. Presenting both as the same to-do item sends a human on a
> pointless errand — you cannot create a Google Scholar alert for a Google Scholar profile that
> does not exist. Keep these as five distinct buckets, and word the non-Scholar-profile bucket
> as a fact the admin should know, not a task it should chase (§15.11).

> **Caveat on the NULL-alert signal:** a faculty member with a valid Scholar profile and an active alert who simply hasn't published recently will *also* show `last_alert_seen_at = NULL`. Absence of an alert is weak evidence, not proof, that the alert doesn't exist. Present this bucket as "likely not created — please verify," not as a definitive error. It's a prompt for a human to check, not an assertion.

> **Also surface, prominently: any canonical unit (§6 UNITS) with zero roster members.** This
> is a distinct, more serious signal than an individual coverage gap — it means an entire
> section of the roundup has no faculty linked to populate it. See the amended §9 roster rule;
> Center for Autism and Related Disabilities is a real, currently-standing example of this.

**Do not build browser automation to click Scholar's Follow button.** It is fragile, breaks when Scholar's UI changes, risks bot-detection on an account used daily, and is against ToS. The derived to-do list is the correct, honest solution. It's a handful of clicks per new hire.

---

## 12. Environment variables

```
# Turso
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=

# AI (swappable — see §10)
AI_PROVIDER=groq
AI_MODEL=openai/gpt-oss-120b
GROQ_API_KEY=

# Gmail — BOTH read (Scholar alerts) and send (review emails).
# Scopes required: gmail.readonly AND gmail.send
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
GMAIL_ALERT_QUERY=from:scholaralerts-noreply@google.com subject:"new articles"
REVIEW_EMAIL_FROM=            # e.g. "CHPS Research <research@ucf.edu>" — a human-looking
                              # sender, NOT a no-reply address. Faculty reply to these.
REVIEW_EMAIL_REPLY_TO=        # a real person in COMMS who can field "this isn't mine" replies

# WordPress directory
WP_DIRECTORY_API_URL=

# Crossref (§5 Layer 2) — polite pool. No key required.
CROSSREF_MAILTO=

# Admin auth
ADMIN_PASSWORD=               # or hash
SESSION_SECRET=

# Review links (§8b)
APP_BASE_URL=                 # e.g. https://chps-research.vercel.app — used to build /review links
REVIEW_TOKEN_TTL_DAYS=90

# Behavior
MERGE_BUFFER_HOURS=60
```

---

## 13. Build order

Build in this order. Each phase should be independently verifiable before moving on.

**Phase 1 — Foundation**
1. Turso schema + migrations (§6)
2. `callAI` wrapper + `usage_log` (§10) — build this *before* anything calls AI
3. Citation formatter (author roles → bold/asterisks; record → citation HTML) + unit tests. **This is the highest-value pure function in the system.** Test it against real citations from the live roundup post.

**Phase 2 — Roster**
4. `sync-roster` job: WordPress REST API → `faculty` table, including **`scholar_user_id` parsing + normalization with a hostname guard** (§5a.3), **unit derivation from department taxonomy term IDs** (§6a), and **ORCID iD extraction from the profile URL field**. Test against the real variety of research-profile URLs actually present in the directory — Scholar URLs verified to parse cleanly (no malformed entries found in practice, but fail closed regardless); non-Scholar hosts (ResearchGate, NCBI, and one bare DOI entered in error) must all resolve `scholar_user_id` to `null`.
   - ★ **Given-name normalization is a separate, tested pure function**, built before the citation-name builder that depends on it. The directory's first-name field is not a clean given name — it contains middle initials, parenthetical/quoted nicknames, middle names, and non-ASCII apostrophes (verified: roughly 1 in 10 records). An exact-match lookup against an external API (ORCID, Crossref) using the raw field will silently fail for those people. Where a citation name can't be built with confidence (compound or hyphenated surnames, particles, suffixes), flag it for human review rather than guessing — a wrong name is a visible public error; a flagged one is a five-second fix.
5. Scholar-alert coverage detection (§11), including the roster-inclusion rule in §9 — verify it against a person classified `Leadership`-only and against the Center for Autism unit, which is expected to have zero roster members under a naive classification filter.

**Phase 3 — Ingestion**
6. Matching + merge engine (§7) — pure, testable, no I/O
7. **Crossref resolver** — `resolveByTitle(title, year, surnameHint) → full citation metadata | null`, plus `resolveByDoi` and the `refresh-metadata` job (§9). Build and test the resolver **before** the Scholar ingester, which depends on it (§5a rule 7). Test against real titles from the live roundup post, including at least one that should *fail* to resolve (gray literature) so the `needs_metadata` path is proven. *(Split across two Claude Code sessions: Session 6 builds the resolver itself; Session 7 builds `refresh-metadata`, which depends on Session 6's `resolveByDoi` — same reasoning as splitting `ingest-crossref` from `ingest-scholar` below, one deliverable per session.)*
8. `ingest-crossref` (roster-driven author search — proves the merge engine end to end)
9. `ingest-scholar` (Gmail API → citation-alert rejection → title/year/faculty extraction → Crossref resolution → `pending_merge` or `needs_metadata`)
10. `ingest-pubmed-orcid`
11. `release-buffer`

**Phase 4 — Front-end**
12. Public portal: search
13. **Personal review page** `/review/{slug}/{token}` (§8b) — token minting + hashing, scoped queries, role tagging, "not my paper," citation edits, and the four-outcome duplicate handler. **This is the mechanism by which student status enters the system at all.** Without it the roundup ships with no student asterisks.
14. Public portal: generic submit form → `pending_submissions`
15. Admin: server-side auth
16. Admin: review campaign tool — mint links, skip faculty with nothing to review, track opened/completed
17. Admin: pending submissions queue (approve/reject/edit)
18. Admin: incomplete records queue (`needs_metadata`)
19. Admin: unlinked-author queue (§6a)
20. Admin: roundup generator (edition-based §6b, with pre-flight warnings)
21. Admin: roundup archive

**Phase 5 — Hardening**
22. Idempotency tests on every ingestion job
23. **Token security tests:** tokens are hashed at rest; a valid token cannot read or write another faculty member's records; expired and revoked tokens are rejected; the `{slug}` is never trusted for authorization; the page emits `no-referrer`.
24. Backfill: seed the database from the existing Spring/Summer 2025 roundup post. **This is the acceptance test for the whole system** — if the generator can reproduce that post from the seeded data (including the multi-unit duplicates and correct bolding), it works. The existing post already has roles marked correctly by hand, so the seed doubles as a ground-truth set for role handling. Stamp the seeded records with a `roundups` row for that edition so they don't reappear in the next one.

---

## 14. Non-goals (v1)

- ❌ Social media posting (LinkedIn, etc.)
- ❌ Image/graphic generation (Canva, Google Slides)
- ❌ Scraping Google Scholar or ResearchGate directly
- ❌ Auto-subscribing to Scholar alerts via browser automation
- ❌ **A separate email/marketing platform.** Review emails send via the Gmail API using the credentials already required for reading Scholar alerts (§4). Do not add Resend/Postmark/Mailchimp unless deliverability actually becomes a demonstrated problem.
- ❌ **A login system for faculty.** The review page is a capability URL by design (§8b). A login wall would collapse participation, and participation is the entire point.
- ❌ Grant tracking (NIH RePORTER / NSF) — a good future addition, not now.

---

## 15. Design principles

1. **Nothing goes public unreviewed.** Automation drafts; a human approves. This applies to faculty self-submissions and to anything the AI parsed.
2. **Deterministic first, AI second.** AI is a quality layer, not a dependency.
3. **Merge, never duplicate.** A paper co-authored by three CHPS faculty is one record with three faculty authors — not three records.
4. **When uncertain, mark `unknown` — never `external`.** Ingest assigns only `chps_faculty` or `unknown`. `external` means *a human confirmed this person is not CHPS*. Defaulting to `external` would make an unreviewed record indistinguishable from a reviewed one and silently strip student credit. See §6 ROLES.
5. **Provider-agnostic.** Assume every free tier will change. Abstract the AI layer; log the usage.
6. **The citation formatter is the product.** Everything else is plumbing that feeds it.
7. **Separate discovery from resolution.** Scholar tells us *a paper exists*. Crossref tells us *what the paper is*. Never let a discovery source masquerade as a metadata source — a truncated author list silently drops co-authors, and dropped co-authors are exactly the failure this system exists to prevent.
8. **Fail closed on ambiguity.** A citation alert misread as an authorship alert publishes someone else's paper under a CHPS faculty member's name. When the parser isn't sure, it skips and flags rather than guessing. **This includes title matching:** if a query title has drifted enough from Crossref's registered title that the resolver's exact-match gate can't confirm it (confirmed real case: a live-post citation phrased "acute compared to chronic," Crossref's registered title said "acute and chronic" — the same paper, confirmed by DOI and author list, but a genuine wording difference), the correct behavior is to return `null` and route to `needs_metadata`, not to loosen the gate so more titles squeeze through. A human completing one flagged record is a far smaller cost than the gate someday accepting a wrong paper.
9. **Derive, don't store, what can be computed.** Units come from authors. Don't let a stored `unit` field drift out of sync with the author list — that's how the same paper ends up bolded differently in two sections of the same post.
10. **Make double-posting impossible, not merely unlikely.** `roundup_id` is a permanent stamp. A human should not have to remember what went out last time.
11. **Surface invisible failures.** A missing publication complains loudly (the faculty member notices). A missing student asterisk complains not at all — it just quietly under-credits someone in a public post. Anywhere the system can fail *silently*, it must instead produce a count a human can see: `unknown` roles, unlinked authors, `needs_metadata` stubs, faculty with no Scholar coverage. **Never default a gap to something that looks like a decision.**
12. **Ask the only person who knows.** Student status lives in exactly one place: the memory of the faculty member who supervised them. Design the ask to be narrow, plain-language, and pointed at that person — not at COMMS, who would only be guessing.
13. **Never ask someone for nothing.** Only email a faculty member when they actually have something to review. A "you have 0 items" email teaches people to ignore the next one, and the next one is the one that matters.
14. **Give every wrong answer an exit.** Name matching produces false positives; if the review page can only *confirm* and *add*, a wrongly-attributed paper is permanent. "This isn't my paper" is as important as "yes, that's my student."
15. **Don't present a permanent fact as an open task.** Some gaps are closeable (create a Scholar alert; fix a broken directory link). Others are not (a faculty member's chosen research profile is ResearchGate, not Google Scholar; a unit's roster is genuinely empty in the directory). Collapsing the two into one to-do list sends a human chasing something that cannot be fixed. Say plainly which is which — see the amended §11.
