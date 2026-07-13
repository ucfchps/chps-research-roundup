-- Corrects the faculty table built in 001 against ground truth pulled from the live
-- WordPress directory (see docs/wp-directory-notes.md and master plan §5a.3, §6, §9).
-- Safe to run against an empty faculty table (sync-roster has not run yet).

-- The ACF field holds ANY research profile (Scholar, ResearchGate, NCBI, ...), not just
-- Scholar — the old name implied a guarantee the data doesn't make. See §5a.3.
ALTER TABLE faculty RENAME COLUMN scholar_url TO research_profile_url;

-- No independent source. ResearchGate links live inside research_profile_url, the same
-- generic field as Scholar links. See §5a.3.
ALTER TABLE faculty DROP COLUMN researchgate_url;

-- §8b cannot send review emails without this. Omitted from the original plan.
ALTER TABLE faculty ADD COLUMN email TEXT;

-- Cosmetic segment of /review/{slug}/{token} (§8b). NOT a credential.
ALTER TABLE faculty ADD COLUMN slug TEXT;

-- e.g. "Faculty|Leadership" — pipe-separated, multi-valued. Metadata for the coverage
-- report only. NEVER used alone to decide roster membership — see the amended §9 rule.
ALTER TABLE faculty ADD COLUMN classification TEXT;

-- SQLite cannot drop a NOT NULL constraint with ALTER, so make `unit` nullable via a
-- full table rebuild. A person who maps to no canonical unit must be importable with a
-- NULL unit and reported — not dropped, and not assigned a guessed default (§15.11).
PRAGMA foreign_keys=OFF;

CREATE TABLE faculty_new (
  id                   INTEGER PRIMARY KEY,
  wp_id                TEXT UNIQUE,       -- WordPress post ID for this profile
  slug                 TEXT,              -- WP slug ("matt-stock") — cosmetic part of
                                          -- /review/{slug}/{token} (§8b). NOT a credential.
  display_name         TEXT NOT NULL,     -- "Zraick, R.I."  (citation form)
  full_name            TEXT,              -- "Richard I. Zraick"
  email                TEXT,              -- required by §8b review emails.
  unit                 TEXT,              -- ★ NULLABLE. A person may map to zero canonical
                                          -- units (e.g. Dean's Office-only staff) — that is
                                          -- a real state to report, not an error to paper
                                          -- over with a guessed default (§15.11).
  research_profile_url TEXT,              -- ★ RENAMED from scholar_url. The WordPress ACF
                                          -- field (`google_scholar`) is GENERIC — verified
                                          -- against the live directory to also hold
                                          -- ResearchGate profiles, an NCBI bibliography, and
                                          -- (once) a bare DOI entered in error. Do not assume
                                          -- this is a Scholar URL. See §5a.3.
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

INSERT INTO faculty_new (
  id, wp_id, slug, display_name, full_name, email, unit,
  research_profile_url, scholar_user_id, orcid, classification,
  active, last_alert_seen_at, last_synced_at
)
SELECT
  id, wp_id, slug, display_name, full_name, email, unit,
  research_profile_url, scholar_user_id, orcid, classification,
  active, last_alert_seen_at, last_synced_at
FROM faculty;

DROP TABLE faculty;

ALTER TABLE faculty_new RENAME TO faculty;

PRAGMA foreign_keys=ON;
