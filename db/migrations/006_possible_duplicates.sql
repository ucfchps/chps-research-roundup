-- Records a possible-duplicate judgment call made at ingest time (§7), so it survives
-- past the run's console output. One row per (publication, candidate) pair. Written by
-- ingest-scholar whenever an outcome's possibleDuplicateOf is non-empty, on either the
-- insert_needs_metadata or insert_resolved path. Read by release-buffer (Session 10) to
-- hold a record out of promotion until a human resolves it. No admin UI reads/writes
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
