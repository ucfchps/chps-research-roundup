-- Problem B (refresh-metadata, §9) originally compared only volume/pages.
-- Confirmed real case beyond the Lee et al. pages mismatch: Weerathunge et
-- al. (10.1044/2025_jslhr-24-00598) has a live-post issue number (8) that
-- disagrees with Crossref's actual issue (4) while volume/pages both match.
-- Same "flag, never overwrite" behavior — just one more field, same table.
ALTER TABLE metadata_mismatches ADD COLUMN stored_issue TEXT;
ALTER TABLE metadata_mismatches ADD COLUMN crossref_issue TEXT;
