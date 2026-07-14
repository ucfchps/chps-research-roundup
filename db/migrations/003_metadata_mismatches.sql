-- Records where a stored, already-populated volume/pages disagrees with
-- Crossref's current record for that DOI (refresh-metadata, §9). Flag-only —
-- the job that populates this table never overwrites the publications row
-- itself; a human decides via the §8c Tab 4 pre-flight warnings.
-- One row per publication: a second run upserts rather than duplicating.
CREATE TABLE metadata_mismatches (
  id              INTEGER PRIMARY KEY,
  publication_id  INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  stored_volume   TEXT,
  crossref_volume TEXT,
  stored_pages    TEXT,
  crossref_pages  TEXT,
  detected_at     TEXT NOT NULL,
  UNIQUE(publication_id)
);
