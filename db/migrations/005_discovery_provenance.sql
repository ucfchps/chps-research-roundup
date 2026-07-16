-- Provenance for how a publication was first discovered via Scholar (§5a, §13
-- item 9). Provenance only — neither column is used to derive units, and
-- neither is ever rendered into a citation. discovered_by_faculty_id is
-- nullable because most publications are NOT Scholar-discovered (Crossref/
-- PubMed/ORCID/manual origin) and because a Scholar-discovered record whose
-- Crossref resolution failed still needs somewhere to point (see
-- needs_metadata handling in lib/scholar-ingest.ts).
ALTER TABLE publications ADD COLUMN discovered_by_faculty_id INTEGER REFERENCES faculty(id);
ALTER TABLE publications ADD COLUMN scholar_alert_url TEXT;
