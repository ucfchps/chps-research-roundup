-- §8b item 7: faculty can fix journal/volume/pages/title on their own reviewable
-- publications directly (no COMMS approval gate — they're the author), but the
-- change must be logged so COMMS can spot-check provenance. One row per field
-- changed per edit call.
CREATE TABLE citation_edits (
  id             INTEGER PRIMARY KEY,
  publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  faculty_id     INTEGER NOT NULL REFERENCES faculty(id),
  field          TEXT NOT NULL,      -- 'journal' | 'volume' | 'issue' | 'pages' | 'title'
  old_value      TEXT,
  new_value      TEXT,
  edited_at      TEXT NOT NULL
);
CREATE INDEX idx_citation_edits_publication ON citation_edits(publication_id);
