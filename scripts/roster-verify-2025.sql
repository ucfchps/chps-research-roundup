-- Session 21 (§13.24 operational backfill): verify every ground-truth-2025.json
-- faculty member actually exists in the PRODUCTION roster, and confirm the
-- five home-unit assignments Session 20 had to resolve from internal
-- evidence (no production access in that clean-room session). Run with NO
-- active=1 filter — a departed faculty member can still be the correct
-- author of a 2025 paper.
--
-- Read-only. Run via: turso db shell <db> < scripts/roster-verify-2025.sql
-- (or scripts/roster-verify-2025.ts, the equivalent run against this
-- project's own TURSO_DATABASE_URL/TURSO_AUTH_TOKEN when turso CLI login
-- isn't available).

-- 1. The five home-unit assignments Session 20 resolved without production
--    access — confirm each against the real roster.
SELECT display_name, unit, active FROM faculty WHERE display_name LIKE 'Anderson, A.W%';
SELECT display_name, unit, active FROM faculty WHERE display_name LIKE 'Anderson, K. M%';
SELECT display_name, unit, active FROM faculty WHERE display_name LIKE 'Brazendale%';
SELECT display_name, unit, active FROM faculty WHERE display_name LIKE 'Jeune%';
SELECT display_name, unit, active FROM faculty WHERE display_name LIKE 'Neely%';
SELECT display_name, unit, active FROM faculty WHERE display_name LIKE 'Yalim%';

-- 2. CARD staff gap — confirm Tayek now resolves, and surface anyone else
--    CARD-affiliated who might still be missing.
SELECT display_name, unit, active FROM faculty WHERE unit = 'Center for Autism and Related Disabilities';

-- 3. Every OTHER fixture faculty member — run per-name via the .ts
--    equivalent, which loops the full 48-entry list programmatically;
--    the pattern for any one of them by hand is:
-- SELECT display_name, unit, active FROM faculty WHERE display_name = '<fixture display_name>';
