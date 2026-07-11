-- Faculty roster. Synced from the WordPress directory.
CREATE TABLE faculty (
  id                INTEGER PRIMARY KEY,
  wp_id             TEXT UNIQUE,          -- WordPress post ID for this profile
  display_name      TEXT NOT NULL,        -- "Zraick, R.I."  (citation form)
  full_name         TEXT,                 -- "Richard I. Zraick"
  unit              TEXT NOT NULL,        -- see UNITS below
  scholar_url       TEXT,                 -- raw URL as stored in the WP directory
  scholar_user_id   TEXT UNIQUE,          -- ★ THE JOIN KEY. Parsed from scholar_url.
                                          -- e.g. "hs_VC0kAAAAJ" from
                                          -- scholar.google.com/citations?hl=en&user=hs_VC0kAAAAJ
                                          -- Case-sensitive. See §5a.3 for normalization.
  researchgate_url  TEXT,
  orcid             TEXT,
  active            INTEGER DEFAULT 1,    -- still employed / still in directory
  last_alert_seen_at TEXT,                -- last time an alert arrived for this scholar_user_id.
                                          -- NULL + scholar_user_id present ⇒ alert likely not
                                          -- created yet. Drives the to-do list in §11.
  last_synced_at    TEXT
);

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
